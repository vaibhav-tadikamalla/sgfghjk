import { ClusterNode, type ClusterNodeConfig, type ClusterNodeSnapshot, type NodeEditorAssignment } from './ClusterNode';
import { buildScenario, computeEditorAssignments, type ScenarioAction, type ScenarioDefinition, type ScenarioId } from './ScenarioEngine';
import { FailureInjector, type FailureEvent, type FailureType } from './FailureInjector';
import { ChaosEngine, type ChaosConfig, type ChaosSnapshot } from './ChaosEngine';
import { ReplayEngine, type ReplayMode, type ReplaySnapshot, type ReplayTrace } from './ReplayEngine';
import { getLogger } from '../utils/logger';

export type ClusterSimulationState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface ClusterSimulationConfig {
  editorCount: number;
  targetRoom: string;
  scenario: ScenarioId;
  nodes: ClusterNodeConfig[];
  typingSpeed?: number;
  reconnectProbability?: number;
  spawnDelayMs?: number;
}

export interface ScenarioTimelineEntry {
  ts: number;
  message: string;
}

export interface ClusterSimulationSnapshot {
  state: ClusterSimulationState;
  config: ClusterSimulationConfig | null;
  startedAt: number | null;
  elapsedMs: number;
  scenario: {
    id: ScenarioId | null;
    name: string | null;
    description: string | null;
  };
  nodes: ClusterNodeSnapshot[];
  aggregate: {
    totalEditors: number;
    totalRooms: number;
    totalEdits: number;
    editsPerSecond: number;
    avgLatencyMs: number;
    replicationLagMs: number;
    crossNodeBroadcastsPerSecond: number;
  };
  nodeLoad: Array<{ nodeId: string; label: string; editors: number; health: string }>;
  roomsPerNode: Array<{ nodeId: string; label: string; rooms: number }>;
  timeline: ScenarioTimelineEntry[];
  failures: {
    active: FailureEvent[];
    history: FailureEvent[];
  };
}

export class ClusterSimulator {
  private _state: ClusterSimulationState = 'idle';
  private _config: ClusterSimulationConfig | null = null;
  private _startedAt: number | null = null;
  private _scenario: ScenarioDefinition | null = null;

  private nodes: ClusterNode[] = [];
  private failureInjector = new FailureInjector();
  private timeline: ScenarioTimelineEntry[] = [];

  private assignments = new Map<string, NodeEditorAssignment[]>();
  private scenarioTimers: ReturnType<typeof setTimeout>[] = [];
  private sampleInterval: ReturnType<typeof setInterval> | null = null;

  private _lastTotalEdits = 0;
  private _lastSampleAt = Date.now();
  private _editsPerSecond = 0;
  private _crossNodeBroadcastsPerSecond = 0;
  private _replicationLagMs = 0;

  private chaosEngine: ChaosEngine | null = null;
  private replayEngine = new ReplayEngine();

  private readonly log = getLogger().child({ component: 'ClusterSimulator' });

  get state(): ClusterSimulationState {
    return this._state;
  }

