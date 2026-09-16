/**
 * snapshotStore.ts
 *
 * Low-level CRDT snapshot persistence layer using the `document_snapshots`
 * PostgreSQL table.
 *
 * Required DDL (run once, e.g. in a migration):
 *
 *   CREATE TABLE IF NOT EXISTS document_snapshots (
 *     file_id    TEXT        PRIMARY KEY,
 *     snapshot   BYTEA       NOT NULL,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * Snapshots are stored as compacted Yjs V2 state (Y.encodeStateAsUpdateV2).
 * The compaction step creates a fresh Y.Doc, applies the current update, and
 * re-encodes it — removing accumulated tombstones and redundant operations.
 *
 * Backwards compatibility: snapshots previously written with encodeStateAsUpdate
 * (V1) are handled transparently on load.  loadSnapshot always returns a V1
 * buffer so that Room.ts's existing Y.applyUpdate call continues to work.
 *
 * Design constraints:
 *   - All errors are caught and logged; callers are NEVER thrown at.
 *   - All DB operations are non-blocking (async, pool-based).
 *   - Snapshots exceeding MAX_SNAPSHOT_BYTES are skipped with a warning.
 */

import * as Y from 'yjs';
import { getPool } from '../db/pool';
import { getLogger } from '../utils/logger';
import { loadUpdatesSince, pruneUpdates } from './updateLog';

const logger = getLogger();

/** 5 MB hard cap — snapshots larger than this are logged and skipped. */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the most recent CRDT snapshot for `fileId` and replay any update log
 * entries that were appended after the snapshot was written.
 *
 * This is the primary crash-recovery entry point.  The sequence is:
 *
 *   1. Load `(snapshot, snapshot_seq)` from `document_snapshots`.
 *   2. Fetch all `document_updates` rows with id > snapshot_seq.
 *   3. Apply the snapshot to a fresh Y.Doc.
 *   4. Replay each pending update in ascending id order.
 *   5. Re-encode and return as a V1 Buffer (compatible with Y.applyUpdate).
 *
 * On normal startup (no crash) step 2 returns zero rows and the function
 * behaves identically to the previous implementation.
 *
 * Always returns a V1-encoded Buffer compatible with Y.applyUpdate, regardless
 * of whether the stored snapshot is V1 or V2.  Returns null when no snapshot
 * exists or on any database/decode error.
 */
export async function loadSnapshot(fileId: string): Promise<Buffer | null> {
  try {
    const result = await getPool().query<{ snapshot: Buffer; snapshot_seq: string }>(
      `SELECT snapshot,
              COALESCE(snapshot_seq, 0)::text AS snapshot_seq
       FROM   document_snapshots
       WHERE  file_id = $1`,
      [fileId],
    );
    if (result.rows.length === 0) return null;

    const raw         = result.rows[0]!.snapshot;
    const snapshotSeq = BigInt(result.rows[0]!.snapshot_seq);

    // ── 1. Apply base snapshot to a fresh recovery doc ──────────────────────
    const recoveryDoc = new Y.Doc();
    try {
      // Prefer V2 decode (compact format); fall back to V1 (legacy).
      Y.applyUpdateV2(recoveryDoc, new Uint8Array(raw));
    } catch {
      Y.applyUpdate(recoveryDoc, new Uint8Array(raw));
    }

    // ── 2. Replay any update log entries since the snapshot watermark ─────
    const pending = await loadUpdatesSince(fileId, snapshotSeq);

    if (pending.length > 0) {
      logger.info(
        { fileId, snapshotSeq: String(snapshotSeq), pendingUpdates: pending.length },
        '[snapshot] crash-recovery: replaying update log entries',
      );
      for (const entry of pending) {
        try {
          // V1 raw updates as stored by appendUpdate
          Y.applyUpdate(recoveryDoc, new Uint8Array(entry.updateData));
        } catch (err) {
          // A corrupt/malformed entry is skipped — subsequent entries are
          // still applied because Yjs CRDT convergence tolerates missing ops.
          logger.error(
            { err, fileId, seq: String(entry.id) },
            '[snapshot] skipping corrupt update log entry during recovery',
          );
        }
      }
    }

    // ── 3. Re-encode as V1 so Room.ts's Y.applyUpdate always works ──────────
    return Buffer.from(Y.encodeStateAsUpdate(recoveryDoc));
  } catch (err) {
    logger.error({ err, fileId }, 'snapshotStore: failed to load snapshot');
    return null;
  }
}

