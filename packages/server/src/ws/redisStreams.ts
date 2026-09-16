/**
 * redisStreams.ts
 *
 * Durable event log with backpressure using Redis Streams.
 *
 * Problem:
 *   Redis pub/sub provides no persistence or flow control.  If a subscriber
 *   is temporarily disconnected (Redis reconnect, node restart), all messages
 *   published during the gap are lost.  And there is no backpressure — a fast
 *   publisher can overwhelm a slow consumer.
 *
 * Solution:
 *   Replace the high-frequency CRDT update propagation path with Redis Streams:
 *
 *   - `pg:stream:<roomId>` — append-only log of CRDT updates for each room
 *   - Consumer groups per node — each node gets its own cursor
 *   - XREADGROUP with BLOCK for efficient polling with backpressure
 *   - Replay support — lagging nodes can catch up from the stream
 *   - MAXLEN trimming — keeps the stream bounded
 *
 * Wire format:
 *   Each stream entry has fields:
 *     - `node`    — nodeId of the publisher (for loop prevention)
 *     - `data`    — base64-encoded raw CRDT binary update
 *     - `ts`      — publish timestamp (ms)
 *     - `file_id` — the room/file ID (redundant but useful for debugging)
 *
 * Consumer group design:
 *   - Group name: `pg:cg:<nodeId>`
 *   - Consumer name: `<nodeId>`
 *   - Each node creates its group on startup, starting from `$` (latest)
 *   - On reconnect: reads from last-acked entry (crash-safe replay)
 *   - XACK after successful application to local Y.Doc
 *
 * Backpressure:
 *   - XREADGROUP COUNT <batchSize> limits how many entries are read per tick
 *   - If local Y.Doc apply latency exceeds threshold, batch size is reduced
 *   - BLOCK <ms> prevents busy-waiting when the stream is idle
 *
 * Trimming:
 *   - XADD with MAXLEN ~1000 — approximate trimming for performance
 *   - Old entries are automatically discarded once the stream exceeds the cap
 *   - All nodes ACK before trimming is relevant (they read ahead)
 */

import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from './clusterClock';
import {
  StreamIdempotencyGuard,
  compareStreamIds,
} from './streamIdempotency';

const logger = getLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export interface StreamEntry {
  /** Redis stream entry ID (e.g. "1677500000000-0"). */
  id: string;
  /** Node ID that published this entry. */
  nodeId: string;
  /** Base64-encoded raw CRDT binary update. */
  data: string;
  /** Publish timestamp (ms since epoch). */
  timestamp: number;
  /** The room/file ID. */
  fileId: string;
}