  async start(config: ClusterSimulationConfig): Promise<void> {
    if (this._state === 'running' || this._state === 'starting') {
      throw new Error('Cluster simulation already running — stop it first');
    }

    this._state = 'starting';
    this._config = config;
    this._startedAt = Date.now();
    this.timeline = [];
    this._lastTotalEdits = 0;
    this._lastSampleAt = Date.now();
    this._editsPerSecond = 0;
    this._crossNodeBroadcastsPerSecond = 0;
    this._replicationLagMs = 0;
    this.failureInjector.reset();

    this.nodes = config.nodes.map((node) => new ClusterNode(node));

    const nodeIds = this.nodes.map((n) => n.nodeId);
    this._scenario = buildScenario(config.scenario, nodeIds, config.targetRoom);

    this.assignments = computeEditorAssignments(
      this.nodes,
      config.editorCount,
      config.targetRoom,
      this._scenario.distribution,
    );

    await Promise.all(
      this.nodes.map(async (node) => {
        const assigned = this.assignments.get(node.nodeId) ?? [];
        await node.spawnEditors(assigned, {
          typingSpeed: config.typingSpeed,
          reconnectProbability: config.reconnectProbability,
          spawnDelayMs: config.spawnDelayMs,
          abortSignal: new AbortController().signal,
        });
      }),
    );

    for (const event of this._scenario.timeline) {
      const timer = setTimeout(() => this.executeScenarioAction(event.action, event.description), event.delayMs);
      this.scenarioTimers.push(timer);
    }

    this.sampleInterval = setInterval(() => this.sampleDerivedMetrics(), 2_000);

    // Create the chaos engine (controllable independently via startChaos/stopChaos)
    this.chaosEngine = new ChaosEngine(
      () => this.nodes,
      this.failureInjector,
      (nodeId) => this.executeConnectionStorm(nodeId),
      (msg) => this.pushTimeline(msg),
    );

    // Wire replay engine callbacks so replayed events drive real actions
    this.replayEngine.setCallbacks({
      onInjectFailure: (type, nodeId) => {
        // Map chaos types back to injector types
        const CHAOS_MAP: Record<string, FailureType> = {
          'node-crash': 'node-shutdown',
          'redis-delay': 'redis-delay',
          'network-partition': 'network-partition',
          'mirror-eviction': 'mirror-eviction',
          'connection-storm': 'network-partition',
        };
        const injectorType = CHAOS_MAP[type] ?? (type as FailureType);
        this.injectFailure(injectorType, nodeId);
      },
      onResolveNode: (nodeId) => {
        const nodeEvents = this.failureInjector.activeFailures.filter(e => e.targetNodeId === nodeId);
        for (const ev of nodeEvents) {
          this.resolveFailure(ev.id);
        }
      },
      onConnectionStorm: (nodeId) => this.executeConnectionStorm(nodeId),
    });

    this._state = 'running';
    this.pushTimeline(`Scenario started: ${this._scenario.name}`);

    this.log.info(
      {
        scenario: this._scenario.id,
        editorCount: config.editorCount,
        nodes: config.nodes.length,
      },
      'Cluster simulation started',
    );
  }

  async stop(): Promise<void> {
    if (this._state !== 'running' && this._state !== 'starting') {
      return;
    }

    this._state = 'stopping';
    for (const timer of this.scenarioTimers) {
      clearTimeout(timer);
    }
    this.scenarioTimers = [];

    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }

    for (const node of this.nodes) {
      node.stopAll();
      node.reset();
    }

    if (this.chaosEngine) {
      this.chaosEngine.reset();
      this.chaosEngine = null;
    }

    // Auto-stop recording if active
    if (this.replayEngine.state === 'recording') {
      this.replayEngine.stopRecording();
    }
    this.replayEngine.reset();

