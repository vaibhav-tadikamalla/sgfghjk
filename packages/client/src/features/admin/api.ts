/**
 * Admin Dashboard API client — fetches data from /admin/dashboard/* endpoints.
 * Uses native fetch (no auth needed in dev mode).
 */

import { apiUrl } from '@/lib/runtimeConfig';
import { tokenManager } from '@/lib/auth/tokenManager';

export interface SystemMetrics {
  activeUsers: number;
  activeEditors: number;
  activeViewers: number;
  totalRooms: number;
  websocketConnections: number;
  editsPerMinute: number;
  uptimeSeconds: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
}

export interface RoomInfo {
  roomId: string;
  state: string;
  editors: number;
  viewers: number;
  connections: number;
  mirrors: boolean;
  updatesApplied: number;
  updatesBroadcast: number;
  ownerNode: string | null;
  lastActivityTimestamp: number;
  dirty: boolean;
  estimatedSizeBytes: number;
  // Added by /rooms endpoint
  idleSinceMs?: number;
  isIdle?: boolean;
}

export interface UserInfo {
  userId: string;
  displayName: string | undefined;
  email: string | undefined;
  activeConnections: number;
  currentFileId: string | undefined;
  role: string | undefined;
  sessionDurationMs: number;
  lastActivityTimestamp: number;
}

export interface ClusterInfo {
  mode: string;
  nodeId: string | null;
  activeNodes: string[];
  ownedRooms: string[];
}

export interface DashboardSummary {
  system: SystemMetrics;
  rooms: RoomInfo[];
  users: UserInfo[];
  cluster: ClusterInfo;
  retrievedAt: number;
}

export interface HealthInfo {
  cluster: ClusterInfo;
  totalRooms: number;
  mirrorReplicas: number;
  mirrorRoomIds: string[];
  dirtyRooms: number;
  ownerNodeDistribution: Record<string, number>;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  uptimeSeconds: number;
  retrievedAt: number;
}

export interface AnalyticsInfo {
  editsPerMinute: number;
  activeEditors: number;
  activeViewers: number;
  activeUsers: number;
  totalRooms: number;
  websocketConnections: number;
  pasteEventsPerSession: Array<{
    sessionId: string;
    fileId: string;
    fileName: string;
    userId: string;
    displayName: string;
    email: string;
    pasteEventsCount: number;
    editsCount: number;
    startedAt: string;
    endedAt: string | null;
  }>;
  avgEditsPerMinuteByUserFile: Array<{
    fileId: string;
    fileName: string;
    userId: string;
    displayName: string;
    email: string;
    totalEdits: number;
    totalMinutes: number;
    avgEditsPerMinute: number;
    sessions: number;
  }>;
  roomRates: Array<{
    roomId: string;
    updatesApplied: number;
    updatesBroadcast: number;
    editors: number;
    connections: number;
  }>;
  retrievedAt: number;
}

export interface ActivitySample {
  ts: number;
  editsPerMinute: number;
  connections: number;
  activeRooms: number;
  editors: number;
  viewers: number;
}

export interface ActivityHistoryResponse {
  sampleIntervalMs: number;
  maxSamples: number;
  samples: ActivitySample[];
  retrievedAt: number;
}

export interface TopologyNode {
  nodeId: string;
  ownedRooms: number;
  mirrorReplicas: number;
  connections: number;
  totalUpdatesApplied: number;
  roomIds: string[];
}

export interface TopologyResponse {
  mode: string;
  localNodeId: string | null;
  totalRooms: number;
  totalConnections: number;
  nodes: TopologyNode[];
  retrievedAt: number;
}

/* ── Simulation types ── */

export interface SimulatedEditorMetrics {
  editorId: string;
  state: string;
  editsGenerated: number;
  awarenessUpdates: number;
  reconnects: number;
  connectionFailures: number;
  lastEditTimestamp: number;
  latencyMs: number;
}

export interface SimulationSnapshot {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  config: {
    editorCount: number;
    targetRoom: string;
    wsUrl?: string;
    typingSpeed?: number;
    reconnectProbability?: number;
    spawnDelayMs?: number;
  } | null;
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
  editorDetails: SimulatedEditorMetrics[];
}