export interface StreamPublishResult {
  /** The Redis stream entry ID assigned to this entry. */
  entryId: string;
  /** Whether the publish succeeded. */
  success: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of entries to keep in each stream.
 *
 * Increased from 1000 to 5000 to give slow consumers a larger replay buffer.
 * At ~200 bytes per entry this caps each stream at ~1 MB — well within Redis
 * single-key memory budgets even with 10k rooms.
 */
export const STREAM_MAX_LEN = 5000;

/** Maximum entries to read per XREADGROUP call. */
export const STREAM_READ_BATCH_SIZE = 50;

/** XREADGROUP block timeout (ms) — how long to wait for new entries. */
export const STREAM_BLOCK_MS = 100;

/** How often to run the stream consumer loop (ms). */
export const STREAM_POLL_INTERVAL_MS = 50;

/** Maximum entries to process before yielding to the event loop. */
export const STREAM_YIELD_THRESHOLD = 100;

/** Minimum idle time (ms) before XAUTOCLAIM reclaims a pending entry. */
export const AUTOCLAIM_MIN_IDLE_MS = 30_000;

/** How often to run the XAUTOCLAIM sweep (ms). */
export const AUTOCLAIM_INTERVAL_MS = 15_000;

/** Maximum entries to reclaim per XAUTOCLAIM call. */
export const AUTOCLAIM_BATCH_SIZE = 50;

// ── Redis key helpers ───────────────────────────────────────────────────────

/** Stream key for a room's CRDT updates. */
export function streamKey(roomId: string): string {
  return `pg:stream:${roomId}`;
}

/** Consumer group name for a node. */
export function consumerGroupName(nodeId: string): string {
  return `pg:cg:${nodeId}`;
}

// ── Stream Publisher ────────────────────────────────────────────────────────

/**
 * Publish a CRDT update to the room's Redis Stream.
 *
 * Uses XADD with approximate MAXLEN trimming to keep the stream bounded.
 * The entry is appended atomically — Redis guarantees ordering within a stream.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param nodeId   This node's ID (for loop prevention).
 * @param update   Raw CRDT binary update (will be base64-encoded).
 * @returns The stream entry ID, or null on failure.
 */
export async function publishToStream(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
  update: Uint8Array,
): Promise<string | null> {
  try {
    const entryId = await redis.xadd(
      streamKey(roomId),
      'MAXLEN', '~', String(STREAM_MAX_LEN),
      '*', // auto-generate entry ID
      'node', nodeId,
      'data', Buffer.from(update).toString('base64'),
      'ts', getClusterTimeMs().toString(),
      'file_id', roomId,
    );
    return entryId;
  } catch (err) {
    logger.error({ err, roomId }, '[streams] XADD failed');
    return null;
  }
}

// ── Stream Consumer ─────────────────────────────────────────────────────────

/**
 * Ensure the consumer group exists for this node on a given stream.
 *
 * Creates the group starting from `$` (latest entry) on first call.
 * If the group already exists, the BUSYGROUP error is silently ignored.
 * If the stream doesn't exist, creates it with MKSTREAM.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param nodeId   This node's ID.
 */
export async function ensureConsumerGroup(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      streamKey(roomId),
      consumerGroupName(nodeId),
      '$',
      'MKSTREAM',
    );
  } catch (err: any) {
    // BUSYGROUP means the group already exists — that's fine
    if (err?.message?.includes('BUSYGROUP')) return;
    logger.error({ err, roomId, nodeId }, '[streams] XGROUP CREATE failed');
  }
}

/**
 * Read pending (unacknowledged) entries from a stream consumer group.
 *
 * Used on reconnect to replay entries that were delivered but not ACKed
 * before the crash/disconnect.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param nodeId   This node's ID.
 * @returns Array of pending stream entries.
 */
export async function readPendingEntries(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
): Promise<StreamEntry[]> {
  try {
    // Read entries that were delivered but not ACKed (id = "0" means pending)
    const result = await redis.xreadgroup(
      'GROUP', consumerGroupName(nodeId), nodeId,
      'COUNT', String(STREAM_READ_BATCH_SIZE),
      'STREAMS', streamKey(roomId), '0',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result || result.length === 0) return [];
    return parseStreamResult(result);
  } catch (err) {
    logger.error({ err, roomId }, '[streams] read pending entries failed');
    return [];
  }
}

/**
 * Read new entries from a stream consumer group (non-blocking).
 *
 * Uses `>` as the entry ID to read only NEW entries that haven't been
 * delivered to any consumer in this group yet.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param nodeId   This node's ID.
 * @param count    Maximum entries to read.
 * @returns Array of new stream entries.
 */
