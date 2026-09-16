/**
 * compactionService.ts
 *
 * Periodic CRDT state compaction for memory management.
 *
 * Problem:
 *   Yjs Y.Doc instances accumulate tombstones (deleted operations) indefinitely.
 *   For a document edited by hundreds of users over hours, the in-memory
 *   representation can grow to 10× the logical content size.  At 100k users
 *   this exhausts heap memory.
 *
 * Solution:
 *   Periodically compact each Room's Y.Doc by:
 *     1. Encoding the current state as a V2 snapshot (strips tombstones).
 *     2. Creating a fresh Y.Doc and applying the V2 snapshot.
 *     3. Swapping the internal Y.Doc reference atomically.
 *     4. Recording the compaction event in the compaction_log table.
 *
 *   The compaction is triggered when:
 *     - The room has been active for COMPACTION_INTERVAL_MS since last compaction.
 *     - The estimated Y.Doc size exceeds COMPACTION_THRESHOLD_BYTES.
 *     - Manually via the health-check API.
 *
 * Design constraints:
 *   - Compaction MUST NOT drop awareness state.
 *   - Compaction MUST preserve all connected clients' sync state.
 *   - Compaction MUST be serialised with save operations (save mutex).
 *   - All errors are caught and logged; compaction failures are non-fatal.
 */

import * as Y from 'yjs';
import { getPool } from '../db/pool';
import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from '../ws/clusterClock';
import {
  snapshotCompactionDuration,
  compactionTombstonesRemoved,
  compactionSavings,
  totalRoomMemoryBytes,
  roomMemoryBytes,
} from '../metrics/advancedMetrics';

const logger = getLogger();

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Minimum interval between compactions for a single room (ms). */
export const COMPACTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Y.Doc size threshold (bytes) that triggers compaction eligibility. */
export const COMPACTION_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Global compaction sweep interval — how often all rooms are evaluated (ms). */
export const COMPACTION_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

// ── Per-room compaction tracking ────────────────────────────────────────────

/** Tracks the last compaction time for each fileId. */
const lastCompactionTime = new Map<string, number>();

// ── Core compaction logic ───────────────────────────────────────────────────

export interface CompactionResult {
  /** Original Y.Doc encoded size (V1 bytes). */
  beforeBytes: number;
  /** Compacted Y.Doc encoded size (V1 bytes). */
  afterBytes: number;
  /** Time spent on compaction (ms). */
  durationMs: number;
  /** Whether compaction was actually performed (false if skipped). */
  performed: boolean;
  /** The compacted state as a V1 Buffer for replay. */
  compactedState?: Buffer;
}

/**
 * Estimate the byte size of a Y.Doc by encoding its state.
 * This is more accurate than `doc.store` inspection but costs a full traversal.
 * For hot-path checks, use the cached value from the last compaction.
 */
export function estimateDocSize(doc: Y.Doc): number {
  try {
    return Y.encodeStateAsUpdate(doc).byteLength;
  } catch {
    return 0;
  }
}

/**
 * Compact a Y.Doc's internal state by re-encoding through a fresh document.
 *
 * This operation:
 *   1. Encodes the current state as V2 (compact format, strips tombstones).
 *   2. Creates a fresh Y.Doc and applies the V2 state.
 *   3. Returns the compacted V1 state buffer.
 *
 * The caller (Room) is responsible for atomically swapping the Y.Doc.
 *
 * @param doc  The Y.Doc to compact. The original is NOT modified.
 * @returns CompactionResult with the compacted state.
 */
export function compactDoc(doc: Y.Doc): CompactionResult {
  const t0 = performance.now();

  try {
    // Measure before
    const beforeState = Y.encodeStateAsUpdate(doc);
    const beforeBytes = beforeState.byteLength;

    // Encode as V2 (strips tombstones and compresses)
    const v2State = Y.encodeStateAsUpdateV2(doc);

    // Apply V2 to a fresh doc
    const freshDoc = new Y.Doc();
    Y.applyUpdateV2(freshDoc, v2State);

    // Encode the fresh doc as V1 for compatibility
    const afterState = Y.encodeStateAsUpdate(freshDoc);
    const afterBytes = afterState.byteLength;
    freshDoc.destroy();

    const durationMs = Math.round(performance.now() - t0);

    // Metrics
    snapshotCompactionDuration.observe(durationMs);
    const savings = beforeBytes > 0 ? 1 - (afterBytes / beforeBytes) : 0;
    compactionSavings.observe(Math.max(0, savings));

    if (beforeBytes > afterBytes) {
      compactionTombstonesRemoved.inc(beforeBytes - afterBytes);
    }

    return {
      beforeBytes,
      afterBytes,
      durationMs,
      performed: true,
      compactedState: Buffer.from(afterState),
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    logger.error({ err, durationMs }, '[compaction] failed to compact Y.Doc');
    return { beforeBytes: 0, afterBytes: 0, durationMs, performed: false };
  }
}

/**
 * Check whether a room is eligible for compaction.
 *
 * @param fileId      Room identifier.
 * @param docSizeBytes  Current estimated Y.Doc size.
 * @returns true if the room should be compacted.
 */
export function isCompactionEligible(fileId: string, docSizeBytes: number): boolean {
  if (docSizeBytes < COMPACTION_THRESHOLD_BYTES) return false;

  const lastTime = lastCompactionTime.get(fileId) ?? 0;
  return getClusterTimeMs() - lastTime >= COMPACTION_INTERVAL_MS;
}

/**
 * Record a successful compaction.
 */
export function recordCompaction(fileId: string): void {
  lastCompactionTime.set(fileId, getClusterTimeMs());
}

/**
 * Clean up compaction tracking state for a room that has been destroyed.
 */
export function clearCompactionState(fileId: string): void {
  lastCompactionTime.delete(fileId);
}

/**
 * Log a compaction event to the database audit trail.
 * Fire-and-forget — errors are non-fatal.
 */
export async function logCompactionEvent(
  fileId: string,
  result: CompactionResult,
  nodeId?: string,
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO compaction_log (file_id, before_bytes, after_bytes, tombstones_removed, duration_ms, node_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fileId,
        result.beforeBytes,
        result.afterBytes,
        Math.max(0, result.beforeBytes - result.afterBytes),
        result.durationMs,
        nodeId ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, fileId }, '[compaction] failed to log compaction event');
  }
}

/**
 * Update the per-room memory gauge.
 * Called periodically and after compaction.
 */
export function updateRoomMemoryMetrics(
  rooms: Iterable<[string, { estimatedSize: number }]>,
): void {
  let total = 0;
  for (const [fileId, room] of rooms) {
    roomMemoryBytes.set({ file_id: fileId }, room.estimatedSize);
    total += room.estimatedSize;
  }
  totalRoomMemoryBytes.set(total);
}