export interface StartSimulationParams {
  editorCount: number;
  targetRoom: string;
  typingSpeed?: number;
  reconnectProbability?: number;
  spawnDelayMs?: number;
}

export type ClusterScenarioId = 'balanced' | 'hotspot' | 'node-crash' | 'mirror-resync' | 'reconnect-storm';
export type ClusterFailureType = 'node-shutdown' | 'redis-delay' | 'network-partition' | 'mirror-eviction';

export interface ClusterNodeConfig {
  nodeId: string;
  label: string;
  wsUrl: string;
}

export interface ClusterNodeSnapshot {
  nodeId: string;
  label: string;
  wsUrl: string;
  health: 'healthy' | 'degraded' | 'partitioned' | 'down';
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
  rooms: Record<string, number>;
}

export interface ClusterFailureEvent {
  id: string;
  timestamp: number;
  type: ClusterFailureType;
  targetNodeId: string;
  description: string;
  resolved: boolean;
  resolvedAt: number | null;
}

export interface ClusterSimulationSnapshot {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  config: {
    editorCount: number;
    targetRoom: string;
    scenario: ClusterScenarioId;
    nodes: ClusterNodeConfig[];
    typingSpeed?: number;
    reconnectProbability?: number;
    spawnDelayMs?: number;
  } | null;
  startedAt: number | null;
  elapsedMs: number;
  scenario: {
    id: ClusterScenarioId | null;
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
  timeline: Array<{ ts: number; message: string }>;
  failures: {
    active: ClusterFailureEvent[];
    history: ClusterFailureEvent[];
  };
}

export interface StartClusterSimulationParams {
  editorCount: number;
  targetRoom: string;
  scenario: ClusterScenarioId;
  nodes: ClusterNodeConfig[];
  typingSpeed?: number;
  reconnectProbability?: number;
  spawnDelayMs?: number;
}

/* ── Chaos Engineering types ── */

export type ChaosFailureType =
  | 'node-crash'
  | 'redis-delay'
  | 'network-partition'
  | 'mirror-eviction'
  | 'connection-storm';

export type ChaosState = 'idle' | 'running' | 'paused';

export interface ChaosConfig {
  enabled: boolean;
  intervalSeconds: number;
  maxConcurrentFailures: number;
  recoverySeconds: number;
}

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

/* ── Deterministic Replay types ── */

export type ReplayEventSource = 'chaos' | 'injector' | 'scenario' | 'manual';
export type ReplayEventKind = 'inject' | 'recover' | 'scenario-action' | 'log';
export type ReplayState = 'idle' | 'recording' | 'replaying' | 'stepping' | 'paused' | 'completed';
export type ReplayMode = 'continuous' | 'step';

export interface ReplayTraceEvent {
  seq: number;
  offsetMs: number;
  timestamp: number;
  source: ReplayEventSource;
  kind: ReplayEventKind;
  failureType?: string;
  targetNodeId?: string;
  description: string;
  resolved?: boolean;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface ReplayTrace {
  traceId: string;
  recordedAt: number;
  durationMs: number;
  simulationConfig?: Record<string, unknown>;
  events: ReplayTraceEvent[];
  summary: {
    totalEvents: number;
    totalInjections: number;
    totalRecoveries: number;
    eventsBySource: Record<string, number>;
    failureTypeDistribution: Record<string, number>;
    nodeDistribution: Record<string, number>;
  };
}

export interface ReplayLogEntry {
  timestamp: number;
  message: string;
  eventSeq?: number;
}

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

/* ── Fetch helpers ── */

const BASE = apiUrl('/admin/dashboard');
const SIM_BASE = apiUrl('/admin/simulation');

async function fetchJson<T>(path: string): Promise<T> {
  const token = await tokenManager.getValidToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Accept': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Dashboard API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function simFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = await tokenManager.getValidToken();
  const { headers: optionHeaders, ...restOpts } = opts ?? {};
  const res = await fetch(`${SIM_BASE}${path}`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(optionHeaders ?? {}),
    },
    ...restOpts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Simulation API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

export const dashboardApi = {
  getSummary: () => fetchJson<DashboardSummary>('/summary'),
  getRooms: () => fetchJson<{ totalRooms: number; rooms: RoomInfo[]; mostEdited: RoomInfo[]; mostEditors: RoomInfo[]; idleRooms: RoomInfo[]; retrievedAt: number }>('/rooms'),
  getUsers: () => fetchJson<{ totalUsers: number; users: UserInfo[]; retrievedAt: number }>('/users'),
  getHealth: () => fetchJson<HealthInfo>('/health'),
  getAnalytics: () => fetchJson<AnalyticsInfo>('/analytics'),
  getActivityHistory: () => fetchJson<ActivityHistoryResponse>('/activity-history'),
  getTopology: () => fetchJson<TopologyResponse>('/topology'),
};

export const simulationApi = {
  start: (params: StartSimulationParams) =>
    simFetch<{ status: string; editorCount: number; targetRoom: string }>('/start', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  stop: () =>
    simFetch<{ status: string }>('/stop', { method: 'POST' }),
  getStatus: () =>
    simFetch<SimulationSnapshot>('/status'),
  startCluster: (params: StartClusterSimulationParams) =>
    simFetch<{ status: string; mode: 'cluster'; scenario: ClusterScenarioId; editorCount: number; nodes: number }>('/cluster/start', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  stopCluster: () =>
    simFetch<{ status: string; mode: 'cluster' }>('/cluster/stop', { method: 'POST' }),
  getClusterStatus: () =>
    simFetch<ClusterSimulationSnapshot>('/cluster/status'),
  injectClusterFailure: (params: { type: ClusterFailureType; nodeId: string; durationMs?: number }) =>
    simFetch<{ status: string; success: boolean; message: string }>('/cluster/failure/inject', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  resolveClusterFailure: (eventId: string) =>
    simFetch<{ status: string; success: boolean; message: string }>('/cluster/failure/resolve', {
      method: 'POST',
      body: JSON.stringify({ eventId }),
    }),

  // Chaos Engineering
  getChaosStatus: () =>
    simFetch<ChaosSnapshot>('/chaos/status'),
  startChaos: (config?: Partial<ChaosConfig>) =>
    simFetch<{ status: string; message: string }>('/chaos/start', {
      method: 'POST',
      body: JSON.stringify(config ?? {}),
    }),
  stopChaos: () =>
    simFetch<{ status: string; message: string }>('/chaos/stop', { method: 'POST' }),
  configureChaos: (config: Partial<ChaosConfig>) =>
    simFetch<{ status: string; message: string }>('/chaos/configure', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  // Deterministic Replay
  getReplayStatus: () =>
    simFetch<ReplaySnapshot>('/replay/status'),
  startRecording: () =>
    simFetch<{ status: string; message: string }>('/replay/record/start', { method: 'POST' }),
  stopRecording: () =>
    simFetch<{ status: string; trace: ReplayTrace | null }>('/replay/record/stop', { method: 'POST' }),
  getTraces: () =>
    simFetch<{ traces: ReplayTrace[] }>('/replay/traces'),
  getTrace: (traceId: string) =>
    simFetch<{ trace: ReplayTrace }>(`/replay/traces/${encodeURIComponent(traceId)}`),
  importTrace: (trace: ReplayTrace) =>
    simFetch<{ status: string; message: string }>('/replay/import', {
      method: 'POST',
      body: JSON.stringify({ trace }),
    }),
  startReplay: (traceId: string, mode: ReplayMode = 'continuous') =>
    simFetch<{ status: string; message: string }>('/replay/start', {
      method: 'POST',
      body: JSON.stringify({ traceId, mode }),
    }),
  stopReplay: () =>
    simFetch<{ status: string; message: string }>('/replay/stop', { method: 'POST' }),
  pauseReplay: () =>
    simFetch<{ status: string; message: string }>('/replay/pause', { method: 'POST' }),
  resumeReplay: () =>
    simFetch<{ status: string; message: string }>('/replay/resume', { method: 'POST' }),
  stepForward: () =>
    simFetch<{ status: string; event: ReplayTraceEvent | null }>('/replay/step', { method: 'POST' }),
};
