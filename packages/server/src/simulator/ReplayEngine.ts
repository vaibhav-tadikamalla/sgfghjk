/**
 * simulator/ReplayEngine.ts
 *
 * Deterministic replay engine for chaos engineering traces.
 *
 * Records every injected failure and scenario event from ChaosEngine and
 * FailureInjector into a structured trace. Traces can be exported as JSON
 * and replayed with identical timing to reproduce the exact failure sequence.
 *
 * Replay modes:
 *   - continuous  — replays the full trace using original timing offsets
 *   - step        — pauses before each event; advance with stepForward()
 *
 * Recording happens automatically when attached to a running
 * ClusterSimulator. The ReplayEngine observes events via its
 * recordEvent() method, called by the ChaosEngine and FailureInjector
 * integration hooks in ClusterSimulator.
 *
 * Constraints:
 *   - Does NOT modify the collaboration engine.
 *   - Integrates with existing ChaosEngine and FailureInjector.
 */

import type { ChaosFailureType } from './ChaosEngine';
import type { FailureType } from './FailureInjector';
import { getLogger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplayEventSource = 'chaos' | 'injector' | 'scenario' | 'manual';

export type ReplayEventKind = 'inject' | 'recover' | 'scenario-action' | 'log';

export interface ReplayTraceEvent {
  /** Monotonic sequence number within the trace. */
  seq: number;
  /** Offset in ms from trace start (t=0). */
  offsetMs: number;
  /** Original wall-clock timestamp when the event was recorded. */
  timestamp: number;
  /** Where this event originated. */
  source: ReplayEventSource;
  /** What kind of event. */
  kind: ReplayEventKind;
  /** Failure type (for inject/recover events). */
  failureType: ChaosFailureType | FailureType | null;
  /** Target node for the event. */
  targetNodeId: string | null;
  /** Human-readable description. */
  description: string;
  /** Whether the event was a recovery. */
  resolved: boolean;
  /** Duration from inject to recovery, if resolved. */
  durationMs: number | null;
  /** Extra metadata (scenario action details, injector event IDs, etc.). */
  meta: Record<string, unknown>;
}

export interface ReplayTrace {
  /** Unique trace identifier. */
  traceId: string;
  /** When recording started. */
  recordedAt: number;
  /** Total recording duration. */
  durationMs: number;
  /** Cluster simulation config that was active during recording. */
  simulationConfig: Record<string, unknown> | null;
  /** Ordered list of events. */
  events: ReplayTraceEvent[];
  /** Summary statistics. */
  summary: {
    totalEvents: number;
    totalInjections: number;
    totalRecoveries: number;
    eventsBySource: Record<ReplayEventSource, number>;
    failureTypeDistribution: Record<string, number>;
    nodeDistribution: Record<string, number>;
  };
}

export type ReplayState = 'idle' | 'recording' | 'replaying' | 'stepping' | 'paused' | 'completed';
export type ReplayMode = 'continuous' | 'step';

export interface ReplaySnapshot {
  state: ReplayState;
  mode: ReplayMode;
  traceId: string | null;
  traceEventCount: number;
  currentEventIndex: number;
  elapsedMs: number;
  totalDurationMs: number;
  progress: number;
  currentEvent: ReplayTraceEvent | null;
  nextEvent: ReplayTraceEvent | null;
  executedEvents: ReplayTraceEvent[];
  pendingEvents: number;
  replayLog: ReplayLogEntry[];
}

export interface ReplayLogEntry {
  ts: number;
  message: string;
  eventSeq: number | null;
}

// ── ReplayEngine ──────────────────────────────────────────────────────────────

export class ReplayEngine {
  private _state: ReplayState = 'idle';
  private _mode: ReplayMode = 'continuous';
  private _traceId: string | null = null;

  // ── Recording ──
  private _recordingStartedAt: number | null = null;
  private _recordedEvents: ReplayTraceEvent[] = [];
  private _seqCounter = 0;
  private _simulationConfig: Record<string, unknown> | null = null;

  // ── Replay ──
  private _replayTrace: ReplayTrace | null = null;
  private _replayStartedAt: number | null = null;
  private _currentIndex = 0;
  private _executedEvents: ReplayTraceEvent[] = [];
  private _replayTimers: ReturnType<typeof setTimeout>[] = [];
  private _replayLog: ReplayLogEntry[] = [];

  // ── Stored traces ──
  private _traces: ReplayTrace[] = [];

  // ── Callbacks set by ClusterSimulator ──
  private _onInjectFailure:
    | ((type: FailureType | ChaosFailureType, nodeId: string) => void)
    | null = null;
  private _onResolveNode: ((nodeId: string) => void) | null = null;
  private _onConnectionStorm: ((nodeId: string) => Promise<void>) | null = null;

  private readonly log = getLogger().child({ component: 'ReplayEngine' });

  get state(): ReplayState {
    return this._state;
  }

  // ── Callback registration ───────────────────────────────────────────────

  setCallbacks(callbacks: {
    onInjectFailure: (type: FailureType | ChaosFailureType, nodeId: string) => void;
    onResolveNode: (nodeId: string) => void;
    onConnectionStorm: (nodeId: string) => Promise<void>;
  }): void {
    this._onInjectFailure = callbacks.onInjectFailure;
    this._onResolveNode = callbacks.onResolveNode;
    this._onConnectionStorm = callbacks.onConnectionStorm;
  }

  // ── Recording ───────────────────────────────────────────────────────────

  startRecording(simulationConfig?: Record<string, unknown>): void {
    if (this._state === 'recording') return;
    if (this._state === 'replaying' || this._state === 'stepping') {
      throw new Error('Cannot record while replaying');
    }

    this._state = 'recording';
    this._traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._recordingStartedAt = Date.now();
    this._recordedEvents = [];
    this._seqCounter = 0;
    this._simulationConfig = simulationConfig ?? null;

    this.pushLog('Recording started', null);
    this.log.info({ traceId: this._traceId }, 'Replay recording started');
  }

  stopRecording(): ReplayTrace | null {
    if (this._state !== 'recording') return null;

    const now = Date.now();
    const durationMs = this._recordingStartedAt ? now - this._recordingStartedAt : 0;

    const trace = this.buildTrace(durationMs);
    this._traces.push(trace);
    if (this._traces.length > 20) this._traces = this._traces.slice(-20);

    this._state = 'idle';
    this.pushLog(`Recording stopped — ${trace.events.length} events captured`, null);
    this.log.info(
      { traceId: trace.traceId, events: trace.events.length, durationMs },
      'Replay recording stopped',
    );

    return trace;
  }

  /**
   * Record an event during an active recording session.
   * Called by ClusterSimulator hooks.
   */
  recordEvent(params: {
    source: ReplayEventSource;
    kind: ReplayEventKind;
    failureType?: ChaosFailureType | FailureType | null;
    targetNodeId?: string | null;
    description: string;
    resolved?: boolean;
    durationMs?: number | null;
    meta?: Record<string, unknown>;
  }): void {
    if (this._state !== 'recording') return;

    const now = Date.now();
    const offsetMs = this._recordingStartedAt ? now - this._recordingStartedAt : 0;

    const event: ReplayTraceEvent = {
      seq: ++this._seqCounter,
      offsetMs,
      timestamp: now,
      source: params.source,
      kind: params.kind,
      failureType: params.failureType ?? null,
      targetNodeId: params.targetNodeId ?? null,
      description: params.description,
      resolved: params.resolved ?? false,
      durationMs: params.durationMs ?? null,
      meta: params.meta ?? {},
    };

    this._recordedEvents.push(event);
    if (this._recordedEvents.length > 2000) {
      this._recordedEvents = this._recordedEvents.slice(-2000);
    }
  }

  // ── Trace management ────────────────────────────────────────────────────

  getTraces(): ReplayTrace[] {
    return this._traces;
  }

  getTrace(traceId: string): ReplayTrace | null {
    return this._traces.find((t) => t.traceId === traceId) ?? null;
  }

  importTrace(trace: ReplayTrace): void {
    // Validate basic structure
    if (!trace.traceId || !Array.isArray(trace.events)) {
      throw new Error('Invalid trace format');
    }
    this._traces.push(trace);
    if (this._traces.length > 20) this._traces = this._traces.slice(-20);
    this.log.info({ traceId: trace.traceId, events: trace.events.length }, 'Trace imported');
  }

  // ── Replay lifecycle ────────────────────────────────────────────────────

  startReplay(traceId: string, mode: ReplayMode = 'continuous'): void {
    if (this._state === 'replaying' || this._state === 'stepping') {
      throw new Error('Already replaying — stop current replay first');
    }
    if (this._state === 'recording') {
      throw new Error('Cannot replay while recording');
    }

    const trace = this._traces.find((t) => t.traceId === traceId);
    if (!trace) throw new Error(`Trace not found: ${traceId}`);
    if (trace.events.length === 0) throw new Error('Trace has no events to replay');

    this._replayTrace = trace;
    this._traceId = traceId;
    this._mode = mode;
    this._replayStartedAt = Date.now();
    this._currentIndex = 0;
    this._executedEvents = [];
    this._replayLog = [];

    this.pushLog(`Replay started (${mode} mode) — ${trace.events.length} events`, null);
    this.log.info(
      { traceId, mode, events: trace.events.length },
      'Replay started',
    );

    if (mode === 'continuous') {
      this._state = 'replaying';
      this.scheduleContinuousReplay();
    } else {
      this._state = 'stepping';
      this.pushLog(`Step mode: ready at event 1/${trace.events.length}`, 1);
    }
  }

  stopReplay(): void {
    if (
      this._state !== 'replaying' &&
      this._state !== 'stepping' &&
      this._state !== 'paused' &&
      this._state !== 'completed'
    ) {
      return;
    }

    this.clearReplayTimers();
    this._state = 'idle';
    this._replayTrace = null;
    this._traceId = null;
    this.pushLog('Replay stopped', null);
    this.log.info('Replay stopped');
  }

  pauseReplay(): void {
    if (this._state !== 'replaying') return;
    this.clearReplayTimers();
    this._state = 'paused';
    this.pushLog(`Replay paused at event ${this._currentIndex}/${this._replayTrace?.events.length ?? 0}`, null);
  }

  resumeReplay(): void {
    if (this._state !== 'paused') return;
    this._state = 'replaying';
    this.scheduleContinuousReplay();
    this.pushLog('Replay resumed', null);
  }

  /**
   * Step forward one event (step mode only, or while paused).
   */
  stepForward(): ReplayTraceEvent | null {
    if (this._state !== 'stepping' && this._state !== 'paused') return null;
    if (!this._replayTrace) return null;

    if (this._currentIndex >= this._replayTrace.events.length) {
      this._state = 'completed';
      this.pushLog('Replay complete — all events executed', null);
      return null;
    }

    const event = this._replayTrace.events[this._currentIndex]!;
    this.executeReplayEvent(event);
    this._currentIndex++;

    if (this._currentIndex >= this._replayTrace.events.length) {
      this._state = 'completed';
      this.pushLog('Replay complete — all events executed', null);
    }

    return event;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  getSnapshot(): ReplaySnapshot {
    const now = Date.now();
    const traceLength = this._replayTrace?.events.length ?? this._recordedEvents.length;
    const totalDuration = this._replayTrace?.durationMs ?? (this._recordingStartedAt ? now - this._recordingStartedAt : 0);
    const elapsed = this._replayStartedAt
      ? now - this._replayStartedAt
      : this._recordingStartedAt
        ? now - this._recordingStartedAt
        : 0;

    const progress =
      traceLength > 0
        ? Math.round((this._currentIndex / traceLength) * 10000) / 100
        : 0;

    return {
      state: this._state,
      mode: this._mode,
      traceId: this._traceId,
      traceEventCount: traceLength,
      currentEventIndex: this._currentIndex,
      elapsedMs: elapsed,
      totalDurationMs: totalDuration,
      progress,
      currentEvent:
        this._replayTrace && this._currentIndex < this._replayTrace.events.length
          ? this._replayTrace.events[this._currentIndex]!
          : null,
      nextEvent:
        this._replayTrace && this._currentIndex + 1 < this._replayTrace.events.length
          ? this._replayTrace.events[this._currentIndex + 1]!
          : null,
      executedEvents: this._executedEvents.slice(-50),
      pendingEvents: Math.max(0, traceLength - this._currentIndex),
      replayLog: this._replayLog.slice(-100),
    };
  }

  /** Full reset. */
  reset(): void {
    this.clearReplayTimers();
    this._state = 'idle';
    this._traceId = null;
    this._recordingStartedAt = null;
    this._recordedEvents = [];
    this._seqCounter = 0;
    this._simulationConfig = null;
    this._replayTrace = null;
    this._replayStartedAt = null;
    this._currentIndex = 0;
    this._executedEvents = [];
    this._replayLog = [];
  }

  // ── Internal: continuous replay scheduling ──────────────────────────────

  private scheduleContinuousReplay(): void {
    if (this._state !== 'replaying' || !this._replayTrace) return;

    const events = this._replayTrace.events;
    const replayStart = this._replayStartedAt ?? Date.now();

    for (let i = this._currentIndex; i < events.length; i++) {
      const event = events[i]!;
      // Schedule relative to replay start using original offset
      const fireAt = event.offsetMs - (Date.now() - replayStart);
      const delay = Math.max(0, fireAt);

      const timer = setTimeout(() => {
        if (this._state !== 'replaying') return;
        this.executeReplayEvent(event);
        this._currentIndex = i + 1;

        if (this._currentIndex >= events.length) {
          this._state = 'completed';
          this.pushLog('Replay complete — all events executed', null);
          this.log.info({ traceId: this._traceId }, 'Replay completed');
        }
      }, delay);

      this._replayTimers.push(timer);
    }
  }

  private executeReplayEvent(event: ReplayTraceEvent): void {
    this._executedEvents.push(event);
    if (this._executedEvents.length > 500) {
      this._executedEvents = this._executedEvents.slice(-500);
    }

    this.pushLog(`[REPLAY] ${event.description}`, event.seq);
    this.log.info(
      { seq: event.seq, kind: event.kind, source: event.source, nodeId: event.targetNodeId },
      'Replay event executed',
    );

    // Actually perform the action via callbacks
    if (!event.targetNodeId) return;

    try {
      switch (event.kind) {
        case 'inject':
          if (event.failureType && this._onInjectFailure) {
            this._onInjectFailure(event.failureType, event.targetNodeId);
          }
          break;
        case 'recover':
          if (this._onResolveNode) {
            this._onResolveNode(event.targetNodeId);
          }
          break;
        case 'scenario-action':
          // Connection storms are special
          if (
            event.failureType === 'connection-storm' &&
            this._onConnectionStorm
          ) {
            void this._onConnectionStorm(event.targetNodeId);
          } else if (event.failureType && this._onInjectFailure) {
            this._onInjectFailure(event.failureType, event.targetNodeId);
          }
          break;
        case 'log':
          // No side-effect for log events
          break;
      }
    } catch (err) {
      this.log.error(
        { err, seq: event.seq },
        'Error executing replay event',
      );
      this.pushLog(`[REPLAY ERROR] ${event.description}: ${err}`, event.seq);
    }
  }

  private clearReplayTimers(): void {
    for (const t of this._replayTimers) clearTimeout(t);
    this._replayTimers = [];
  }

  // ── Internal: build trace ───────────────────────────────────────────────

  private buildTrace(durationMs: number): ReplayTrace {
    const eventsBySource: Record<ReplayEventSource, number> = {
      chaos: 0,
      injector: 0,
      scenario: 0,
      manual: 0,
    };

    const failureTypeDistribution: Record<string, number> = {};
    const nodeDistribution: Record<string, number> = {};
    let totalInjections = 0;
    let totalRecoveries = 0;

    for (const event of this._recordedEvents) {
      eventsBySource[event.source]++;

      if (event.failureType) {
        failureTypeDistribution[event.failureType] =
          (failureTypeDistribution[event.failureType] ?? 0) + 1;
      }

      if (event.targetNodeId) {
        nodeDistribution[event.targetNodeId] =
          (nodeDistribution[event.targetNodeId] ?? 0) + 1;
      }

      if (event.kind === 'inject') totalInjections++;
      if (event.kind === 'recover' || event.resolved) totalRecoveries++;
    }

    return {
      traceId: this._traceId!,
      recordedAt: this._recordingStartedAt!,
      durationMs,
      simulationConfig: this._simulationConfig,
      events: [...this._recordedEvents],
      summary: {
        totalEvents: this._recordedEvents.length,
        totalInjections,
        totalRecoveries,
        eventsBySource,
        failureTypeDistribution,
        nodeDistribution,
      },
    };
  }

  // ── Internal: log ───────────────────────────────────────────────────────

  private pushLog(message: string, eventSeq: number | null): void {
    this._replayLog.push({ ts: Date.now(), message, eventSeq });
    if (this._replayLog.length > 500) {
      this._replayLog = this._replayLog.slice(-500);
    }
  }
}
