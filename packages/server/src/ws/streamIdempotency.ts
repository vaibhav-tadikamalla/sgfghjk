/**
 * streamIdempotency.ts
 *
 * Idempotent Redis Stream consumer guard — prevents duplicate CRDT application.
 *
 * Problem:
 *   Redis Streams provide **at-least-once** delivery.  A message may be
 *   redelivered when:
 *     - A node crashes after Y.applyUpdate() but before XACK
 *     - XAUTOCLAIM reassigns pending messages from a dead consumer
 *     - Consumer lag recovery replays entries
 *
 *   While Yjs tolerates duplicate updates (CRDTs are idempotent), repeated
 *   application still causes:
 *     - Inflated metrics (merge latency, consumed count)
 *     - Unnecessary CPU work (decode + apply + broadcast)
 *     - Stream backlog growth from redundant reprocessing
 *     - Reconciliation anomalies when state vectors drift
 *
 * Solution:
 *   Track the **last applied stream entry ID** per room, per node.
 *   Before applying any stream entry, compare its ID against the tracked
 *   high-water mark.  Skip if already processed.
 *
 * Three-tier persistence strategy:
 *   1. **In-memory** (hot path)  — Map<roomId, lastStreamId>
 *      Zero-cost lookup; lost on crash (acceptable — Redis has the backup).
 *
 *   2. **Redis checkpoint** (warm) — `pg:stream:hwm:<nodeId>:<roomId>`
 *      Flushed periodically (every CHECKPOINT_INTERVAL_MS or N entries).
 *      Survives process restart.  TTL = 1 hour (auto-cleanup for dead rooms).
 *
 *   3. **PostgreSQL** (cold) — `document_updates.stream_entry_id`
 *      Already present from migration 009.  Populated on WAL append.
 *      Used for disaster recovery only (not queried in hot path).
 *
 * Stream ID comparison:
 *   Redis stream IDs have the format `<timestamp_ms>-<sequence>`.
 *   Comparison must be numeric on both parts — string comparison fails
 *   for IDs of different digit lengths (e.g. "9-0" vs "10-0").
 */

import { getLogger } from '../utils/logger';

const logger = getLogger();

// ── Constants ───────────────────────────────────────────────────────────────

/** How often to flush high-water marks to Redis (ms). */
export const CHECKPOINT_INTERVAL_MS = 5_000;

/** TTL for the Redis checkpoint key (seconds).  Auto-cleans dead rooms. */
export const CHECKPOINT_TTL_SEC = 3600; // 1 hour

/** Number of applied entries before forcing an immediate checkpoint. */
export const CHECKPOINT_ENTRY_THRESHOLD = 100;

/** Redis key prefix for per-room stream high-water marks. */
export function hwmKey(nodeId: string, roomId: string): string {
  return `pg:stream:hwm:${nodeId}:${roomId}`;
}

// ── Stream ID utilities ─────────────────────────────────────────────────────

/**
 * Parse a Redis stream ID into its numeric components.
 *
 * Redis stream IDs have the format `<timestamp_ms>-<sequence>`.
 * Returns [timestamp, sequence] as bigints for precise comparison.
 *
 * @example parseStreamId("1677500000000-3") → [1677500000000n, 3n]
 */
export function parseStreamId(id: string): [bigint, bigint] {
  const dashIdx = id.indexOf('-');
  if (dashIdx === -1) return [BigInt(id), 0n];
  return [
    BigInt(id.substring(0, dashIdx)),
    BigInt(id.substring(dashIdx + 1)),
  ];
}

/**
 * Compare two Redis stream IDs.
 *
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *
 * Uses numeric comparison on both timestamp and sequence parts.
 * This is critical because string comparison fails for IDs of different
 * digit lengths (e.g. "9-0" < "10-0" is false lexicographically).
 */
export function compareStreamIds(a: string, b: string): -1 | 0 | 1 {
  const [aTs, aSeq] = parseStreamId(a);
  const [bTs, bSeq] = parseStreamId(b);

  if (aTs < bTs) return -1;
  if (aTs > bTs) return 1;
  if (aSeq < bSeq) return -1;
  if (aSeq > bSeq) return 1;
  return 0;
}

// ── StreamIdempotencyGuard ──────────────────────────────────────────────────

/**
 * Per-room high-water mark tracker for idempotent stream consumption.
 *
 * Usage:
 *   1. On startup: call `loadCheckpoints(redis, nodeId)` to restore state
 *   2. Before applying an entry: `if (!guard.shouldApply(roomId, entryId)) skip;`
 *   3. After successful apply: `guard.markApplied(roomId, entryId)`
 *   4. Periodically: `guard.flushCheckpoints(redis, nodeId)` to persist
 *   5. On shutdown: `guard.flushCheckpoints(redis, nodeId)` one final time
 */
