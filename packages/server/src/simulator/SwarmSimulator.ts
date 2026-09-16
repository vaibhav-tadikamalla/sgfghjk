/**
 * simulator/SwarmSimulator.ts
 *
 * Orchestrates a swarm of SimulatedEditor instances for load testing.
 *
 * Architecture:
 *   - All editors run as concurrent async tasks in the Node.js event loop
 *   - Each editor gets its own Y.Doc, WebSocket connection, and edit loop
 *   - The swarm tracks aggregate metrics across all editors
 *   - AbortController provides clean shutdown — all editors stop immediately
 *   - Configurable editor counts: 10, 50, 100, 500, 1000
 *
 * The simulator is completely decoupled from the collaboration engine.
 * All interaction happens via the standard WebSocket protocol.
 */

import { randomUUID } from 'node:crypto';
import { SimulatedEditor, type SimulatedEditorMetrics, type EditorState } from './SimulatedEditor';
import { generateAccessToken } from '../auth/jwt';
import { getLogger } from '../utils/logger';
import {
  simEditorsGauge,
  simEditsCounter,
  simConnectionFailuresCounter,
  simAvgLatencyGauge,
} from './simulatorMetrics';

export type SimulationState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface SimulationConfig {
  /** Number of simulated editors to spawn. */
  editorCount: number;
  /** Target room/file ID. */
  targetRoom: string;
  /** Server WebSocket URL. Defaults to ws://localhost:{PORT}/ws */
  wsUrl?: string;
  /** Average typing speed in chars/second (default: 5). */
  typingSpeed?: number;
  /** Probability of reconnect per cycle (0–1, default: 0.02). */
  reconnectProbability?: number;
  /** Stagger start: delay between spawning editors in ms (default: 50). */
  spawnDelayMs?: number;
}

export interface SimulationSnapshot {
  state: SimulationState;
  config: SimulationConfig | null;
  startedAt: number | null;
  elapsedMs: number;
  editors: {
    total: number;
    connecting: number;
    authenticating: number;
    syncing: number;
    editing: number;
    idle: number;
    reconnecting: number;
    stopped: number;
  };
  metrics: {
    totalEditsGenerated: number;
    totalAwarenessUpdates: number;
    totalReconnects: number;
    totalConnectionFailures: number;
    editsPerSecond: number;
    averageLatencyMs: number;
  };
  /** Per-editor metrics (truncated to first 50 for API response size). */
  editorDetails: SimulatedEditorMetrics[];
}

const STATE_KEYS: EditorState[] = [
  'connecting', 'authenticating', 'syncing', 'editing', 'idle', 'reconnecting', 'stopped',
];

export class SwarmSimulator {
  private editors: SimulatedEditor[] = [];
  private abortController: AbortController | null = null;
  private _state: SimulationState = 'idle';
  private _config: SimulationConfig | null = null;
  private _startedAt: number | null = null;
  private _lastEditCount = 0;
  private _lastEditCountTime = 0;
  private _editsPerSecond = 0;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;
  private readonly log = getLogger().child({ component: 'SwarmSimulator' });

  get state(): SimulationState { return this._state; }

  // ── Start / Stop ──────────────────────────────────────────────────────────