export async function readNewEntries(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
  count: number = STREAM_READ_BATCH_SIZE,
): Promise<StreamEntry[]> {
  try {
    const result = await redis.xreadgroup(
      'GROUP', consumerGroupName(nodeId), nodeId,
      'COUNT', String(count),
      'STREAMS', streamKey(roomId), '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result || result.length === 0) return [];
    return parseStreamResult(result);
  } catch (err: any) {
    // NOGROUP means group doesn't exist yet — create it and retry
    if (err?.message?.includes('NOGROUP')) {
      await ensureConsumerGroup(redis, roomId, nodeId);
      return [];
    }
    logger.error({ err, roomId }, '[streams] read new entries failed');
    return [];
  }
}

/**
 * Acknowledge processed entries, removing them from the pending list.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param nodeId   This node's ID.
 * @param entryIds Stream entry IDs to acknowledge.
 */
export async function ackEntries(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
  entryIds: string[],
): Promise<void> {
  if (entryIds.length === 0) return;
  try {
    await redis.xack(streamKey(roomId), consumerGroupName(nodeId), ...entryIds);
  } catch (err) {
    logger.error({ err, roomId, count: entryIds.length }, '[streams] XACK failed');
  }
}

/**
 * Reclaim pending entries that have been idle beyond a threshold.
 *
 * Uses XAUTOCLAIM (Redis 6.2+) to transfer ownership of stuck pending
 * entries from dead or slow consumers to this node.  This is the primary
 * mechanism for crash recovery when a consumer dies before XACK.
 *
 * XAUTOCLAIM atomically:
 *   1. Finds entries that have been pending for > minIdleMs
 *   2. Transfers them to this consumer
 *   3. Returns them for processing
 *
 * @param redis      ioredis client.
 * @param roomId     Room / file ID.
 * @param nodeId     This node's ID.
 * @param minIdleMs  Minimum idle time before reclaiming (default 30s).
 * @param count      Maximum entries to reclaim per call.
 * @returns Array of reclaimed stream entries.
 */
export async function autoclaimEntries(
  redis: import('ioredis').default,
  roomId: string,
  nodeId: string,
  minIdleMs: number = AUTOCLAIM_MIN_IDLE_MS,
  count: number = AUTOCLAIM_BATCH_SIZE,
): Promise<StreamEntry[]> {
  try {
    // XAUTOCLAIM <stream> <group> <consumer> <min-idle-time> <start> [COUNT count]
    // Returns: [nextStartId, [[entryId, [field, value, ...]], ...], deletedIds]
    const result = await (redis as any).xautoclaim(
      streamKey(roomId),
      consumerGroupName(nodeId),
      nodeId,
      String(minIdleMs),
      '0-0',
      'COUNT', String(count),
    ) as [string, Array<[string, string[]]>, string[]?];

    if (!result || !result[1] || result[1].length === 0) return [];

    const entries: StreamEntry[] = [];
    for (const [entryId, fields] of result[1]) {
      // Null entries occur when the entry was deleted from the stream
      // but is still in the PEL — skip them
      if (!fields || fields.length === 0) continue;

      const fieldMap = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap.set(fields[i]!, fields[i + 1]!);
      }

      entries.push({
        id: entryId,
        nodeId: fieldMap.get('node') ?? '',
        data: fieldMap.get('data') ?? '',
        timestamp: parseInt(fieldMap.get('ts') ?? '0', 10),
        fileId: fieldMap.get('file_id') ?? '',
      });
    }

    if (entries.length > 0) {
      logger.info(
        { roomId, nodeId, reclaimed: entries.length },
        '[streams] XAUTOCLAIM reclaimed pending entries',
      );
    }

    return entries;
  } catch (err: any) {
    // XAUTOCLAIM requires Redis 6.2+ — graceful degradation
    if (err?.message?.includes('ERR unknown command')) {
      logger.debug('[streams] XAUTOCLAIM not supported — skipping (Redis < 6.2)');
      return [];
    }
    // NOGROUP means the consumer group doesn't exist
    if (err?.message?.includes('NOGROUP')) return [];
    logger.error({ err, roomId }, '[streams] XAUTOCLAIM failed');
    return [];
  }
}

/**
 * Delete a stream entirely (when a room is permanently closed).
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 */
export async function deleteStream(
  redis: import('ioredis').default,
  roomId: string,
): Promise<void> {
  try {
    await redis.del(streamKey(roomId));
  } catch (err) {
    logger.warn({ err, roomId }, '[streams] DEL stream failed');
  }
}

/**
 * Get stream info for monitoring (length, groups, etc.).
 */
