/**
 * simulator/ClusterNode.ts
 *
 * Represents a single PeerGrid node in a multi-node cluster simulation.
 *
 * Each ClusterNode:
 *   - Tracks a host:port endpoint (e.g. localhost:3000)
 *   - Manages a pool of SimulatedEditors assigned to this node
 *   - Collects per-node health/metrics (editors, edits, latency, failures)
 *   - Can be "killed" or "partitioned" for failure simulation
 *   - Exposes a snapshot for the cluster-level aggregator
 *
 * The node does NOT embed a real PeerGrid server — it controls editors
 * that connect to the real server at the configured endpoint via WebSocket.
 */

import { randomUUID } from 'node:crypto';
import { SimulatedEditor, type SimulatedEditorMetrics, type EditorState } from './SimulatedEditor';
import { generateAccessToken } from '../auth/jwt';
import { getLogger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type NodeHealth = 'healthy' | 'degraded' | 'partitioned' | 'down';

export interface ClusterNodeConfig {
  /** Unique node identifier (e.g. "node-A"). */
  nodeId: string;
  /** WebSocket URL for this node (e.g. ws://localhost:3000/ws). */
  wsUrl: string;
  /** Human-readable label. */
  label: string;
}

export interface NodeEditorAssignment {
  editorId: string;
  fileId: string;
  displayName: string;
}

export interface ClusterNodeSnapshot {
  nodeId: string;
  label: string;
  wsUrl: string;
  health: NodeHealth;
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
    totalEdits: number;
    totalAwareness: number;
    totalReconnects: number;
    totalFailures: number;
    editsPerSecond: number;
    avgLatencyMs: number;
  };
  /** Rooms active on this node and their editor counts. */
  rooms: Record<string, number>;
  editorDetails: SimulatedEditorMetrics[];
}

const STATE_KEYS: EditorState[] = [
  'connecting', 'authenticating', 'syncing', 'editing', 'idle', 'reconnecting', 'stopped',
];

// ── ClusterNode implementation ────────────────────────────────────────────────

export class ClusterNode {
  readonly nodeId: string;
  readonly label: string;
  readonly wsUrl: string;

  private _health: NodeHealth = 'healthy';
  private editors: SimulatedEditor[] = [];
  private editorFileMap = new Map<string, string>(); // editorId → fileId
  private abortController: AbortController | null = null;
  private _lastEditCount = 0;
  private _lastEditCountTime = Date.now();
  private _editsPerSecond = 0;
  private readonly log = getLogger().child({ component: 'ClusterNode' });

  constructor(config: ClusterNodeConfig) {
    this.nodeId = config.nodeId;
    this.label = config.label;
    this.wsUrl = config.wsUrl;
  }

  get health(): NodeHealth { return this._health; }
  get editorCount(): number { return this.editors.length; }

  // ── Editor lifecycle ────────────────────────────────────────────────────

  /**
   * Spawn a batch of editors on this node — each gets a real JWT and
   * connects to the node's WebSocket endpoint.
   */
  async spawnEditors(
    assignments: NodeEditorAssignment[],
    opts: {
      typingSpeed?: number;
      reconnectProbability?: number;
      spawnDelayMs?: number;
      abortSignal: AbortSignal;
    },
  ): Promise<void> {
    this.abortController = new AbortController();

    // Link the external abort signal to our local one
    const externalAbort = opts.abortSignal;
    const onExternalAbort = () => this.abortController?.abort();
    externalAbort.addEventListener('abort', onExternalAbort, { once: true });

    const spawnDelay = opts.spawnDelayMs ?? 50;

    for (const assignment of assignments) {
      if (this.abortController.signal.aborted || externalAbort.aborted) break;
      if (this._health === 'down' || this._health === 'partitioned') break;

      const userId = `sim-user-${randomUUID()}`;
      let accessToken: string;
      try {
        const result = await generateAccessToken({
          id: userId,
          email: `${assignment.editorId}@sim.peergrid.local`,
          displayName: assignment.displayName,
        });
        accessToken = result.token;
      } catch (err) {
        this.log.error({ err, editorId: assignment.editorId }, 'JWT generation failed');
        continue;
      }

      const editor = new SimulatedEditor({
        editorId: assignment.editorId,
        displayName: assignment.displayName,
        accessToken,
        fileId: assignment.fileId,
        wsUrl: this.wsUrl,
        typingSpeed: opts.typingSpeed ?? 5,
        reconnectProbability: opts.reconnectProbability ?? 0.02,
        abortSignal: this.abortController.signal,
      });

      this.editors.push(editor);
      this.editorFileMap.set(assignment.editorId, assignment.fileId);

      editor.start().catch((err) => {
        this.log.error({ err, editorId: assignment.editorId, nodeId: this.nodeId }, 'Editor start failed');
      });

      if (spawnDelay > 0) {
        await new Promise(r => setTimeout(r, spawnDelay));
      }
    }
  }

