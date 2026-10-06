/**
 * admin/benchmarkApi.ts
 *
 * Typed API client for all /admin/benchmark/* endpoints.
 * Follows the same pattern as the existing simulationApi in api.ts.
 */

import { apiUrl } from '@/lib/runtimeConfig';
import { tokenManager } from '@/lib/auth/tokenManager';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BenchmarkConfig {
  userCount: number;
  durationSeconds: number;
  warmupSeconds?: number;
  cooldownSeconds?: number;
  typingSpeed?: number;
  reconnectProbability?: number;
  spawnDelayMs?: number;
  targetUrl: string;
  targetRoom?: string;
  seed?: number;
  collectResourceMetrics?: boolean;
}

export type BenchmarkPhase =
  | 'idle'
  | 'warmup'
  | 'measurement'
  | 'cooldown'
  | 'convergence'
  | 'persisting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BenchmarkLiveStatus {
  runId: string | null;
  phase: BenchmarkPhase;
  config: BenchmarkConfig | null;
  startedAt: number | null;
  phaseStartedAt: number | null;
  elapsedMs: number;
  phaseElapsedMs: number;
  activeEditors: number;
  samplesCollected: number;
  liveP50Ms: number;
  liveP95Ms: number;
  editsPerSecond: number;
  error: string | null;
}

export interface LatencyStats {
  sampleCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
}

export interface BenchmarkResults {
  measurementDurationMs: number;
  latency: LatencyStats;
  opsAttempted: number;
  opsPropagated: number;
  opsTimedOut: number;
  opsErrored: number;
  successRate: number;
  errorRate: number;
  propagatedOpsPerSec: number;
  attemptedOpsPerSec: number;
  connectionAttempts: number;
  connectionSuccesses: number;
  connectionFailures: number;
  convergenceAchieved: boolean;
  convergenceTimeMs: number | null;
  convergenceFingerprints: string[];
  processMemoryAtStartBytes: number | null;
  processMemoryPeakBytes: number | null;
  processCpuUserMsTotal: number | null;
  processCpuSystemMsTotal: number | null;
  eventLoopLagBaselineMs: number | null;
  eventLoopLagPeakMs: number | null;
}

export interface BenchmarkRun {
  id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  target_url: string;
  environment: Record<string, unknown>;
  config: BenchmarkConfig;
  results: BenchmarkResults | null;
  error_message: string | null;
}

export interface BenchmarkRunsResponse {
  total: number;
  limit: number;
  offset: number;
  runs: BenchmarkRun[];
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

const BENCH_BASE = apiUrl('/admin/benchmark');

async function benchFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = await tokenManager.getValidToken();
  const { headers: optionHeaders, ...restOpts } = opts ?? {};
  const res = await fetch(`${BENCH_BASE}${path}`, {
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
    throw new Error(`Benchmark API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

// ── API object ─────────────────────────────────────────────────────────────────

export const benchmarkApi = {
  start: (config: BenchmarkConfig) =>
    benchFetch<{ status: string; runId: string; message: string }>('/run', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  cancel: () =>
    benchFetch<{ status: string; message: string }>('/cancel', { method: 'POST' }),

  getStatus: () =>
    benchFetch<BenchmarkLiveStatus>('/status'),

  getRuns: (params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return benchFetch<BenchmarkRunsResponse>(`/runs${query}`);
  },

  getRun: (id: string) =>
    benchFetch<BenchmarkRun>(`/runs/${encodeURIComponent(id)}`),

  deleteRun: (id: string) =>
    benchFetch<{ status: string; id: string }>(`/runs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  startMatrix: (params: {
    userMatrix?: number[];
    typingSpeedMatrix?: number[];
    durationSeconds?: number;
    warmupSeconds?: number;
    cooldownSeconds?: number;
    targetUrl?: string;
  }) =>
    benchFetch<{ status: string; totalRuns: number; runIds: string[]; message: string }>('/matrix', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  getExportUrl: (id: string, format: 'json' | 'csv') =>
    `${BENCH_BASE}/runs/${encodeURIComponent(id)}/export.${format}`,
};