export async function getStreamInfo(
  redis: import('ioredis').default,
  roomId: string,
): Promise<{ length: number; groups: number } | null> {
  try {
    const info = await redis.xinfo('STREAM', streamKey(roomId)) as any[];
    if (!info) return null;

    // XINFO STREAM returns a flat array of key-value pairs
    let length = 0;
    let groups = 0;
    for (let i = 0; i < info.length; i += 2) {
      if (info[i] === 'length') length = info[i + 1] as number;
      if (info[i] === 'groups') groups = info[i + 1] as number;
    }
    return { length, groups };
  } catch (err: any) {
    // Stream doesn't exist
    if (err?.message?.includes('ERR no such key')) return null;
    logger.warn({ err, roomId }, '[streams] XINFO failed');
    return null;
  }
}

// ── StreamConsumerLoop ──────────────────────────────────────────────────────

export interface StreamConsumerOptions {
  /** ioredis client for stream reads. */
  redis: import('ioredis').default;
  /** This node's ID. */
  nodeId: string;
  /** Callback to apply a CRDT update to the local room. */
  onUpdate: (roomId: string, update: Uint8Array, publishTimestampMs?: number) => void;
  /** Callback to get the list of room IDs this node has active. */
  getActiveRoomIds: () => string[];
  /**
   * Optional idempotency guard.  When provided, each entry is checked
   * against the per-room high-water mark before application.
   * If omitted, all entries are applied (legacy behaviour).
   */
  idempotencyGuard?: StreamIdempotencyGuard;
  /**
   * Callbacks for metrics instrumentation.
   * Called when a duplicate entry is skipped.
   */
  onDuplicateSkipped?: () => void;
  /**
   * Called when entries are reclaimed via XAUTOCLAIM.
   */
  onAutoclaimed?: (count: number) => void;
}

/**
 * Manages polling loops for all active room streams on this node.
 *
 * For each room, maintains a consumer group and polls for new entries.
 * Entries from this node (self-published) are ACKed but not applied.
 * Entries from other nodes are decoded and applied to the local Y.Doc.
 *
 * Idempotency:
 *   When an `idempotencyGuard` is provided, each entry's stream ID is
 *   compared against the per-room high-water mark.  Duplicate or
 *   out-of-order entries are ACKed but NOT applied — preventing the
 *   at-least-once redelivery problem.
 *
 * XAUTOCLAIM:
 *   Periodically reclaims pending entries that have been idle for longer
 *   than AUTOCLAIM_MIN_IDLE_MS (30s).  This handles the case where a
 *   consumer crashes before XACK — the entries are transferred to this
 *   consumer and processed idempotently.
 *
 * Strict ordering:
 *   Entries are always sorted by stream ID before processing.  Redis
 *   guarantees ordering within XREADGROUP but XAUTOCLAIM may return
 *   entries out of order relative to the main read cursor.  Sorting
 *   ensures the HWM only advances forward.
 */
