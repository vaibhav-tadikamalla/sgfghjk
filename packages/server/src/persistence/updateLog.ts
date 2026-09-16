/**
 * updateLog.ts
 *
 * Durable write-ahead log for raw Yjs updates.
 *
 * Every Yjs update received from a client is appended to the
 * `document_updates` PostgreSQL table before being broadcast.
 * This eliminates the crash-loss window that existed when the only
 * persistence was the debounced snapshotQueue.
 *
 * ── Recovery flow ─────────────────────────────────────────────────────────
 *
 *   loadSnapshot()  →  (snapshot_bytes, snapshot_seq)
 *   loadUpdatesSince(doc_id, snapshot_seq)  →  rows ordered by id ASC
 *   for each row: Y.applyUpdate(doc, row.update_data)
 *   result: exact pre-crash state, zero loss.
 *
 * ── Pruning ───────────────────────────────────────────────────────────────
 *
 *   After every successful snapshot write, saveSnapshot() records the
 *   highest document_updates.id that is already incorporated
 *   (snapshot_seq watermark) and calls pruneUpdates() to DELETE all rows
 *   with id <= snapshot_seq.  This keeps the table bounded regardless of
 *   edit volume.
 *
 * ── Error handling ────────────────────────────────────────────────────────
 *
 *   appendUpdate() errors are non-fatal by design.  A transient DB outage
 *   degrades the durability guarantee (matching pre-migration behaviour)
 *   but does NOT prevent the in-memory Yjs update from being applied and
 *   broadcast to peers.  Callers should fire-and-forget with a .catch()
 *   log rather than awaiting in the hot WebSocket message path.
 *
 *   loadUpdatesSince() and pruneUpdates() are used only in the background
 *   persistence path; errors there are swallowed after logging.
 */

import { getPool } from '../db/pool';
import { getLogger } from '../utils/logger';

const logger = getLogger();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateLogEntry {
  /** BIGSERIAL primary key — monotonically increasing global sequence. */
  id: bigint;
  /** Raw Yjs V1 binary update, exactly as received from the client. */
  updateData: Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append one raw Yjs update to the persistent log.
 *
 * Called on every document write that passes permission checks, immediately
 * after Y.applyUpdate succeeds in Room.handleSyncMsg.
 *
 * Returns the assigned BIGSERIAL id so it could be used for ack-ing.
 * Returns null on any database error (non-fatal, logged).
 */
export async function appendUpdate(
  docId: string,
  update: Buffer,
): Promise<bigint | null> {
  try {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO document_updates (doc_id, update_data)
       VALUES ($1, $2)
       RETURNING id::text AS id`,
      [docId, update],
    );
    return BigInt(result.rows[0]!.id);
  } catch (err) {
    logger.error({ err, docId }, '[updateLog] appendUpdate failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / recovery path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load all updates for `docId` whose id is strictly greater than `afterSeq`,
 * ordered ascending by id.
 *
 * Used during crash recovery to replay the WAL on top of the last snapshot.
 * Returns an empty array on any database error (recovers as if no log exists,
 * matching pre-migration behaviour).
 *
 * @param docId     The file / document identifier (TEXT, not UUID).
 * @param afterSeq  The snapshot_seq watermark; replay begins at afterSeq + 1.
 */
export async function loadUpdatesSince(
  docId: string,
  afterSeq: bigint,
): Promise<UpdateLogEntry[]> {
  try {
    const result = await getPool().query<{ id: string; update_data: Buffer }>(
      `SELECT id::text AS id, update_data
       FROM   document_updates
       WHERE  doc_id = $1
         AND  id     > $2
       ORDER  BY id ASC`,
      [docId, String(afterSeq)],
    );
    return result.rows.map((r) => ({
      id: BigInt(r.id),
      updateData: r.update_data,
    }));
  } catch (err) {
    logger.error(
      { err, docId, afterSeq: String(afterSeq) },
      '[updateLog] loadUpdatesSince failed',
    );
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pruning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete all update log entries for `docId` with id <= `upToSeq`.
 *
 * Called by saveSnapshot after a successful snapshot write once the watermark
 * has been recorded.  Safe to call concurrently — DELETE is idempotent when
 * the target rows are already gone.
 *
 * Any error here is non-fatal: unpruned rows will simply be replayed on the
 * next recovery (Yjs CRDT apply is idempotent for already-incorporated ops).
 *
 * @param docId     The file / document identifier.
 * @param upToSeq   The snapshot_seq watermark; all rows with id <= this are safe to delete.
 */
export async function pruneUpdates(docId: string, upToSeq: bigint): Promise<void> {
  try {
    const result = await getPool().query(
      `DELETE FROM document_updates
       WHERE  doc_id = $1
         AND  id    <= $2`,
      [docId, String(upToSeq)],
    );
    logger.debug(
      { docId, upToSeq: String(upToSeq), deleted: result.rowCount },
      '[updateLog] pruned update log after snapshot',
    );
  } catch (err) {
    logger.error({ err, docId, upToSeq: String(upToSeq) }, '[updateLog] pruneUpdates failed');
    // Non-fatal: next recovery will replay the extra rows harmlessly.
  }
}
