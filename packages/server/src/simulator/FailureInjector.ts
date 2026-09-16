/**
 * simulator/FailureInjector.ts
 *
 * Provides controlled failure injection for cluster simulation.
 *
 * Supported failure modes:
 *   - node-shutdown  — kills all editors on a node, marks it as down
 *   - redis-delay    — simulates Redis latency by pausing editor activity
 *   - network-partition — isolates a node from the cluster
 *   - mirror-eviction  — forces mirror replicas to be evicted, triggering resync
 *
 * Each injection is logged in an event timeline for dashboard display.
 * All failures are reversible (restore/heal).
 */

import type { ClusterNode } from './ClusterNode';
import { getLogger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FailureType =
  | 'node-shutdown'
  | 'redis-delay'
  | 'network-partition'
  | 'mirror-eviction';

export interface FailureEvent {
  id: string;
  timestamp: number;
  type: FailureType;
  targetNodeId: string;
  description: string;
  resolved: boolean;
  resolvedAt: number | null;
}

export interface FailureInjectionResult {
  success: boolean;
  event: FailureEvent;
  error?: string;
}

// ── FailureInjector ───────────────────────────────────────────────────────────

export class FailureInjector {
  private _events: FailureEvent[] = [];
  private _activeDelays = new Map<string, ReturnType<typeof setTimeout>>();
  private _eventCounter = 0;
  private readonly log = getLogger().child({ component: 'FailureInjector' });

  get events(): readonly FailureEvent[] { return this._events; }

  get activeFailures(): FailureEvent[] {
    return this._events.filter(e => !e.resolved);
  }

  // ── Inject failures ─────────────────────────────────────────────────────

  /**
   * Inject a failure on a specific node.
   */
  inject(
    type: FailureType,
    targetNode: ClusterNode,
    opts?: { durationMs?: number },
  ): FailureInjectionResult {
    const eventId = `failure-${++this._eventCounter}`;

    try {
      switch (type) {
        case 'node-shutdown':
          this.injectNodeShutdown(targetNode);
          break;
        case 'redis-delay':
          this.injectRedisDelay(targetNode, opts?.durationMs ?? 10_000);
          break;
        case 'network-partition':
          this.injectNetworkPartition(targetNode);
          break;
        case 'mirror-eviction':
          this.injectMirrorEviction(targetNode);
          break;
      }

      const event: FailureEvent = {
        id: eventId,
        timestamp: Date.now(),
        type,
        targetNodeId: targetNode.nodeId,
        description: this.describeFailure(type, targetNode.nodeId),
        resolved: false,
        resolvedAt: null,
      };

      this._events.push(event);
      this.log.warn({ eventId, type, nodeId: targetNode.nodeId }, 'Failure injected');

      // Auto-resolve after duration if specified and type supports it
      if (opts?.durationMs && (type === 'redis-delay' || type === 'network-partition')) {
        const timer = setTimeout(() => {
          this.resolve(eventId, targetNode);
          this._activeDelays.delete(eventId);
        }, opts.durationMs);
        this._activeDelays.set(eventId, timer);
      }

      return { success: true, event };
    } catch (err) {
      const event: FailureEvent = {
        id: eventId,
        timestamp: Date.now(),
        type,
        targetNodeId: targetNode.nodeId,
        description: `FAILED: ${this.describeFailure(type, targetNode.nodeId)}`,
        resolved: true,
        resolvedAt: Date.now(),
      };
      this._events.push(event);
      return {
        success: false,
        event,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Resolve (heal) a specific failure event.
   */
  resolve(eventId: string, targetNode: ClusterNode): boolean {
    const event = this._events.find(e => e.id === eventId);
    if (!event || event.resolved) return false;

    // Undo the failure effect
    switch (event.type) {
      case 'node-shutdown':
      case 'network-partition':
        targetNode.restore();
        break;
      case 'redis-delay':
        targetNode.restore();
        break;
      case 'mirror-eviction':
        targetNode.restore();
        break;
    }

    event.resolved = true;
    event.resolvedAt = Date.now();
    this.log.info({ eventId, type: event.type, nodeId: event.targetNodeId }, 'Failure resolved');
    return true;
  }

  /**
   * Resolve all active failures on a specific node.
   */
  resolveAllForNode(nodeId: string, targetNode: ClusterNode): number {
    let resolved = 0;
    for (const event of this._events) {
      if (event.targetNodeId === nodeId && !event.resolved) {
        this.resolve(event.id, targetNode);
        resolved++;
      }
    }
    return resolved;
  }

  /** Clear all events and cancel pending timers. */
  reset(): void {
    for (const timer of this._activeDelays.values()) {
      clearTimeout(timer);
    }
    this._activeDelays.clear();
    this._events = [];
    this._eventCounter = 0;
  }

  // ── Private implementation ──────────────────────────────────────────────

  private injectNodeShutdown(node: ClusterNode): void {
    node.kill();
  }

  private injectNetworkPartition(node: ClusterNode): void {
    node.partition();
  }

  private injectRedisDelay(node: ClusterNode, durationMs: number): void {
    // Simulate Redis delay by degrading the node — editors keep running
    // but the "degraded" flag signals to the dashboard that latency is elevated
    node.degrade();
    // Editors on a degraded node will experience higher latency from the server
    // side (if the server's Redis is actually slowed) — in simulation mode we
    // just mark the state and let dashboard show it.
  }

  private injectMirrorEviction(node: ClusterNode): void {
    // Evicting mirrors means the node's edge replicas are wiped.
    // We simulate this by degrading the node and killing its editors so
    // they need to resync from scratch.
    node.degrade();
    node.stopAll();
  }

  private describeFailure(type: FailureType, nodeId: string): string {
    switch (type) {
      case 'node-shutdown':
        return `Node ${nodeId} shut down — all connections killed`;
      case 'redis-delay':
        return `Redis latency injected on node ${nodeId}`;
      case 'network-partition':
        return `Network partition — node ${nodeId} isolated from cluster`;
      case 'mirror-eviction':
        return `Mirror replicas evicted from node ${nodeId} — resync required`;
    }
  }
}