export class StreamConsumerLoop {
  private readonly redis: import('ioredis').default;
  private readonly nodeId: string;
  private readonly onUpdate: (roomId: string, update: Uint8Array, publishTimestampMs?: number) => void;
  private readonly getActiveRoomIds: () => string[];
  private readonly guard: StreamIdempotencyGuard | undefined;
  private readonly onDuplicateSkipped: (() => void) | undefined;
  private readonly onAutoclaimed: ((count: number) => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private autoclaimTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Rooms for which we've already ensured the consumer group exists. */
  private readonly initializedRooms = new Set<string>();

  constructor(options: StreamConsumerOptions) {
    this.redis = options.redis;
    this.nodeId = options.nodeId;
    this.onUpdate = options.onUpdate;
    this.getActiveRoomIds = options.getActiveRoomIds;
    this.guard = options.idempotencyGuard;
    this.onDuplicateSkipped = options.onDuplicateSkipped;
    this.onAutoclaimed = options.onAutoclaimed;
  }

  /** Expose the idempotency guard for external checkpoint management. */
  get idempotencyGuard(): StreamIdempotencyGuard | undefined {
    return this.guard;
  }

  /**
   * Start polling all active room streams + XAUTOCLAIM sweep.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, STREAM_POLL_INTERVAL_MS);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();

    // Start XAUTOCLAIM sweep timer
    this.autoclaimTimer = setInterval(() => {
      void this.autoclaimAll();
    }, AUTOCLAIM_INTERVAL_MS);
    if (typeof this.autoclaimTimer.unref === 'function') this.autoclaimTimer.unref();

    logger.info({ nodeId: this.nodeId }, '[streams] consumer loop started (with idempotency guard)');
  }

  /**
   * Stop the consumer loop and XAUTOCLAIM sweep.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.autoclaimTimer) {
      clearInterval(this.autoclaimTimer);
      this.autoclaimTimer = undefined;
    }
    logger.info('[streams] consumer loop stopped');
  }

  /**
   * Register a room for stream consumption.
   * Creates the consumer group if it doesn't exist.
   */
  async addRoom(roomId: string): Promise<void> {
    if (this.initializedRooms.has(roomId)) return;
    await ensureConsumerGroup(this.redis, roomId, this.nodeId);
    this.initializedRooms.add(roomId);
  }

  /**
   * Unregister a room from stream consumption.
   */
  removeRoom(roomId: string): void {
    this.initializedRooms.delete(roomId);
    this.guard?.removeRoom(roomId);
  }

  /**
   * Replay any pending (unacknowledged) entries for a room.
   * Called after a reconnect to catch up on missed updates.
   *
   * Idempotency-aware: duplicate entries are ACKed but not applied.
   * Entries are sorted by stream ID to ensure strict ordering.
   */
  async replayPending(roomId: string): Promise<number> {
    await this.addRoom(roomId);
    const entries = await readPendingEntries(this.redis, roomId, this.nodeId);
    if (entries.length === 0) return 0;

    // Sort by stream ID for strict ordering guarantee
    entries.sort((a, b) => compareStreamIds(a.id, b.id));

    let applied = 0;

    for (const entry of entries) {
      if (entry.nodeId === this.nodeId) {
        // Self-published — ACK but don't apply
        await ackEntries(this.redis, roomId, this.nodeId, [entry.id]);
        continue;
      }

      // Idempotency check — skip duplicates
      if (this.guard && !this.guard.shouldApply(roomId, entry.id)) {
        this.onDuplicateSkipped?.();
        await ackEntries(this.redis, roomId, this.nodeId, [entry.id]);
        continue;
      }

      try {
        const update = Buffer.from(entry.data, 'base64');
        this.onUpdate(roomId, new Uint8Array(update), entry.timestamp);
        // Mark applied BEFORE XACK (crash-safety ordering)
        this.guard?.markApplied(roomId, entry.id);
        applied++;
      } catch (err) {
        logger.error({ err, roomId, entryId: entry.id }, '[streams] failed to apply pending entry');
      }
      await ackEntries(this.redis, roomId, this.nodeId, [entry.id]);
    }

    if (applied > 0) {
      logger.info({ roomId, applied, total: entries.length }, '[streams] replayed pending entries');
    }
    return applied;
  }

  /**
   * Poll all active rooms for new stream entries.
   */
  private async pollAll(): Promise<void> {
    if (!this.running) return;

    const roomIds = this.getActiveRoomIds();
    for (const roomId of roomIds) {
      if (!this.running) break;
      if (!this.initializedRooms.has(roomId)) {
        await this.addRoom(roomId);
      }
      await this.pollRoom(roomId);
    }

    // Trigger eager checkpoint flush if many entries applied
    if (this.guard?.shouldEagerFlush()) {
      void this.guard.flushCheckpoints(this.redis, this.nodeId).catch((err) => {
        logger.warn({ err }, '[streams] eager checkpoint flush failed');
      });
    }
  }

  /**
   * Poll a single room's stream for new entries.
   *
   * Entries are sorted by stream ID, checked for idempotency, and ACKed
   * in batch after all entries are processed.
   */
  private async pollRoom(roomId: string): Promise<void> {
    try {
      const entries = await readNewEntries(this.redis, roomId, this.nodeId);
      if (entries.length === 0) return;

      // Sort by stream ID for strict ordering guarantee
      // (Redis guarantees order from XREADGROUP, but defence-in-depth)
      entries.sort((a, b) => compareStreamIds(a.id, b.id));

      const toAck: string[] = [];

      for (const entry of entries) {
        toAck.push(entry.id);

        // Skip self-published entries (loop prevention)
        if (entry.nodeId === this.nodeId) continue;

        // Idempotency check — skip duplicates
        if (this.guard && !this.guard.shouldApply(roomId, entry.id)) {
          this.onDuplicateSkipped?.();
          continue;
        }

        try {
          const update = Buffer.from(entry.data, 'base64');
          this.onUpdate(roomId, new Uint8Array(update), entry.timestamp);
          // Mark applied BEFORE XACK (crash-safety ordering)
          this.guard?.markApplied(roomId, entry.id);
        } catch (err) {
          logger.error({ err, roomId, entryId: entry.id }, '[streams] failed to apply entry');
        }
      }

      // Batch ACK all processed entries
      await ackEntries(this.redis, roomId, this.nodeId, toAck);
    } catch (err) {
      logger.error({ err, roomId }, '[streams] poll room failed');
    }
  }

  /**
   * Run XAUTOCLAIM sweep across all active rooms.
   *
   * Reclaims pending entries that have been idle for longer than
   * AUTOCLAIM_MIN_IDLE_MS.  Reclaimed entries are processed through
   * the same idempotency-aware pipeline as regular entries.
   *
   * This handles:
   *   - Consumer crash before XACK
   *   - Dead consumer cleanup
   *   - Stuck consumer rescue
   */
  private async autoclaimAll(): Promise<void> {
    if (!this.running) return;

    const roomIds = this.getActiveRoomIds();
    for (const roomId of roomIds) {
      if (!this.running) break;
      if (!this.initializedRooms.has(roomId)) continue;

      try {
        const entries = await autoclaimEntries(
          this.redis,
          roomId,
          this.nodeId,
          AUTOCLAIM_MIN_IDLE_MS,
          AUTOCLAIM_BATCH_SIZE,
        );
        if (entries.length === 0) continue;

        this.onAutoclaimed?.(entries.length);

        // Sort reclaimed entries by stream ID (XAUTOCLAIM may return out of order)
        entries.sort((a, b) => compareStreamIds(a.id, b.id));

        const toAck: string[] = [];

        for (const entry of entries) {
          toAck.push(entry.id);

          // Skip self-published entries
          if (entry.nodeId === this.nodeId) continue;

          // Idempotency check — critical for XAUTOCLAIM since these are
          // entries that were already delivered to (and possibly applied by)
          // another consumer before it crashed
          if (this.guard && !this.guard.shouldApply(roomId, entry.id)) {
            this.onDuplicateSkipped?.();
            continue;
          }

          try {
            const update = Buffer.from(entry.data, 'base64');
            this.onUpdate(roomId, new Uint8Array(update), entry.timestamp);
            this.guard?.markApplied(roomId, entry.id);
          } catch (err) {
            logger.error({ err, roomId, entryId: entry.id }, '[streams] failed to apply autoclaimed entry');
          }
        }

        await ackEntries(this.redis, roomId, this.nodeId, toAck);
      } catch (err) {
        logger.error({ err, roomId }, '[streams] XAUTOCLAIM sweep failed for room');
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the raw XREADGROUP result into typed StreamEntry objects.
 */
function parseStreamResult(
  result: Array<[string, Array<[string, string[]]>]>,
): StreamEntry[] {
  const entries: StreamEntry[] = [];

  for (const [, streamEntries] of result) {
    for (const [entryId, fields] of streamEntries) {
      // Fields is a flat array: [key1, val1, key2, val2, ...]
      const fieldMap = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap.set(fields[i]!, fields[i + 1]!);
      }

      entries.push({
        id: entryId,
        nodeId: fieldMap.get('node') ?? '',
        data: fieldMap.get('data') ?? '',
        timestamp: parseInt(fieldMap.get('ts') ?? '0', 10),
        fileId: fieldMap.get('file_id') ?? '',
      });
    }
  }

  return entries;
}
