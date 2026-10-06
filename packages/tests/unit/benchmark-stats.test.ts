/**
 * unit/benchmark-stats.test.ts
 *
 * Tests for BenchmarkStats.ts — pure statistics functions.
 * All tests run without any network, database, or WebSocket dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  percentile,
  mean,
  stddev,
  computeLatencyStats,
  throughput,
} from '../../packages/server/src/benchmark/BenchmarkStats';

// ── percentile ────────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('returns the only element for a single-element array', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('computes p50 on [1,2,3,4,5]', () => {
    const sorted = [1, 2, 3, 4, 5];
    // p50 index = 0.5 * 4 = 2.0 → exactly sorted[2] = 3
    expect(percentile(sorted, 50)).toBe(3);
  });

  it('computes p0 (minimum)', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it('computes p100 (maximum)', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });

  it('interpolates between values for p75 on [1,2,3,4]', () => {
    // p75 index = 0.75 * 3 = 2.25 → between sorted[2]=3 and sorted[3]=4
    // 3 + 0.25 * (4 - 3) = 3.25
    expect(percentile([1, 2, 3, 4], 75)).toBeCloseTo(3.25);
  });

  it('computes p95 on a larger dataset correctly', () => {
    // 20 elements: 1..20
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    // p95 index = 0.95 * 19 = 18.05 → between 19 and 20
    // 19 + 0.05 * 1 = 19.05
    expect(percentile(sorted, 95)).toBeCloseTo(19.05);
  });

  it('computes p99 on a 100-element array', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    // p99 index = 0.99 * 99 = 98.01 → between 99 and 100
    expect(percentile(sorted, 99)).toBeGreaterThan(98);
    expect(percentile(sorted, 99)).toBeLessThanOrEqual(100);
  });
});

// ── mean ──────────────────────────────────────────────────────────────────────

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('computes mean of [1,2,3,4,5]', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('handles single element', () => {
    expect(mean([7])).toBe(7);
  });

  it('handles floating point values', () => {
    expect(mean([1.5, 2.5, 3.0])).toBeCloseTo(2.333, 2);
  });
});

// ── stddev ────────────────────────────────────────────────────────────────────

describe('stddev', () => {
  it('returns 0 for empty array', () => {
    expect(stddev([])).toBe(0);
  });

  it('returns 0 for single element', () => {
    expect(stddev([42])).toBe(0);
  });

  it('computes population stddev for [2,4,4,4,5,5,7,9]', () => {
    // Mean = 5, variance = (9+1+1+1+0+0+4+16)/8 = 32/8 = 4, stddev = 2
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2);
  });

  it('returns 0 for all-same values', () => {
    expect(stddev([3, 3, 3, 3])).toBe(0);
  });
});

// ── computeLatencyStats ───────────────────────────────────────────────────────

describe('computeLatencyStats', () => {
  it('returns zero stats for empty samples', () => {
    const stats = computeLatencyStats([]);
    expect(stats.sampleCount).toBe(0);
    expect(stats.p50Ms).toBe(0);
    expect(stats.p95Ms).toBe(0);
    expect(stats.meanMs).toBe(0);
  });

  it('computes correct stats for known dataset', () => {
    // 10 samples: 10, 20, 30, ..., 100
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computeLatencyStats(samples);

    expect(stats.sampleCount).toBe(10);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(100);
    expect(stats.meanMs).toBeCloseTo(55);
    // p50 index = 0.5 * 9 = 4.5 → between 50 and 60 → 55
    expect(stats.p50Ms).toBeCloseTo(55);
    // p95 index = 0.95 * 9 = 8.55 → between 90 and 100 → 95.5
    expect(stats.p95Ms).toBeCloseTo(95.5);
    // p99 index = 0.99 * 9 = 8.91 → between 90 and 100 → 99.1
    expect(stats.p99Ms).toBeCloseTo(99.1);
  });

  it('handles single sample', () => {
    const stats = computeLatencyStats([42]);
    expect(stats.sampleCount).toBe(1);
    expect(stats.minMs).toBe(42);
    expect(stats.maxMs).toBe(42);
    expect(stats.p50Ms).toBe(42);
    expect(stats.p95Ms).toBe(42);
    expect(stats.stddevMs).toBe(0);
  });

  it('sorts samples before computing percentiles', () => {
    // Provide unsorted input — result should be same as sorted
    const unsorted = [100, 10, 50, 30, 70, 20, 90, 40, 80, 60];
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s1 = computeLatencyStats(unsorted);
    const s2 = computeLatencyStats(sorted);
    expect(s1.p50Ms).toBeCloseTo(s2.p50Ms);
    expect(s1.p95Ms).toBeCloseTo(s2.p95Ms);
  });
});

// ── throughput ────────────────────────────────────────────────────────────────

describe('throughput', () => {
  it('returns 0 for zero duration', () => {
    expect(throughput(100, 0)).toBe(0);
  });

  it('returns 0 for negative duration', () => {
    expect(throughput(100, -1000)).toBe(0);
  });

  it('computes ops/sec correctly', () => {
    // 600 ops in 60_000ms = 10 ops/sec
    expect(throughput(600, 60_000)).toBe(10);
  });

  it('handles fractional result', () => {
    // 7 ops in 3000ms = 2.33... ops/sec → rounded to 2 decimals
    expect(throughput(7, 3000)).toBeCloseTo(2.33, 1);
  });
});