export class StreamIdempotencyGuard {
  /**
   * In-memory high-water marks: roomId → last applied stream entry ID.
   *
   * This is the primary check — zero allocation, O(1) lookup.
   * Updated atomically after every successful Y.applyUpdate().
   */
  private readonly hwm = new Map<string, string>();

  /**
   * Dirty set: roomIds whose HWM has changed since the last checkpoint.
   * Tracks which rooms need to be flushed to Redis.
   */
  private readonly dirty = new Set<string>();

  /**
   * Count of entries applied since last checkpoint flush.
   * Used to trigger eager flushing under high throughput.
   */
  private appliedSinceCheckpoint = 0;

  /**
   * Periodic checkpoint timer.
   */
  private checkpointTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Total duplicate entries skipped (for metrics).
   */
  private _duplicatesSkipped = 0;

  /** Total duplicates skipped since creation. */
  get duplicatesSkipped(): number {
    return this._duplicatesSkipped;
  }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Check whether a stream entry should be applied to the local Y.Doc.
   *
   * Returns `true` if the entry has NOT been applied before (or is the
   * first entry for this room).  Returns `false` if the entry ID is
   * less than or equal to the last applied ID (duplicate / redelivery).
   *
   * @param roomId   Room / file ID.
   * @param entryId  Redis stream entry ID (e.g. "1677500000000-3").
   */
  shouldApply(roomId: string, entryId: string): boolean {
    const lastId = this.hwm.get(roomId);

    // No prior entry recorded — first message for this room (always apply)
    if (lastId === undefined) return true;

    // Compare: only apply if entryId > lastId (strict ordering)
    const cmp = compareStreamIds(entryId, lastId);
    if (cmp <= 0) {
      // Duplicate or out-of-order — skip
      this._duplicatesSkipped++;
      logger.debug(
        { roomId, entryId, lastId },
        '[idempotency] skipping duplicate/old stream entry',
      );
      return false;
    }

    return true;
  }

  /**
   * Record that a stream entry has been successfully applied.
   *
   * Updates the in-memory HWM and marks the room as dirty for checkpointing.
   * This MUST be called after Y.applyUpdate() succeeds but BEFORE the
   * entry is ACKed — ensuring crash-safety ordering:
   *
   *   1. Y.applyUpdate()      ← CRDT state updated
   *   2. markApplied()         ← HWM updated (in-memory)
   *   3. XACK                  ← entry removed from PEL
   *
   * If the node crashes between 1 and 3, on restart:
   *   - The entry is still in the PEL (not ACKed)
   *   - BUT the HWM from the last Redis checkpoint knows it was applied
   *   - So shouldApply() returns false → skip → XACK
   *
   * @param roomId   Room / file ID.
   * @param entryId  Redis stream entry ID.
   */
  markApplied(roomId: string, entryId: string): void {
    const current = this.hwm.get(roomId);
    // Only advance forward — never regress the HWM
    if (current !== undefined && compareStreamIds(entryId, current) <= 0) return;

    this.hwm.set(roomId, entryId);
    this.dirty.add(roomId);
    this.appliedSinceCheckpoint++;
  }

  /**
   * Get the current high-water mark for a room.
   * Returns undefined if no entry has been applied yet.
   */
  getHWM(roomId: string): string | undefined {
    return this.hwm.get(roomId);
  }

  /**
   * Remove tracking for a room (called when the room is closed).
   */
  removeRoom(roomId: string): void {
    this.hwm.delete(roomId);
    this.dirty.delete(roomId);
  }

  /**
   * Check if we should eagerly flush checkpoints (high throughput path).
   */
  shouldEagerFlush(): boolean {
    return this.appliedSinceCheckpoint >= CHECKPOINT_ENTRY_THRESHOLD;
  }

  // ── Redis Checkpoint Persistence ──────────────────────────────────────────

  /**
   * Load high-water marks from Redis for all rooms on this node.
   *
   * Called once on startup before the consumer loop begins.
   * Uses SCAN to find all `pg:stream:hwm:<nodeId>:*` keys, then MGET
   * to load the values in a single round-trip.
   *
   * @param redis   ioredis client.
   * @param nodeId  This node's ID.
   * @param roomIds Optional list of room IDs to load (optimization for
   *                targeted recovery instead of full scan).
   */
  async loadCheckpoints(
    redis: import('ioredis').default,
    nodeId: string,
    roomIds?: string[],
  ): Promise<number> {
    const prefix = `pg:stream:hwm:${nodeId}:`;
    let loaded = 0;

    try {
      if (roomIds && roomIds.length > 0) {
        // Targeted load — single MGET for known rooms
        const keys = roomIds.map((r) => hwmKey(nodeId, r));
        const values = await redis.mget(...keys);
        for (let i = 0; i < roomIds.length; i++) {
          const val = values[i];
          if (val !== null) {
            this.hwm.set(roomIds[i]!, val);
            loaded++;
          }
        }
      } else {
        // Full scan — find all HWM keys for this node
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(
            cursor,
            'MATCH', `${prefix}*`,
            'COUNT', '200',
          );
          cursor = nextCursor;

          if (keys.length === 0) continue;

          const values = await redis.mget(...keys);
          for (let i = 0; i < keys.length; i++) {
            const val = values[i];
            if (val === null) continue;
            // Extract roomId from key: pg:stream:hwm:<nodeId>:<roomId>
            const roomId = keys[i]!.substring(prefix.length);
            this.hwm.set(roomId, val);
            loaded++;
          }
        } while (cursor !== '0');
      }

      if (loaded > 0) {
        logger.info(
          { nodeId, loaded },
          '[idempotency] restored high-water marks from Redis checkpoints',
        );
      }
    } catch (err) {
      logger.error(
        { err, nodeId },
        '[idempotency] failed to load checkpoints from Redis',
      );
    }