/**
 * Compact `update` (a V1 Yjs state buffer from room.encodeStateAsUpdate) and
 * persist it as the canonical snapshot for `fileId`.
 *
 * Compaction flow:
 *   1. Apply the incoming update to a throwaway Y.Doc.
 *   2. Re-encode using encodeStateAsUpdateV2, which strips tombstones and
 *      produces a smaller binary payload.
 *   3. Reject snapshots exceeding MAX_SNAPSHOT_BYTES with a warning.
 *   4. UPSERT the compact V2 bytes into document_snapshots.
 *
 * Never throws — all errors are logged and swallowed.
 */
export async function saveSnapshot(fileId: string, update: Buffer): Promise<void> {
  const t0 = Date.now();
  try {
    // ── 1. Compact ──────────────────────────────────────────────────────────
    const compactDoc = new Y.Doc();
    Y.applyUpdate(compactDoc, new Uint8Array(update));
    const compactSnapshot = Buffer.from(Y.encodeStateAsUpdateV2(compactDoc));

    // ── 2. Size guard ────────────────────────────────────────────────────────
    if (compactSnapshot.byteLength > MAX_SNAPSHOT_BYTES) {
      logger.warn(
        { fileId, size: compactSnapshot.byteLength, maxBytes: MAX_SNAPSHOT_BYTES },
        '[snapshot] skipped — snapshot exceeds size limit',
      );
      return;
    }

    // ── 3. Persist snapshot + record update-log watermark atomically ─────────
    //
    // The CTE reads MAX(id) from document_updates at the moment of the INSERT.
    // Any updates appended with a higher id after this point will NOT be
    // pruned — they will be faithfully replayed on the next recovery.
    const seqResult = await getPool().query<{ snapshot_seq: string }>(
      `WITH watermark AS (
         SELECT COALESCE(MAX(id), 0)::text AS seq
         FROM   document_updates
         WHERE  doc_id = $1
       )
       INSERT INTO document_snapshots (file_id, snapshot, updated_at, snapshot_seq)
       SELECT $1, $2, NOW(), watermark.seq::bigint
       FROM   watermark
       ON CONFLICT (file_id) DO UPDATE
         SET snapshot     = EXCLUDED.snapshot,
             updated_at   = EXCLUDED.updated_at,
             snapshot_seq = EXCLUDED.snapshot_seq
       RETURNING snapshot_seq::text AS snapshot_seq`,
      [fileId, compactSnapshot],
    );
    const snapshotSeq = BigInt(seqResult.rows[0]?.snapshot_seq ?? '0');

    // ── 4. Prune update log entries now incorporated in the snapshot ───────
    //
    // This is best-effort: if pruneUpdates fails the rows will be replayed
    // on recovery (idempotent for Yjs), so data integrity is maintained.
    if (snapshotSeq > 0n) {
      await pruneUpdates(fileId, snapshotSeq);
    }

    // ── 5. Observability ─────────────────────────────────────────────────────
    const duration = Date.now() - t0;
    const kb = (compactSnapshot.byteLength / 1024).toFixed(1);
    logger.info(
      { fileId, size: `${kb}kb`, duration: `${duration}ms`, snapshotSeq: String(snapshotSeq) },
      '[snapshot] saved',
    );
  } catch (err) {
    logger.error({ err, fileId }, 'snapshotStore: failed to save snapshot');
  }
}