  async start(config: SimulationConfig): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') {
      throw new Error('Simulation already running — stop it first');
    }

    this._state = 'starting';
    this._config = config;
    this._startedAt = Date.now();
    this._lastEditCount = 0;
    this._lastEditCountTime = Date.now();
    this._editsPerSecond = 0;
    this.abortController = new AbortController();
    this.editors = [];

    const wsUrl = config.wsUrl ?? `ws://localhost:${process.env['PORT'] ?? '3001'}/ws`;
    const spawnDelay = config.spawnDelayMs ?? 50;

    this.log.info(
      { editorCount: config.editorCount, targetRoom: config.targetRoom, wsUrl },
      'Starting editor swarm simulation',
    );

    // Spawn editors with staggered start
    for (let i = 0; i < config.editorCount; i++) {
      if (this.abortController.signal.aborted) break;

      const editorId = `sim-editor-${i + 1}-${randomUUID().slice(0, 8)}`;
      const userId = `sim-user-${randomUUID()}`;

      // Generate a real JWT for each simulated editor
      let accessToken: string;
      try {
        const result = await generateAccessToken({
          id: userId,
          email: `${editorId}@sim.peergrid.local`,
          displayName: `Sim Editor ${i + 1}`,
        });
        accessToken = result.token;
      } catch (err) {
        this.log.error({ err, editorId }, 'Failed to generate JWT for simulated editor');
        continue;
      }

      const editor = new SimulatedEditor({
        editorId,
        displayName: `Sim Editor ${i + 1}`,
        accessToken,
        fileId: config.targetRoom,
        wsUrl,
        typingSpeed: config.typingSpeed ?? 5,
        reconnectProbability: config.reconnectProbability ?? 0.02,
        abortSignal: this.abortController.signal,
      });

      this.editors.push(editor);

      // Start the editor (non-blocking)
      editor.start().catch((err) => {
        this.log.error({ err, editorId }, 'Simulated editor failed to start');
      });

      // Stagger spawns to avoid thundering herd
      if (spawnDelay > 0 && i < config.editorCount - 1) {
        await new Promise(resolve => setTimeout(resolve, spawnDelay));
        if (this.abortController.signal.aborted) break;
      }
    }

    this._state = 'running';

    // Start metrics sampling interval
    this.metricsInterval = setInterval(() => this.updatePrometheusMetrics(), 2_000);

    this.log.info(
      { editorsSpawned: this.editors.length },
      'Editor swarm simulation started',
    );
  }

  async stop(): Promise<void> {
    if (this._state !== 'running' && this._state !== 'starting') {
      return;
    }

    this._state = 'stopping';
    this.log.info('Stopping editor swarm simulation…');

    // Signal all editors to stop
    this.abortController?.abort();

    // Stop each editor
    for (const editor of this.editors) {
      editor.stop();
    }

    // Clear metrics interval
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    // Reset Prometheus gauges
    simEditorsGauge.set(0);
    simAvgLatencyGauge.set(0);

    this._state = 'stopped';
    this.log.info(
      { totalEditors: this.editors.length },
      'Editor swarm simulation stopped',
    );
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  getSnapshot(): SimulationSnapshot {
    const editorMetrics = this.editors.map(e => e.getMetrics());

    // Count editors by state
    const stateCounts: Record<EditorState, number> = {
      connecting: 0,
      authenticating: 0,
      syncing: 0,
      editing: 0,
      idle: 0,
      reconnecting: 0,
      stopped: 0,
    };
    for (const m of editorMetrics) {
      stateCounts[m.state]++;
    }

    // Aggregate metrics
    let totalEdits = 0;
    let totalAwareness = 0;
    let totalReconnects = 0;
    let totalFailures = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const m of editorMetrics) {
      totalEdits += m.editsGenerated;
      totalAwareness += m.awarenessUpdates;
      totalReconnects += m.reconnects;
      totalFailures += m.connectionFailures;
      if (m.latencyMs > 0) {
        latencySum += m.latencyMs;
        latencyCount++;
      }
    }

    const now = Date.now();
    const elapsedMs = this._startedAt ? now - this._startedAt : 0;

    return {
      state: this._state,
      config: this._config,
      startedAt: this._startedAt,
      elapsedMs,
      editors: {
        total: this.editors.length,
        ...stateCounts,
      },
      metrics: {
        totalEditsGenerated: totalEdits,
        totalAwarenessUpdates: totalAwareness,
        totalReconnects,
        totalConnectionFailures: totalFailures,
        editsPerSecond: this._editsPerSecond,
        averageLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount * 100) / 100 : 0,
      },
      // Truncate per-editor details for API response
      editorDetails: editorMetrics.slice(0, 50),
    };
  }

  // ── Prometheus metrics ────────────────────────────────────────────────────

  private updatePrometheusMetrics(): void {
    const snap = this.getSnapshot();

    // Active editors gauge
    simEditorsGauge.set(snap.editors.total - snap.editors.stopped);

    // Edits total (counter should always go up)
    const delta = snap.metrics.totalEditsGenerated - (simEditsCounter as any)._value;
    if (delta > 0) {
      simEditsCounter.inc(delta);
    }

    // Connection failures
    const failDelta = snap.metrics.totalConnectionFailures - (simConnectionFailuresCounter as any)._value;
    if (failDelta > 0) {
      simConnectionFailuresCounter.inc(failDelta);
    }

    // Average latency gauge
    simAvgLatencyGauge.set(snap.metrics.averageLatencyMs);

    // Calculate edits/sec
    const now = Date.now();
    const elapsed = (now - this._lastEditCountTime) / 1000;
    if (elapsed > 0) {
      this._editsPerSecond = Math.round(
        ((snap.metrics.totalEditsGenerated - this._lastEditCount) / elapsed) * 100
      ) / 100;
      this._lastEditCount = snap.metrics.totalEditsGenerated;
      this._lastEditCountTime = now;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: SwarmSimulator | null = null;

export function getSwarmSimulator(): SwarmSimulator {
  if (!_instance) {
    _instance = new SwarmSimulator();
  }
  return _instance;
}
