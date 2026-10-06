/**
 * benchmark/BenchmarkStats.ts
 *
 * Pure statistics functions for benchmark result computation.
 *
 * Percentile method: linear interpolation between adjacent sorted values.
 * This matches the method used by most engineering benchmarking tools (NumPy,
 * Prometheus histogram quantiles, HDR Histogram).
 *
 * All functions are side-effect-free and fully testable.
 */

export interface LatencyStats {
  /** Number of measured propagation events. */
  sampleCount: number;
  /** Minimum latency in ms. */
  minMs: number;
  /** Maximum latency in ms. */
  maxMs: number;
  /** Arithmetic mean in ms. */
  meanMs: number;
  /** 50th percentile (median) in ms. */
  p50Ms: number;
  /** 90th percentile in ms. */
  p90Ms: number;
  /** 95th percentile in ms. */
  p95Ms: number;
  /** 99th percentile in ms. */
  p99Ms: number;
  /** Standard deviation in ms. */
  stddevMs: number;
}

export interface BenchmarkResults {
  /** Wall-clock duration of the measurement phase (ms). */
  measurementDurationMs: number;

  // ── Latency ────────────────────────────────────────────────────────────────
  latency: LatencyStats;

  // ── Operations ─────────────────────────────────────────────────────────────
  /** Total edit operations attempted by all simulated senders. */
  opsAttempted: number;
  /** Operations successfully propagated (received + applied by a peer). */
  opsPropagated: number;
  /** Operations that timed out waiting for peer receipt. */
  opsTimedOut: number;
  /** Operations that resulted in an error. */
  opsErrored: number;
  /** opsPropagated / opsAttempted. */
  successRate: number;
  /** 1 - successRate. */
  errorRate: number;

  // ── Throughput ─────────────────────────────────────────────────────────────
  /**
   * Collaborative edit operations successfully propagated per second.
   * Denominator = measurementDurationMs / 1000.
   *
   * NOTE: This is collaborative propagation throughput, NOT raw messages/sec.
   */
  propagatedOpsPerSec: number;
  /** Raw edit operations attempted per second. */
  attemptedOpsPerSec: number;

  // ── Connection ─────────────────────────────────────────────────────────────
  connectionAttempts: number;
  connectionSuccesses: number;
  connectionFailures: number;

  // ── Convergence ────────────────────────────────────────────────────────────
  /**
   * Whether all simulated clients' Y.Doc states hashed to the same value
   * after the cooldown period.
   */
  convergenceAchieved: boolean;
  /**
   * Time from measurement start to when last editor reached final state (ms).
   * null if convergence was not measured or not achieved.
   */
  convergenceTimeMs: number | null;
  /**
   * Per-editor convergence fingerprints (SHA-256 hex strings).
   * All equal = converged.
   */
  convergenceFingerprints: string[];

  // ── Resource metrics ───────────────────────────────────────────────────────
  /**
   * Process memory at measurement start (bytes).
   * Note: This is the BENCHMARK RUNNER process, which in single-node mode
   * is the same as the PeerGrid server process.
   */
  processMemoryAtStartBytes: number | null;
  processMemoryPeakBytes: number | null;
  processCpuUserMsTotal: number | null;
  processCpuSystemMsTotal: number | null;
  eventLoopLagBaselineMs: number | null;
  eventLoopLagPeakMs: number | null;
}

// ── Percentile computation ────────────────────────────────────────────────────

/**
 * Compute a percentile from an array of values using linear interpolation.
 *
 * @param sorted - Values sorted ascending (caller must sort).
 * @param p - Percentile as 0–100.
 * @returns Interpolated percentile value, or 0 for empty arrays.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + fraction * (sorted[upper]! - sorted[lower]!);
}

/**
 * Compute arithmetic mean. Returns 0 for empty arrays.
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/**
 * Compute population standard deviation. Returns 0 for < 2 values.
 */
export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Compute all latency statistics from a raw array of latency samples (ms).
 *
 * @param latencySamples - Raw latency values (unsorted). May be empty.
 */
export function computeLatencyStats(latencySamples: readonly number[]): LatencyStats {
  if (latencySamples.length === 0) {
    return {
      sampleCount: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      stddevMs: 0,
    };
  }

  const sorted = [...latencySamples].sort((a, b) => a - b);

  return {
    sampleCount: sorted.length,
    minMs: round2(sorted[0]!),
    maxMs: round2(sorted[sorted.length - 1]!),
    meanMs: round2(mean(sorted)),
    p50Ms: round2(percentile(sorted, 50)),
    p90Ms: round2(percentile(sorted, 90)),
    p95Ms: round2(percentile(sorted, 95)),
    p99Ms: round2(percentile(sorted, 99)),
    stddevMs: round2(stddev(sorted)),
  };
}

/**
 * Compute throughput (operations/second).
 *
 * @param ops - Number of operations.
 * @param durationMs - Duration of the measurement period in ms.
 */
export function throughput(ops: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return round2((ops / durationMs) * 1000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