  /** Stop all editors on this node. */
  stopAll(): void {
    this.abortController?.abort();
    for (const editor of this.editors) {
      editor.stop();
    }
  }

  /** Clear all editors and reset state. */
  reset(): void {
    this.stopAll();
    this.editors = [];
    this.editorFileMap.clear();
    this._health = 'healthy';
    this._lastEditCount = 0;
    this._lastEditCountTime = Date.now();
    this._editsPerSecond = 0;
  }

  // ── Failure injection ───────────────────────────────────────────────────

  /** Simulate a node crash — kills all editors and marks node as down. */
  kill(): void {
    this.log.warn({ nodeId: this.nodeId }, 'Node killed — simulating crash');
    this._health = 'down';
    this.stopAll();
  }

  /** Simulate a network partition — editors stay alive but won't reconnect. */
  partition(): void {
    this.log.warn({ nodeId: this.nodeId }, 'Node partitioned — simulating network partition');
    this._health = 'partitioned';
    this.stopAll();
  }

  /** Restore this node to healthy status (doesn't re-spawn editors). */
  restore(): void {
    this.log.info({ nodeId: this.nodeId }, 'Node restored to healthy');
    this._health = 'healthy';
  }

  /** Mark node as degraded (editors continue but note the degradation). */
  degrade(): void {
    this._health = 'degraded';
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  getSnapshot(): ClusterNodeSnapshot {
    const editorMetrics = this.editors.map(e => e.getMetrics());

    // State counts
    const stateCounts: Record<EditorState, number> = {
      connecting: 0, authenticating: 0, syncing: 0,
      editing: 0, idle: 0, reconnecting: 0, stopped: 0,
    };
    for (const m of editorMetrics) stateCounts[m.state]++;

    // Aggregate metrics
    let totalEdits = 0, totalAwareness = 0, totalReconnects = 0, totalFailures = 0;
    let latencySum = 0, latencyCount = 0;
    for (const m of editorMetrics) {
      totalEdits += m.editsGenerated;
      totalAwareness += m.awarenessUpdates;
      totalReconnects += m.reconnects;
      totalFailures += m.connectionFailures;
      if (m.latencyMs > 0) { latencySum += m.latencyMs; latencyCount++; }
    }

    // Room distribution
    const rooms: Record<string, number> = {};
    for (const [editorId, fileId] of this.editorFileMap) {
      rooms[fileId] = (rooms[fileId] ?? 0) + 1;
    }

    // Edits/sec
    const now = Date.now();
    const elapsed = (now - this._lastEditCountTime) / 1000;
    if (elapsed > 0) {
      this._editsPerSecond = Math.round(((totalEdits - this._lastEditCount) / elapsed) * 100) / 100;
      this._lastEditCount = totalEdits;
      this._lastEditCountTime = now;
    }

    return {
      nodeId: this.nodeId,
      label: this.label,
      wsUrl: this.wsUrl,
      health: this._health,
      editors: { total: this.editors.length, ...stateCounts },
      metrics: {
        totalEdits,
        totalAwareness,
        totalReconnects,
        totalFailures,
        editsPerSecond: this._editsPerSecond,
        avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount * 100) / 100 : 0,
      },
      rooms,
      editorDetails: editorMetrics.slice(0, 20),
    };
  }
}
