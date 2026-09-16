/**
 * simulator/ChaosEngine.ts
 *
 * Automated chaos engineering for cluster simulations.
 *
 * Randomly injects failures at configurable intervals, schedules
 * automatic recovery, and tracks resilience metrics (MTTR, availability,
 * resilience score).
 *
 * Supported failure types:
 *   - node-crash        — kills all editors on a node (via FailureInjector)
 *   - redis-delay       — simulates Redis latency    (via FailureInjector)
 *   - network-partition — isolates a node             (via FailureInjector)
 *   - mirror-eviction   — evicts mirrors, forces resync (via FailureInjector)
 *   - connection-storm  — mass disconnect + reconnect flood (direct callback)
 *
 * Integrates with the existing FailureInjector for the first four types
 * and uses a callback for connection-storm handling.
 *
 * Does NOT modify the collaboration engine.
 */

import type { ClusterNode } from './ClusterNode';
import type { FailureInjector, FailureType } from './FailureInjector';
import { getLogger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChaosFailureType =
  | 'node-crash'
  | 'redis-delay'
  | 'network-partition'
  | 'mirror-eviction'
  | 'connection-storm';

export interface ChaosConfig {
  enabled: boolean;
  intervalSeconds: number;
  maxConcurrentFailures: number;
  recoverySeconds: number;
}

export type ChaosState = 'idle' | 'running' | 'paused';

export interface ChaosEvent {
  id: string;
  timestamp: number;
  type: ChaosFailureType;
  targetNodeId: string;
  description: string;
  resolved: boolean;
  resolvedAt: number | null;
  scheduledRecoveryAt: number;
  injectorEventId: string | null;
}

export interface ChaosSnapshot {
  config: ChaosConfig;
  state: ChaosState;
  startedAt: number | null;
  elapsedMs: number;
  totalInjections: number;
  totalRecoveries: number;
  activeFailures: ChaosEvent[];
  timeline: ChaosEvent[];
  metrics: {
    meanTimeToRecoveryMs: number;
    availabilityPercent: number;
    resilienceScore: number;
    recoveryRate: number;
    failuresByType: Record<ChaosFailureType, number>;
    recoveredByType: Record<ChaosFailureType, number>;
    nodeFailureCounts: Array<{ nodeId: string; count: number }>;
  };
}

// ── Mapping chaos types → FailureInjector types ───────────────────────────────

const ALL_CHAOS_TYPES: ChaosFailureType[] = [
  'node-crash',
  'redis-delay',
  'network-partition',
  'mirror-eviction',
  'connection-storm',
];

const CHAOS_TO_INJECTOR: Partial<Record<ChaosFailureType, FailureType>> = {
  'node-crash': 'node-shutdown',
  'redis-delay': 'redis-delay',
  'network-partition': 'network-partition',
  'mirror-eviction': 'mirror-eviction',
};

// ── ChaosEngine ───────────────────────────────────────────────────────────────

/**
 * Automated chaos engine that runs alongside a cluster simulation.
 *
 * Created by ClusterSimulator when a cluster sim starts; destroyed when
 * the cluster sim stops. Controllable independently (start/stop/pause).
 */
export class ChaosEngine {
  private _config: ChaosConfig = {
    enabled: false,
    intervalSeconds: 60,
    maxConcurrentFailures: 2,
    recoverySeconds: 120,
  };

  private _state: ChaosState = 'idle';
  private _startedAt: number | null = null;
  private _events: ChaosEvent[] = [];
  private _eventCounter = 0;
  private _intervalTimer: ReturnType<typeof setInterval> | null = null;
  private _recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly log = getLogger().child({ component: 'ChaosEngine' });

  constructor(
    private getNodes: () => ClusterNode[],
    private failureInjector: FailureInjector,
    private onConnectionStorm: (nodeId: string) => Promise<void>,
    private pushTimelineEntry: (message: string) => void,
  ) {}

  get state(): ChaosState {
    return this._state;
  }

  // ── Configuration ───────────────────────────────────────────────────────

  configure(config: Partial<ChaosConfig>): void {
    const oldInterval = this._config.intervalSeconds;
    this._config = { ...this._config, ...config };

    // Restart the tick interval if it changed while running
    if (this._state === 'running' && config.intervalSeconds && config.intervalSeconds !== oldInterval) {
      this.stopInterval();
      this.startInterval();
    }

    this.log.info({ config: this._config }, 'Chaos config updated');
  }

  getConfig(): ChaosConfig {
    return { ...this._config };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this._state === 'running') return;

    this._config.enabled = true;
    this._state = 'running';
    this._startedAt = this._startedAt ?? Date.now();
    this.startInterval();
    this.pushTimelineEntry('[CHAOS] Chaos engine started');
    this.log.info({ config: this._config }, 'Chaos engine started');
  }

  stop(): void {
    if (this._state === 'idle') return;

    this._state = 'idle';
    this._config.enabled = false;
    this.stopInterval();
    this.cancelAllRecoveryTimers();
    this.pushTimelineEntry('[CHAOS] Chaos engine stopped');
    this.log.info('Chaos engine stopped');
  }

  pause(): void {
    if (this._state !== 'running') return;
    this._state = 'paused';
    this.stopInterval();
    this.pushTimelineEntry('[CHAOS] Chaos engine paused');
    this.log.info('Chaos engine paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this._state = 'running';
    this.startInterval();
    this.pushTimelineEntry('[CHAOS] Chaos engine resumed');
    this.log.info('Chaos engine resumed');
  }

  /** Full reset — clears all events and timers. */
  reset(): void {
    this.stopInterval();
    this.cancelAllRecoveryTimers();
    this._state = 'idle';
    this._config.enabled = false;
    this._events = [];
    this._eventCounter = 0;
    this._startedAt = null;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  getSnapshot(): ChaosSnapshot {
    const now = Date.now();
    const elapsedMs = this._startedAt ? now - this._startedAt : 0;

    const activeFailures = this._events.filter((e) => !e.resolved);
    const resolvedEvents = this._events.filter((e) => e.resolved && e.resolvedAt != null);

    // Mean Time To Recovery
    let mttr = 0;
    if (resolvedEvents.length > 0) {
      const totalRecoveryTime = resolvedEvents.reduce(
        (sum, e) => sum + (e.resolvedAt! - e.timestamp),
        0,
      );
      mttr = Math.round(totalRecoveryTime / resolvedEvents.length);
    }

    // Availability: percentage of aggregate node-time without failures
    const nodeCount = Math.max(1, this.getNodes().length);
    const totalNodeMs = nodeCount * Math.max(1, elapsedMs);
    let totalDownMs = 0;
    for (const event of this._events) {
      const end = event.resolved ? (event.resolvedAt ?? now) : now;
      totalDownMs += end - event.timestamp;
    }
    const availability =
      Math.round(Math.max(0, (1 - totalDownMs / totalNodeMs)) * 10000) / 100;

    // Recovery rate
    const recoveryRate =
      this._events.length > 0
        ? Math.round((resolvedEvents.length / this._events.length) * 10000) / 100
        : 100;

    // Resilience score (0–100): weighted composite
    //   40% availability  +  30% recovery rate  +  30% MTTR quality
    const mttrQuality =
      mttr > 0
        ? Math.max(0, 1 - mttr / (this._config.recoverySeconds * 2000))
        : 1;
    const resilienceScore = Math.round(
      (availability / 100) * 0.4 +
        (recoveryRate / 100) * 0.3 +
        mttrQuality * 0.3,
    ) * 100;

    // Failure counts by type
    const failuresByType = this.zeroCounts();
    const recoveredByType = this.zeroCounts();
    for (const e of this._events) {
      failuresByType[e.type]++;
      if (e.resolved) recoveredByType[e.type]++;
    }

    // Node failure counts
    const nodeCounts = new Map<string, number>();
    for (const e of this._events) {
      nodeCounts.set(e.targetNodeId, (nodeCounts.get(e.targetNodeId) ?? 0) + 1);
    }

    return {
      config: { ...this._config },
      state: this._state,
      startedAt: this._startedAt,
      elapsedMs,
      totalInjections: this._events.length,
      totalRecoveries: resolvedEvents.length,
      activeFailures,
      timeline: this._events.slice(-200),
      metrics: {
        meanTimeToRecoveryMs: mttr,
        availabilityPercent: availability,
        resilienceScore: Math.max(0, Math.min(100, resilienceScore)),
        recoveryRate,
        failuresByType,
        recoveredByType,
        nodeFailureCounts: [...nodeCounts.entries()]
          .map(([nodeId, count]) => ({ nodeId, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }

  // ── Internal: interval management ───────────────────────────────────────

  private startInterval(): void {
    this._intervalTimer = setInterval(
      () => void this.tick(),
      this._config.intervalSeconds * 1000,
    );
  }

  private stopInterval(): void {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
  }

  private cancelAllRecoveryTimers(): void {
    for (const timer of this._recoveryTimers.values()) clearTimeout(timer);
    this._recoveryTimers.clear();
  }

  // ── Internal: chaos tick ────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this._state !== 'running') return;

    const nodes = this.getNodes();
    if (nodes.length === 0) return;

    // Check concurrent failure limit
    const activeCount = this._events.filter((e) => !e.resolved).length;
    if (activeCount >= this._config.maxConcurrentFailures) {
      this.log.debug(
        { activeCount, max: this._config.maxConcurrentFailures },
        'Max concurrent chaos failures reached — skipping injection',
      );
      return;
    }

    // Pick random failure type
    const failureType =
      ALL_CHAOS_TYPES[Math.floor(Math.random() * ALL_CHAOS_TYPES.length)]!;

    // Pick random eligible node (prefer healthy nodes)
    const healthy = nodes.filter((n) => n.health === 'healthy');
    const eligible =
      healthy.length > 0
        ? healthy
        : nodes.filter((n) => n.health !== 'down');
    if (eligible.length === 0) {
      this.log.debug('No eligible nodes for chaos injection');
      return;
    }

    const target = eligible[Math.floor(Math.random() * eligible.length)]!;
    await this.injectChaosFailure(failureType, target);
  }

  // ── Internal: injection + recovery ──────────────────────────────────────

  private async injectChaosFailure(
    type: ChaosFailureType,
    node: ClusterNode,
  ): Promise<void> {
    const eventId = `chaos-${++this._eventCounter}`;
    const recoveryMs = this._config.recoverySeconds * 1000;

    let injectorEventId: string | null = null;
    let description: string;

    if (type === 'connection-storm') {
      description = `Connection storm on ${node.nodeId} — flooding reconnections`;
      try {
        await this.onConnectionStorm(node.nodeId);
      } catch (err) {
        this.log.error({ err, nodeId: node.nodeId }, 'Connection storm handler failed');
        return;
      }
    } else {
      const injectorType = CHAOS_TO_INJECTOR[type];
      if (!injectorType) return;

      const result = this.failureInjector.inject(injectorType, node);
      if (!result.success) {
        this.log.warn(
          { type, nodeId: node.nodeId, error: result.error },
          'Chaos injection via FailureInjector failed',
        );
        return;
      }
      injectorEventId = result.event.id;
      description = result.event.description;
    }

    const chaosEvent: ChaosEvent = {
      id: eventId,
      timestamp: Date.now(),
      type,
      targetNodeId: node.nodeId,
      description,
      resolved: false,
      resolvedAt: null,
      scheduledRecoveryAt: Date.now() + recoveryMs,
      injectorEventId,
    };

    this._events.push(chaosEvent);
    if (this._events.length > 500) this._events = this._events.slice(-500);

    this.pushTimelineEntry(`[CHAOS] ${description}`);
    this.log.warn(
      { eventId, type, nodeId: node.nodeId, recoveryInSec: this._config.recoverySeconds },
      'Chaos failure injected',
    );

    // Schedule automatic recovery
    const timer = setTimeout(() => {
      this._recoveryTimers.delete(eventId);
      void this.recoverFromChaos(chaosEvent, node);
    }, recoveryMs);
    this._recoveryTimers.set(eventId, timer);
  }

  private async recoverFromChaos(
    event: ChaosEvent,
    node: ClusterNode,
  ): Promise<void> {
    if (event.resolved) return;

    // Resolve via FailureInjector (restores node health)
    if (event.injectorEventId) {
      this.failureInjector.resolve(event.injectorEventId, node);
    }

    // Respawn editors for destructive failures
    if (event.type === 'node-crash' || event.type === 'network-partition') {
      try {
        await this.onConnectionStorm(event.targetNodeId);
      } catch (err) {
        this.log.error(
          { err, eventId: event.id },
          'Editor respawn during chaos recovery failed',
        );
      }
    }

    event.resolved = true;
    event.resolvedAt = Date.now();

    const durationMs = event.resolvedAt - event.timestamp;
    this.pushTimelineEntry(
      `[CHAOS] Recovered (${(durationMs / 1000).toFixed(1)}s): ${event.description}`,
    );
    this.log.info(
      { eventId: event.id, type: event.type, nodeId: event.targetNodeId, durationMs },
      'Chaos failure auto-recovered',
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private zeroCounts(): Record<ChaosFailureType, number> {
    return {
      'node-crash': 0,
      'redis-delay': 0,
      'network-partition': 0,
      'mirror-eviction': 0,
      'connection-storm': 0,
    };
  }
}
