/**
 * snapshotQueue.ts
 *
 * Snapshot write coalescing and backpressure protection.
 *
 * Instead of writing snapshots directly to PostgreSQL, callers enqueue a job
 * via `enqueueSnapshot`.  A background worker drains the queue at a controlled
 * rate (MAX_SNAPSHOT_WRITES_PER_SECOND = 10, i.e. one write every 100 ms),
 * preventing burst writes from overwhelming the database under heavy editing load.
 *
 * Deduplication
 * ─────────────
 * The queue is a Map<fileId, Buffer>.  If the same room is enqueued multiple
 * times before the worker processes it, only the latest update survives — older
 * intermediate states are discarded automatically because Map assignment
 * replaces the value while the key is moved to the newest insertion slot.
 *
 * Overflow
 * ────────
 * When the queue reaches MAX_SNAPSHOT_QUEUE entries the oldest pending item
 * (first key in insertion-order Map) is evicted with a warning log before the
 * new item is inserted.
 *
 * Shutdown
 * ────────
 * Call `drainSnapshotQueue()` during server shutdown to flush all remaining
 * jobs immediately, bypassing the rate limiter so the process can exit cleanly.
 */

import { saveSnapshot } from './snapshotStore';
import { getLogger } from '../utils/logger';
import {
  snapshotQueueSizeGauge,
  snapshotWritesTotalCounter,
} from '../metrics/metrics';

const logger = getLogger();

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Maximum sustained snapshot write rate, in writes per second. */
const MAX_SNAPSHOT_WRITES_PER_SECOND = 10;

/** Interval between worker ticks (ms).  Derived from the rate constant. */
const WRITE_INTERVAL_MS = Math.ceil(1000 / MAX_SNAPSHOT_WRITES_PER_SECOND); // 100 ms

/** Hard cap on pending snapshot entries.  Oldest is evicted on overflow. */
const MAX_SNAPSHOT_QUEUE = 1000;

/** How often to emit a queue-size / throughput metrics log (ms). */
const METRICS_INTERVAL_MS = 10_000;

// ── Internal state ────────────────────────────────────────────────────────────

/**
 * The pending-snapshot map.  Insertion order is preserved by the JS spec, so
 * `queue.keys().next().value` is always the oldest entry — used for FIFO
 * eviction on overflow.
 */
const queue = new Map<string, Buffer>();

/** Writes processed during the current metrics window. */
let writesThisWindow = 0;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a snapshot write for `fileId`.
 *
 * - If `fileId` is already queued, the existing entry is replaced with the
 *   newer `update` (deduplication).
 * - If the queue is at `MAX_SNAPSHOT_QUEUE` capacity, the oldest pending entry
 *   is dropped first.
 *
 * Never throws.
 */
export function enqueueSnapshot(fileId: string, update: Buffer): void {
  // Dedup: if the key already exists, queue.set() below will overwrite in-place
  // (no ordering change), so we only need overflow eviction for NEW keys.
  if (!queue.has(fileId) && queue.size >= MAX_SNAPSHOT_QUEUE) {
    // Evict the oldest entry to stay within the size cap.
    const oldest = queue.keys().next().value as string;
    queue.delete(oldest);
    logger.warn(
      { fileId: oldest },
      '[snapshot] queue overflow dropping snapshot',
    );
  }
  queue.set(fileId, update);
}

/**
 * Flush all pending snapshot jobs immediately, bypassing the rate limiter.
 *
 * Intended for use during server shutdown so no in-memory snapshots are lost
 * when the process exits.  Awaits each `saveSnapshot` call sequentially so
 * the caller can be confident the queue is empty when this resolves.
 */
export async function drainSnapshotQueue(): Promise<void> {
  for (const [fileId, update] of queue) {
    queue.delete(fileId);
    await saveSnapshot(fileId, update);
  }
}

// ── Background worker ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Single-flight worker — each write is awaited before the next sleep begins,
// so saveSnapshot calls never overlap even when the DB is slow.
(async function runWorker(): Promise<void> {
  while (true) {
    if (queue.size === 0) {
      await sleep(WRITE_INTERVAL_MS);
      continue;
    }
    const [fileId, update] = queue.entries().next().value as [string, Buffer];
    queue.delete(fileId);
    try {
      await saveSnapshot(fileId, update);
      writesThisWindow++;
      snapshotWritesTotalCounter.inc();
    } catch (err) {
      logger.error({ err }, '[snapshot] worker tick error');
    }
    snapshotQueueSizeGauge.set(queue.size);
    await sleep(WRITE_INTERVAL_MS);
  }
})();

// ── Periodic observability ────────────────────────────────────────────────────

setInterval(() => {
  const wps = (writesThisWindow / (METRICS_INTERVAL_MS / 1000)).toFixed(1);
  snapshotQueueSizeGauge.set(queue.size);
  logger.info(
    { size: queue.size, writesPerSec: wps },
    '[snapshot] queue metrics',
  );
  writesThisWindow = 0;
}, METRICS_INTERVAL_MS);
