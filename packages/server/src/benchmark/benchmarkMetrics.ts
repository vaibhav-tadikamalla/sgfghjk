/**
 * benchmark/benchmarkMetrics.ts
 *
 * Prometheus metrics specific to the benchmark system.
 * Registered on the shared PeerGrid registry.
 *
 * IMPORTANT: No high-cardinality labels. No room IDs, user IDs,
 * or operation IDs are used as label values.
 */

import { Histogram, Counter, Gauge } from 'prom-client';
import { register } from '../metrics/metrics';

// ── Edit propagation latency ──────────────────────────────────────────────────

/**
 * The primary benchmark metric.
 *
 * Measures: time from Y.Doc.transact() on sender to Y.applyUpdate() on receiver.
 * Buckets chosen for collaborative editing context (5ms to 5s range).
 */
export const benchmarkPropagationLatency = new Histogram({
  name: 'peergrid_benchmark_propagation_latency_ms',
  help: 'Collaborative edit propagation latency: t1 (sender pre-transact) to t2 (receiver post-applyUpdate) in ms',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  labelNames: ['phase'], // 'warmup' | 'measurement' | 'cooldown'
  registers: [register],
});

// ── Benchmark run lifecycle ────────────────────────────────────────────────────

export const benchmarkRunsTotal = new Counter({
  name: 'peergrid_benchmark_runs_total',
  help: 'Total number of benchmark runs by final status',
  labelNames: ['status'], // 'completed' | 'failed' | 'cancelled'
  registers: [register],
});

// ── Active benchmark users ─────────────────────────────────────────────────────

export const benchmarkActiveUsers = new Gauge({
  name: 'peergrid_benchmark_active_users',
  help: 'Number of simulated users participating in the current benchmark run',
  registers: [register],
});

// ── Operation counters ─────────────────────────────────────────────────────────

export const benchmarkOpsAttemptedTotal = new Counter({
  name: 'peergrid_benchmark_ops_attempted_total',
  help: 'Total edit operations attempted by benchmark simulated senders',
  registers: [register],
});

export const benchmarkOpsPropagatedTotal = new Counter({
  name: 'peergrid_benchmark_ops_propagated_total',
  help: 'Total edit operations successfully received and applied by a peer simulated client',
  registers: [register],
});