    this.failureInjector.reset();
    this._state = 'stopped';
    this.pushTimeline('Cluster simulation stopped');
  }

  injectFailure(type: FailureType, nodeId: string, durationMs?: number): { success: boolean; message: string } {
    const node = this.nodes.find((n) => n.nodeId === nodeId);
    if (!node) return { success: false, message: `Unknown node: ${nodeId}` };

    const result = this.failureInjector.inject(type, node, { durationMs });
    this.pushTimeline(result.event.description);

    // Record for replay
    if (result.success) {
      this.replayEngine.recordEvent({
        source: 'injector',
        kind: 'inject',
        failureType: type,
        targetNodeId: nodeId,
        description: result.event.description,
        meta: { eventId: result.event.id, durationMs },
      });
    }

    return {
      success: result.success,
      message: result.success ? result.event.description : (result.error ?? 'Failed to inject failure'),
    };
  }

  resolveFailure(eventId: string): { success: boolean; message: string } {
    const event = this.failureInjector.events.find((e) => e.id === eventId);
    if (!event) return { success: false, message: `Unknown failure event: ${eventId}` };

    const node = this.nodes.find((n) => n.nodeId === event.targetNodeId);
    if (!node) return { success: false, message: `Unknown node: ${event.targetNodeId}` };

    const ok = this.failureInjector.resolve(eventId, node);
    if (ok) {
      this.pushTimeline(`Failure resolved: ${event.description}`);

      // Record for replay
      this.replayEngine.recordEvent({
        source: 'injector',
        kind: 'recover',
        failureType: event.type,
        targetNodeId: event.targetNodeId,
        description: `Resolved: ${event.description}`,
        resolved: true,
        durationMs: event.resolvedAt ? event.resolvedAt - event.timestamp : null,
        meta: { eventId },
      });
    }

    return { success: ok, message: ok ? 'Failure resolved' : 'Failure already resolved' };
  }

  // ── Chaos Engineering ────────────────────────────────────────────────────

  configureChaos(config: Partial<ChaosConfig>): void {
    if (!this.chaosEngine) throw new Error('Cluster simulation not running');
    this.chaosEngine.configure(config);
  }

  startChaos(config?: Partial<ChaosConfig>): void {
    if (!this.chaosEngine) throw new Error('Cluster simulation not running — start it first');
    if (config) this.chaosEngine.configure(config);
    this.chaosEngine.start();
  }

  stopChaos(): void {
    if (!this.chaosEngine) return;
    this.chaosEngine.stop();
  }

  getChaosSnapshot(): ChaosSnapshot | null {
    return this.chaosEngine?.getSnapshot() ?? null;
  }

  // ── Replay Engine ────────────────────────────────────────────────────────

  startRecording(): void {
    if (this._state !== 'running') throw new Error('Cluster simulation must be running to record');
    this.replayEngine.startRecording(this._config as unknown as Record<string, unknown>);
  }

  stopRecording(): ReplayTrace | null {
    return this.replayEngine.stopRecording();
  }

  startReplay(traceId: string, mode?: ReplayMode): void {
    if (this._state !== 'running') throw new Error('Cluster simulation must be running to replay');
    this.replayEngine.startReplay(traceId, mode);
  }

  stopReplay(): void {
    this.replayEngine.stopReplay();
  }

  pauseReplay(): void {
    this.replayEngine.pauseReplay();
  }

  resumeReplay(): void {
    this.replayEngine.resumeReplay();
  }

  stepForward(): unknown {
    return this.replayEngine.stepForward();
  }

  getReplaySnapshot(): ReplaySnapshot {
    return this.replayEngine.getSnapshot();
  }

  getTraces(): ReplayTrace[] {
    return this.replayEngine.getTraces();
  }

  getTrace(traceId: string): ReplayTrace | null {
    return this.replayEngine.getTrace(traceId);
  }

  importTrace(trace: ReplayTrace): void {
    this.replayEngine.importTrace(trace);
  }

  getSnapshot(): ClusterSimulationSnapshot {
    const now = Date.now();
    const elapsedMs = this._startedAt ? now - this._startedAt : 0;
    const nodeSnaps = this.nodes.map((n) => n.getSnapshot());

    const totalEditors = nodeSnaps.reduce((sum, n) => sum + n.editors.total, 0);
    const totalEdits = nodeSnaps.reduce((sum, n) => sum + n.metrics.totalEdits, 0);
    const totalRooms = nodeSnaps.reduce((sum, n) => sum + Object.keys(n.rooms).length, 0);

    const avgLatencyMs = nodeSnaps.length > 0
      ? nodeSnaps.reduce((sum, n) => sum + n.metrics.avgLatencyMs, 0) / nodeSnaps.length
      : 0;

    return {
      state: this._state,
      config: this._config,
      startedAt: this._startedAt,
      elapsedMs,
      scenario: {
        id: this._scenario?.id ?? null,
        name: this._scenario?.name ?? null,
        description: this._scenario?.description ?? null,
      },
      nodes: nodeSnaps,
      aggregate: {
        totalEditors,
        totalRooms,
        totalEdits,
        editsPerSecond: this._editsPerSecond,
        avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
        replicationLagMs: this._replicationLagMs,
        crossNodeBroadcastsPerSecond: this._crossNodeBroadcastsPerSecond,
      },
      nodeLoad: nodeSnaps.map((n) => ({
        nodeId: n.nodeId,
        label: n.label,
        editors: n.editors.total - n.editors.stopped,
        health: n.health,
      })),
      roomsPerNode: nodeSnaps.map((n) => ({
        nodeId: n.nodeId,
        label: n.label,
        rooms: Object.keys(n.rooms).length,
      })),
      timeline: this.timeline.slice(-100),
      failures: {
        active: this.failureInjector.activeFailures,
        history: [...this.failureInjector.events].slice(-100),
      },
    };
  }

  private executeScenarioAction(action: ScenarioAction, description: string): void {
    this.pushTimeline(description);

    // Record scenario actions for replay
    this.replayEngine.recordEvent({
      source: 'scenario',
      kind: 'scenario-action',
      description,
      targetNodeId: 'nodeId' in action ? (action as { nodeId: string }).nodeId : null,
      meta: { actionType: action.type },
    });

    switch (action.type) {
      case 'kill-node': {
        const node = this.nodes.find((n) => n.nodeId === action.nodeId);
        if (node) node.kill();
        break;
      }
      case 'partition-node': {
        const node = this.nodes.find((n) => n.nodeId === action.nodeId);
        if (node) node.partition();
        break;
      }
      case 'restore-node': {
        const node = this.nodes.find((n) => n.nodeId === action.nodeId);
        if (node) node.restore();
        break;
      }
      case 'degrade-node': {
        const node = this.nodes.find((n) => n.nodeId === action.nodeId);
        if (node) node.degrade();
        break;
      }
      case 'evict-mirrors': {
        const node = this.nodes.find((n) => n.nodeId === action.nodeId);
        if (node) {
          this.failureInjector.inject('mirror-eviction', node);
        }
        break;
      }
      case 'reconnect-storm': {
        for (const nodeId of action.nodeIds) {
          const node = this.nodes.find((n) => n.nodeId === nodeId);
          if (!node) continue;
          const nodeAssignments = this.assignments.get(nodeId) ?? [];
          node.reset();
          void node.spawnEditors(nodeAssignments, {
            typingSpeed: this._config?.typingSpeed,
            reconnectProbability: Math.max(0.3, this._config?.reconnectProbability ?? 0.02),
            spawnDelayMs: Math.min(25, this._config?.spawnDelayMs ?? 50),
            abortSignal: new AbortController().signal,
          });
        }
        break;
      }
      case 'redistribute-editors': {
        const fromAssignments = this.assignments.get(action.fromNodeId) ?? [];
        if (fromAssignments.length === 0 || action.toNodeIds.length === 0) break;

        let idx = 0;
        for (const assignment of fromAssignments) {
          const targetNodeId = action.toNodeIds[idx % action.toNodeIds.length]!;
          const target = this.assignments.get(targetNodeId) ?? [];
          target.push(assignment);
          this.assignments.set(targetNodeId, target);
          idx++;
        }
        this.assignments.set(action.fromNodeId, []);

        const fromNode = this.nodes.find((n) => n.nodeId === action.fromNodeId);
        if (fromNode) fromNode.reset();

        for (const targetNodeId of action.toNodeIds) {
          const node = this.nodes.find((n) => n.nodeId === targetNodeId);
          if (!node) continue;
          node.reset();
          void node.spawnEditors(this.assignments.get(targetNodeId) ?? [], {
            typingSpeed: this._config?.typingSpeed,
            reconnectProbability: this._config?.reconnectProbability,
            spawnDelayMs: this._config?.spawnDelayMs,
            abortSignal: new AbortController().signal,
          });
        }
        break;
      }
      case 'log': {
        this.pushTimeline(action.message);
        break;
      }
    }
  }

  private async executeConnectionStorm(nodeId: string): Promise<void> {
    const node = this.nodes.find((n) => n.nodeId === nodeId);
    if (!node) return;

    const nodeAssignments = this.assignments.get(nodeId) ?? [];
    node.reset();
    await node.spawnEditors(nodeAssignments, {
      typingSpeed: this._config?.typingSpeed,
      reconnectProbability: Math.max(0.3, this._config?.reconnectProbability ?? 0.02),
      spawnDelayMs: Math.min(10, this._config?.spawnDelayMs ?? 50),
      abortSignal: new AbortController().signal,
    });
  }

  private sampleDerivedMetrics(): void {
    const snap = this.nodes.map((n) => n.getSnapshot());
    const totalEdits = snap.reduce((sum, n) => sum + n.metrics.totalEdits, 0);
    const now = Date.now();
    const elapsedSec = Math.max(0.001, (now - this._lastSampleAt) / 1000);

    this._editsPerSecond = Math.round(((totalEdits - this._lastTotalEdits) / elapsedSec) * 100) / 100;
    this._lastTotalEdits = totalEdits;
    this._lastSampleAt = now;

    const healthyNodes = snap.filter((n) => n.health === 'healthy').length;
    const degradedNodes = snap.filter((n) => n.health === 'degraded').length;
    const downOrPartitioned = snap.filter((n) => n.health === 'down' || n.health === 'partitioned').length;

    this._replicationLagMs = Math.max(0, Math.round(15 + degradedNodes * 40 + downOrPartitioned * 80));
    this._crossNodeBroadcastsPerSecond = Math.max(0, Math.round(this._editsPerSecond * Math.max(0, healthyNodes - 1) * 0.6 * 100) / 100);
  }

  private pushTimeline(message: string): void {
    this.timeline.push({ ts: Date.now(), message });
    if (this.timeline.length > 500) this.timeline = this.timeline.slice(-500);
  }
}

let _clusterSimulator: ClusterSimulator | null = null;

export function getClusterSimulator(): ClusterSimulator {
  if (!_clusterSimulator) {
    _clusterSimulator = new ClusterSimulator();
  }
  return _clusterSimulator;
}