    return loaded;
  }

  /**
   * Flush dirty high-water marks to Redis.
   *
   * Uses a pipeline for efficiency — all dirty HWMs are written in a
   * single round-trip.  Each key has a TTL so dead rooms auto-expire.
   *
   * @param redis   ioredis client.
   * @param nodeId  This node's ID.
   * @returns Number of checkpoints flushed.
   */
  async flushCheckpoints(
    redis: import('ioredis').default,
    nodeId: string,
  ): Promise<number> {
    if (this.dirty.size === 0) return 0;

    // Snapshot and clear dirty set atomically (avoid double-flush)
    const toFlush = new Map<string, string>();
    for (const roomId of this.dirty) {
      const id = this.hwm.get(roomId);
      if (id !== undefined) toFlush.set(roomId, id);
    }
    this.dirty.clear();
    this.appliedSinceCheckpoint = 0;

    if (toFlush.size === 0) return 0;

    try {
      const pipeline = redis.pipeline();
      for (const [roomId, streamId] of toFlush) {
        pipeline.set(hwmKey(nodeId, roomId), streamId, 'EX', CHECKPOINT_TTL_SEC);
      }
      await pipeline.exec();

      logger.debug(
        { nodeId, count: toFlush.size },
        '[idempotency] flushed HWM checkpoints to Redis',
      );
      return toFlush.size;
    } catch (err) {
      // Re-mark as dirty so they get retried next flush
      for (const roomId of toFlush.keys()) {
        this.dirty.add(roomId);
      }
      logger.error(
        { err, nodeId, count: toFlush.size },
        '[idempotency] failed to flush HWM checkpoints',
      );
      return 0;
    }
  }

  /**
   * Clean up a room's checkpoint from Redis (when the room is permanently closed).
   *
   * @param redis   ioredis client.
   * @param nodeId  This node's ID.
   * @param roomId  Room / file ID.
   */
  async removeCheckpoint(
    redis: import('ioredis').default,
    nodeId: string,
    roomId: string,
  ): Promise<void> {
    this.removeRoom(roomId);
    try {
      await redis.del(hwmKey(nodeId, roomId));
    } catch (err) {
      logger.warn(
        { err, nodeId, roomId },
        '[idempotency] failed to remove HWM checkpoint',
      );
    }
  }

  // ── Periodic checkpoint timer ─────────────────────────────────────────────

  /**
   * Start the periodic checkpoint flush timer.
   *
   * @param redis   ioredis client.
   * @param nodeId  This node's ID.
   */
  startCheckpointTimer(redis: import('ioredis').default, nodeId: string): void {
    if (this.checkpointTimer) return;

    this.checkpointTimer = setInterval(() => {
      void this.flushCheckpoints(redis, nodeId).catch((err) => {
        logger.error({ err }, '[idempotency] periodic checkpoint flush failed');
      });
    }, CHECKPOINT_INTERVAL_MS);

    if (typeof this.checkpointTimer.unref === 'function') {
      this.checkpointTimer.unref();
    }
  }

  /**
   * Stop the periodic checkpoint timer and flush remaining dirty entries.
   *
   * @param redis   ioredis client.
   * @param nodeId  This node's ID.
   */
  async stopCheckpointTimer(redis: import('ioredis').default, nodeId: string): Promise<void> {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    // Final flush on shutdown
    await this.flushCheckpoints(redis, nodeId);
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  /**
   * Get a snapshot of all tracked rooms for monitoring/debugging.
   */
  getSnapshot(): Map<string, string> {
    return new Map(this.hwm);
  }

  /**
   * Number of rooms currently tracked.
   */
  get trackedRooms(): number {
    return this.hwm.size;
  }

  /**
   * Number of dirty rooms pending checkpoint flush.
   */
  get dirtyRooms(): number {
    return this.dirty.size;
  }
}
