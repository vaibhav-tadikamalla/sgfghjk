import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';
import { getLogger } from '../utils/logger';
import { Room } from './Room';
import type { RoomStore } from './RoomStore';
import {
  redisPubsubMessagesCounter,
  roomLockContentionCounter,
  roomsOwnedGauge,
} from '../metrics/metrics';
import {
  reconcileChannel,
  RECONCILE_BROADCAST_CHANNEL,
  buildReconcileRequest,
  handleReconcileRequest,
  applyReconcileResponse,
  recordPartitionEvent,
  type ReconcileMessage,
  type ReconcileRequest as ReconcileRequestType,
  type ReconcileResponse as ReconcileResponseType,
} from './redisReconciliation';
import {
  ClusterMembership,
  TOPOLOGY_CHANGE_CHANNEL,
  type ClusterTopologyEvent,
} from './consistentHash';
import {
  publishToStream,
  StreamConsumerLoop,
  streamKey,
} from './redisStreams';
import { StreamIdempotencyGuard } from './streamIdempotency';
import { getClusterTimeMs, startClusterClock, stopClusterClock, resyncClusterClock, getClockSnapshot } from './clusterClock';
import {
  PresenceRateLimiter,
  LocalPresenceStore,
  publishPresenceUpdate,
  removePresenceFromRedis,
  presencePubsubChannel,
  type PresenceEnvelope,
  type PresenceData,
} from './presenceService';
import {
  topologyChangesCounter,
  clusterNodesGauge,
  streamMessagesPublished,
  streamMessagesConsumed,
  presenceRateLimitDrops,
  presenceActiveEntries,
  streamDuplicatesSkipped,
  streamAutoclaimedEntries,
  streamIdempotencyGuardRooms,
  clusterClockDriftMs,
  clusterClockRequestsTotal,
  clusterClockFallbackActive,
} from '../metrics/advancedMetrics';

// ─────────────────────────────────────────────────────────────────────────────
// Redis key / channel helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Distributed creation lock — held while factory() is running on any node. */
function lockKey(fileId: string): string {
  return `room_lock:${fileId}`;
}

/**
 * Ownership marker — stores the nodeId that created the room.
 * Used by other nodes to detect that the room already exists elsewhere
 * before attempting their own factory() call.
 */
function ownerKey(fileId: string): string {
  return `room_owner:${fileId}`;
}

/** Pub/Sub channel — published when a node deletes a room. */
function invalidateChannel(fileId: string): string {
  return `room_invalidate:${fileId}`;
}

/** Pub/Sub channel — carriers real-time awareness (cursor/selection) updates across nodes. */
function presenceChannel(fileId: string): string {
  return `presence:${fileId}`;
}

/** Normalize a host/base URL into a websocket URL that terminates at /ws. */
function toWebsocketUrl(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length === 0) return trimmed;

  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    const url = new URL(trimmed);
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
    return url.toString();
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
    return url.toString();
  }

  const url = new URL(`wss://${trimmed}`);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** How long the creation lock is held.  Acts as a dead-man timer if a node crashes mid-factory. */
const LOCK_TTL_MS = 30_000;
/** Total time to attempt acquiring the lock before running factory() in fallback mode. */
const LOCK_TIMEOUT_MS = 2_000;
/** Initial backoff delay (doubles each attempt, capped at BACKOFF_MAX_MS). */
const BACKOFF_BASE_MS = 10;
/** Maximum single backoff delay. */
const BACKOFF_MAX_MS = 1_000;
/** TTL for the ownership key — refreshed by the heartbeat while the room is alive. */
const OWNER_TTL_SEC = 300; // 5 minutes
/** How often the ownership key is refreshed in Redis. */
const HEARTBEAT_INTERVAL_MS = 60_000;
const FORWARD_WRITE_TIMEOUT_MS = 5_000;

function forwardWriteChannel(nodeId: string): string {
  return `pg:forward_write:${nodeId}`;
}

function forwardWriteAckChannel(nodeId: string): string {
  return `pg:forward_write_ack:${nodeId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface RedisRoomStoreOptions {
  /**
   * ioredis connection URL (e.g. `redis://localhost:6379`).
   * Defaults to `process.env.REDIS_URL ?? 'redis://localhost:6379'`.
   */
  redisUrl?: string;
  /**
   * Inject pre-constructed ioredis clients directly.
   * When provided, `redisUrl` is ignored and the store will NOT call
   * `quit()` on them during `close()`.
   */
  clients?: { redis: Redis; subscriber: Redis };
}

export interface ForwardedWriteRequest {
  requestId: string;
  fileId: string;
  sourceNodeId: string;
  sourceConnectionId: string;
  updateBase64: string;
  timestampMs: number;
}

export interface ForwardedWriteResult {
  success: boolean;
  seq?: bigint;
  error?: string;
}

interface ForwardedWriteAck {
  requestId: string;
  sourceConnectionId: string;
  success: boolean;
  seq?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RedisRoomStore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distributed implementation of RoomStore backed by Redis for coordination.
 *
 * ## What Redis stores
 * Redis is used **only for coordination**, never for Yjs document state:
 *
 * | Key                        | Purpose                                         |
 * |----------------------------|-------------------------------------------------|
 * | `room_lock:<fileId>`       | SET NX PX lock — prevents thundering-herd creation |
 * | `room_owner:<fileId>`      | nodeId that created this room                   |
 * | `room_invalidate:<fileId>` | Pub/Sub channel — signals remote room deletion   |
 * | `presence:<fileId>`        | Pub/Sub channel — cross-node awareness fan-out   |
 *
 * ## What stays in memory
 * Room objects (containing Yjs Y.Doc + awareness state) are always held in a
 * process-local Map.  They cannot be serialised to Redis.  Each node that needs
 * a room creates its own local instance from the PostgreSQL persistence layer.
 *
 * ## Cross-node coalescing
 * When `getOrCreate` is called concurrently from multiple nodes for the same
 * `fileId`, only the node that wins the Redis lock runs `factory()` immediately.
 * Other nodes wait up to `LOCK_TIMEOUT_MS` for the lock to release, then run
 * their own `factory()` as a fallback (ensuring the room is always available
 * locally, even if the lock-winning node crashed).
 *
 * ## Invalidation
 * When `delete(fileId)` is called, a message is published to
 * `room_invalidate:<fileId>`.  All nodes (including the caller) that hold a
 * local copy of that room will destroy it.  Nodes subscribe to the pattern
 * `room_invalidate:*` via the dedicated subscriber connection on construction.
 */
export class RedisRoomStore implements RoomStore {
  /** Unique identifier for this server process / node. */
  private readonly nodeId: string = randomUUID();

  /** Process-local room instances.  Source of truth for this node. */
  private readonly rooms = new Map<string, Room>();

  /**
   * In-flight creation promises — coalesce concurrent calls on THIS node.
   * Cross-node coalescing is handled by the Redis lock.
   */
  private readonly creationLocks = new Map<string, Promise<Room>>();

  private readonly redis: Redis;
  private readonly sub: Redis;
  /** Whether we own the Redis clients and should quit them on close(). */
  private readonly ownsClients: boolean;
  /** Periodic heartbeat timers that refresh room_owner keys. */
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Set of fileIds for which this node currently holds the Redis ownership key.
   * Used to drive roomsOwnedGauge without risk of negative drift. */
  private readonly ownedRooms = new Set<string>();

  /**
   * Called by the collaboration server when an awareness update arrives from
   * a remote node via the `presence:<fileId>` Pub/Sub channel.
   * Set from websocket.ts after construction (only wired when ROOM_STORE=redis).
   */
  onRemotePresence: ((fileId: string, rawMsg: Uint8Array) => void) | undefined = undefined;

  /** Whether a reconciliation round is currently in progress. */
  private _reconciling = false;

  // ── UPGRADE 1: Cluster membership + consistent hashing ────────────────────
  /** Manages node registration, heartbeat, and the consistent hash ring. */
  private readonly cluster: ClusterMembership;

  // ── UPGRADE 2: Redis Streams consumer loop ────────────────────────────────
  /** Durable event log consumer — polls room streams for CRDT updates. */
  private streamConsumer: StreamConsumerLoop | undefined;
  /** Callback invoked when a remote CRDT update arrives via Redis Streams. */
  onRemoteStreamUpdate:
    | ((fileId: string, update: Uint8Array, publishTimestampMs?: number) => void)
    | undefined = undefined;

  /** Callback invoked when another node forwards a client write to this owner node. */
  onForwardedWrite:
    | ((request: ForwardedWriteRequest) => Promise<ForwardedWriteResult>)
    | undefined = undefined;

  /** Rooms explicitly registered for stream polling (owner rooms + edge mirrors). */
  private readonly streamRegisteredRooms = new Set<string>();

  /** In-flight forwarded-write request resolvers waiting for owner ACKs. */
  private readonly pendingForwardAcks = new Map<
    string,
    {
      resolve: (value: bigint | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // ── UPGRADE 4: Idempotent stream processing ───────────────────────────────
  /** Tracks per-room high-water marks for duplicate stream entry detection. */
  private readonly idempotencyGuard = new StreamIdempotencyGuard();

  // ── UPGRADE 3: Presence service ───────────────────────────────────────────
  /** Per-connection rate limiter for presence updates. */
  private readonly presenceRateLimiter = new PresenceRateLimiter();
  /** Local in-memory presence store. */
  private readonly presenceStore = new LocalPresenceStore();

  // ── UPGRADE 5: Cluster clock metrics ──────────────────────────────────────
  private _clockMetricsTimer: ReturnType<typeof setInterval> | undefined;
  private _lastClockReqs = 0;
  private _lastClockFails = 0;

  constructor(options: RedisRoomStoreOptions = {}) {
    if (options.clients) {
      this.redis       = options.clients.redis;
      this.sub         = options.clients.subscriber;
      this.ownsClients = false;
    } else {
      const url        = options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
      this.redis       = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
      this.sub         = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
      this.ownsClients = true;
    }

    // UPGRADE 1: Initialize cluster membership with consistent hash ring
    this.cluster = new ClusterMembership(this.nodeId);
    this.cluster.onTopology((event) => {
      topologyChangesCounter.inc({ event_type: event.type });
      clusterNodesGauge.set(event.activeNodes.length);
      getLogger().info(
        { event: event.type, nodeId: event.nodeId, nodes: event.activeNodes.length },
        'RedisRoomStore: topology change applied',
      );
    });

    // UPGRADE 2 + 4: Initialize Redis Streams consumer loop with idempotency guard
    this.streamConsumer = new StreamConsumerLoop({
      redis: this.redis,
      nodeId: this.nodeId,
      onUpdate: (roomId, update, publishTimestampMs) => {
        streamMessagesConsumed.inc();
        try {
          this.onRemoteStreamUpdate?.(roomId, update, publishTimestampMs);
        } catch (err) {
          getLogger().warn({ err, roomId }, 'RedisRoomStore: remote stream update callback failed');
        }
      },
      getActiveRoomIds: () => {
        const active = new Set<string>(this.rooms.keys());
        for (const roomId of this.streamRegisteredRooms) active.add(roomId);
        return [...active];
      },
      idempotencyGuard: this.idempotencyGuard,
      onDuplicateSkipped: () => {
        streamDuplicatesSkipped.inc();
      },
      onAutoclaimed: (count) => {
        streamAutoclaimedEntries.inc(count);
      },
    });
    this.streamConsumer.start();

    // UPGRADE 4: Start periodic HWM checkpoint flushing & load existing checkpoints
    this.idempotencyGuard.startCheckpointTimer(this.redis, this.nodeId);
    void this.idempotencyGuard.loadCheckpoints(this.redis, this.nodeId).catch((err) => {
      getLogger().error({ err }, 'RedisRoomStore: failed to load stream HWM checkpoints');
    });

    // UPGRADE 5: Start cluster clock (Redis TIME authority) — must be
    // before cluster registration so heartbeats use cluster time.
    void startClusterClock(this.redis).then(() => {
      // Periodically update clock drift metrics
      this._clockMetricsTimer = setInterval(() => {
        const snap = getClockSnapshot();
        clusterClockDriftMs.set(snap.driftMs);
        clusterClockRequestsTotal.inc({ status: 'ok' }, snap.totalRequests - (this._lastClockReqs ?? 0));
        clusterClockRequestsTotal.inc({ status: 'error' }, snap.totalFailures - (this._lastClockFails ?? 0));
        clusterClockFallbackActive.set(snap.usingFallback ? 1 : 0);
        this._lastClockReqs = snap.totalRequests;
        this._lastClockFails = snap.totalFailures;
      }, 5_000);
      if (typeof this._clockMetricsTimer.unref === 'function') this._clockMetricsTimer.unref();
    }).catch((err) => {
      getLogger().error({ err }, 'RedisRoomStore: cluster clock start failed');
    });

    // Register cluster membership (async — non-blocking)
    void this.cluster.register(this.redis).catch((err) => {
      getLogger().error({ err }, 'RedisRoomStore: cluster registration failed');
    });

    this._subscribeToChannels();
  }

  // ── RoomStore ──────────────────────────────────────────────────────────────

  get(fileId: string): Room | undefined {
    return this.rooms.get(fileId);
  }

  async getOrCreate(fileId: string, factory: () => Promise<Room>): Promise<Room> {
    // Fast path — room already exists locally and is not being torn down
    const existing = this.rooms.get(fileId);
    if (existing) {
      if (existing.state !== 'destroying') return existing;
      this.rooms.delete(fileId);
    }

    // In-process coalescing — reuse any in-flight factory promise on this node
    const inflight = this.creationLocks.get(fileId);
    if (inflight) return inflight;

    // Distributed lock — prevents thundering herd across nodes
    const promise = this._createWithLock(fileId, factory)
      .finally(() => {
        this.creationLocks.delete(fileId);
      });

    this.creationLocks.set(fileId, promise);
    return promise;
  }

  delete(fileId: string): void {
    this._stopHeartbeat(fileId);
    if (this.ownedRooms.delete(fileId)) roomsOwnedGauge.set(this.ownedRooms.size);
    this.rooms.delete(fileId);
    // Publish invalidation so all nodes (including this one) drop their copy.
    // Fire-and-forget — failure to publish is non-fatal (room is already gone locally).
    this.redis.publish(invalidateChannel(fileId), this.nodeId).catch((err) => {
      getLogger().warn({ err, fileId }, 'RedisRoomStore: failed to publish invalidation');
    });
    // Remove ownership marker
    this.redis.del(ownerKey(fileId)).catch((err) => {
      getLogger().warn({ err, fileId }, 'RedisRoomStore: failed to delete owner key');
    });
  }

  list(): IterableIterator<Room> {
    return this.rooms.values();
  }

  getAll(): IterableIterator<[string, Room]> {
    return this.rooms.entries();
  }

  get size(): number {
    return this.rooms.size;
  }

  /**
   * Publish a local awareness update to Redis so remote nodes can fan it out
   * to their own connected clients.
   *
   * The `rawMsg` is the full MSG_AWARENESS-prefixed Uint8Array (identical to
   * what was received from the originating WebSocket client).
   *
   * Fire-and-forget — a publish failure is non-fatal; the update is simply
   * not forwarded cross-node for this frame.
   */
  publishPresence(fileId: string, connectionId: string, rawMsg: Uint8Array): void {
    // UPGRADE 3: Rate-limit presence updates per connection
    if (!this.presenceRateLimiter.allow(connectionId)) {
      presenceRateLimitDrops.inc();
      return;
    }

    const payload = JSON.stringify({
      nodeId:       this.nodeId,
      connectionId,
      update:       Buffer.from(rawMsg).toString('base64'),
    });
    this.redis.publish(presenceChannel(fileId), payload).catch((err) => {
      getLogger().debug({ err, fileId }, 'RedisRoomStore: failed to publish presence update');
    });
    getLogger().debug({ fileId, connectionId }, 'presence update forwarded to redis');
  }

  /**
   * UPGRADE 2: Publish a CRDT update to the room's Redis Stream.
   *
   * Called after the WAL append succeeds.  The stream provides durable
   * cross-node propagation with backpressure and replay capability.
   */
  async publishStreamUpdate(fileId: string, update: Uint8Array): Promise<string | null> {
    const entryId = await publishToStream(this.redis, fileId, this.nodeId, update);
    if (entryId) streamMessagesPublished.inc();
    return entryId;
  }

  async forwardWriteToOwner(
    fileId: string,
    sourceConnectionId: string,
    update: Uint8Array,
    ownerNodeId?: string,
  ): Promise<bigint | null> {
    const targetNodeId = ownerNodeId ?? this.getRoomOwner(fileId);
    if (!targetNodeId || targetNodeId === this.nodeId) return null;

    const requestId = randomUUID();
    const payload: ForwardedWriteRequest = {
      requestId,
      fileId,
      sourceNodeId: this.nodeId,
      sourceConnectionId,
      updateBase64: Buffer.from(update).toString('base64'),
      timestampMs: getClusterTimeMs(),
    };

    const pending = new Promise<bigint | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingForwardAcks.delete(requestId);
        resolve(null);
      }, FORWARD_WRITE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      this.pendingForwardAcks.set(requestId, { resolve, timer });
    });

    const published = await this.redis.publish(forwardWriteChannel(targetNodeId), JSON.stringify(payload));
    if (published <= 0) {
      const inflight = this.pendingForwardAcks.get(requestId);
      if (inflight) {
        clearTimeout(inflight.timer);
        this.pendingForwardAcks.delete(requestId);
        inflight.resolve(null);
      }
      return null;
    }

    return pending;
  }

  /**
   * UPGRADE 2: Register a room with the stream consumer for polling.
   */
  async registerRoomStream(fileId: string): Promise<void> {
    if (this.streamConsumer) {
      this.streamRegisteredRooms.add(fileId);
      await this.streamConsumer.addRoom(fileId);
      streamIdempotencyGuardRooms.set(this.idempotencyGuard.trackedRooms);
    }
  }

  /**
   * UPGRADE 2: Unregister a room from the stream consumer.
   * Also cleans up the idempotency HWM checkpoint.
   */
  unregisterRoomStream(fileId: string): void {
    this.streamRegisteredRooms.delete(fileId);
    if (this.streamConsumer) {
      this.streamConsumer.removeRoom(fileId);
    }
    // UPGRADE 4: Clean up idempotency checkpoint
    void this.idempotencyGuard.removeCheckpoint(this.redis, this.nodeId, fileId).catch((err) => {
      getLogger().warn({ err, fileId }, 'RedisRoomStore: failed to remove HWM checkpoint');
    });
    streamIdempotencyGuardRooms.set(this.idempotencyGuard.trackedRooms);
  }

  /**
   * UPGRADE 1: Check if this node is the consistent-hash owner for a room.
   */
  isRoomOwner(roomId: string): boolean {
    return this.cluster.isOwner(roomId);
  }

  /**
   * UPGRADE 1: Get the owner node ID for a room.
   */
  getRoomOwner(roomId: string): string | undefined {
    return this.cluster.getOwner(roomId);
  }

  /**
   * Resolve affinity routing target for a room using the current hash ring.
   *
   * Ownership remains correct across node join/leave/rebalance because the
   * ring is updated by ClusterMembership topology events.
   */
  async getRoomRoute(roomId: string): Promise<{
    roomId: string;
    ownerNodeId: string | null;
    ownerAddress: string | null;
    websocketUrl: string | null;
  }> {
    const ownerNodeId = this.cluster.getOwner(roomId) ?? null;
    if (!ownerNodeId) {
      return {
        roomId,
        ownerNodeId: null,
        ownerAddress: null,
        websocketUrl: null,
      };
    }

    let ownerAddress: string | undefined;
    if (ownerNodeId === this.nodeId) {
      ownerAddress = this.cluster.getNodeAddress();
    }

    if (!ownerAddress) {
      try {
        ownerAddress = await this.cluster.getNodeAddressFor(this.redis, ownerNodeId);
      } catch (err) {
        getLogger().warn({ err, ownerNodeId }, 'RedisRoomStore: failed to resolve owner address');
      }
    }

    return {
      roomId,
      ownerNodeId,
      ownerAddress: ownerAddress ?? null,
      websocketUrl: ownerAddress ? toWebsocketUrl(ownerAddress) : null,
    };
  }

  /**
   * UPGRADE 1: Get this node's ID.
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Admin introspection: cluster topology summary for this node.
   *
   * Returns the node ID, all currently active cluster members visible to this
   * node's consistent-hash ring, the rooms this node owns (heartbeat key held)
   * and the total number of local room objects.
   */
  getClusterIntrospection(): {
    nodeId: string;
    activeNodes: string[];
    ownedRooms: string[];
    totalLocalRooms: number;
  } {
    return {
      nodeId:          this.nodeId,
      activeNodes:     Array.from(this.cluster.getActiveNodes()),
      ownedRooms:      Array.from(this.ownedRooms),
      totalLocalRooms: this.rooms.size,
    };
  }

  /**
   * UPGRADE 3: Get the presence rate limiter (for cleanup on disconnect).
   */
  getPresenceRateLimiter(): PresenceRateLimiter {
    return this.presenceRateLimiter;
  }

  /**
   * UPGRADE 3: Get the local presence store.
   */
  getPresenceStore(): LocalPresenceStore {
    return this.presenceStore;
  }

  /**
   * Gracefully disconnect the Redis clients owned by this store.
   * Must be called during server shutdown if the store was constructed with
   * a `redisUrl` (i.e. not with pre-injected clients).
   */
  async close(): Promise<void> {
    // Clear all heartbeat timers before disconnecting
    for (const [fileId] of this.heartbeatTimers) {
      this._stopHeartbeat(fileId);
    }
    // UPGRADE 2: Stop stream consumer loop
    if (this.streamConsumer) {
      this.streamConsumer.stop();
    }
    // UPGRADE 4: Flush final HWM checkpoints and stop timer
    await this.idempotencyGuard.stopCheckpointTimer(this.redis, this.nodeId);
    // UPGRADE 5: Stop cluster clock background sync and metrics timer
    if (this._clockMetricsTimer) clearInterval(this._clockMetricsTimer);
    stopClusterClock();
    // UPGRADE 1: Deregister from cluster
    await this.cluster.deregister(this.redis).catch((err) => {
      getLogger().warn({ err }, 'RedisRoomStore: cluster deregistration failed');
    });
    // UPGRADE 3: Clean up presence
    this.presenceRateLimiter.clear();
    this.presenceStore.destroy();

    // Resolve any in-flight forwarded write waits.
    for (const [requestId, pending] of this.pendingForwardAcks) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.pendingForwardAcks.delete(requestId);
    }

    if (!this.ownsClients) return;
    await Promise.allSettled([this.redis.quit(), this.sub.quit()]);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Acquire the Redis creation lock for `fileId`, run `factory()`,
   * register ownership, and store the room locally.
   *
   * Throws if the lock cannot be acquired within `LOCK_TIMEOUT_MS`; the error
   * propagates to `getOrCreate`, which lets the caller decide how to handle
   * the unavailability (e.g. return 503 to the client).
   */
  private async _createWithLock(
    fileId: string,
    factory: () => Promise<Room>,
  ): Promise<Room> {
    const key   = lockKey(fileId);
    const value = this.nodeId;

    // Throws LockTimeoutError if the lock cannot be acquired within LOCK_TIMEOUT_MS
    await this._tryAcquireLock(key, value);

    try {
      // Re-check local map — another async path on this node may have raced
      const recheck = this.rooms.get(fileId);
      if (recheck && recheck.state !== 'destroying') return recheck;

      const room = await factory();
      this.rooms.set(fileId, room);
      this.ownedRooms.add(fileId);
      roomsOwnedGauge.set(this.ownedRooms.size);

      // Record ownership + start heartbeat to keep the key alive
      this.redis
        .set(ownerKey(fileId), this.nodeId, 'EX', OWNER_TTL_SEC)
        .catch((err) => {
          getLogger().warn({ err, fileId }, 'RedisRoomStore: failed to set owner key');
        });
      this._startHeartbeat(fileId);

      return room;
    } finally {
      // Release the lock only if we still hold it (Lua script checks ownership
      // before deleting, preventing a slow node from releasing someone else's lock)
      await this._releaseLock(key, value);
    }
  }

  /**
   * Attempt to acquire the lock immediately.  If held by another node, retry
   * with exponential backoff (10 → 20 → 40 → … → 1000 ms) until
   * LOCK_TIMEOUT_MS (~2 s) elapses.
   *
   * @throws {Error} if the lock cannot be acquired before the deadline.
   */
  private async _tryAcquireLock(key: string, value: string): Promise<void> {
    const deadline = getClusterTimeMs() + LOCK_TIMEOUT_MS;
    let delay = BACKOFF_BASE_MS;

    while (getClusterTimeMs() < deadline) {
      // SET key value PX ttl NX — returns 'OK' on success, null when key exists
      const result = await this.redis
        .set(key, value, 'PX', LOCK_TTL_MS, 'NX')
        .catch((): null => null);

      if (result === 'OK') return;

      // Lock was held by another node — record contention before backing off
      roomLockContentionCounter.inc();

      // Don't sleep past the deadline
      const remaining = deadline - getClusterTimeMs();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining, BACKOFF_MAX_MS));
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }

    throw new Error(
      `RedisRoomStore: could not acquire lock "${key}" within ${LOCK_TIMEOUT_MS} ms — ` +
      `another node may be holding it past its expected lock TTL`,
    );
  }

  /**
   * Release the lock using a Lua script that checks ownership before deleting,
   * preventing a slow node from accidentally releasing another node's lock.
   */
  private async _releaseLock(key: string, value: string): Promise<void> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, key, value).catch((err) => {
      getLogger().warn({ err, key }, 'RedisRoomStore: failed to release lock');
    });
  }

  /**
   * Subscribe to all Pub/Sub channels used for cross-node coordination:
   *   - `room_invalidate:*`  — remote room deletion
   *   - `presence:*`         — remote awareness (cursor/selection) fan-out
   *
   * Re-subscribes automatically whenever the subscriber connection reconnects.
   */
  private _subscribeToChannels(): void {
    const subscribe = () => {
      this.sub.psubscribe('room_invalidate:*', (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: psubscribe room_invalidate failed');
      });
      this.sub.psubscribe('presence:*', (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: psubscribe presence failed');
      });
      // UPGRADE 3: Subscribe to dedicated presence channels
      this.sub.psubscribe('pg:presence:channel:*', (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: psubscribe pg:presence:channel failed');
      });
      // UPGRADE 1: Subscribe to topology change channel
      this.sub.subscribe(TOPOLOGY_CHANGE_CHANNEL, (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: subscribe topology change failed');
      });
      // Subscribe to reconciliation channels for partition recovery
      this.sub.subscribe(reconcileChannel(this.nodeId), (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: subscribe reconcile channel failed');
      });
      this.sub.subscribe(RECONCILE_BROADCAST_CHANNEL, (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: subscribe reconcile broadcast failed');
      });
      this.sub.subscribe(forwardWriteChannel(this.nodeId), (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: subscribe forward write channel failed');
      });
      this.sub.subscribe(forwardWriteAckChannel(this.nodeId), (err) => {
        if (err) getLogger().error({ err }, 'RedisRoomStore: subscribe forward write ack channel failed');
      });
    };

    // Initial subscription
    subscribe();

    // Track Redis disconnections for partition detection
    this.sub.on('close', () => {
      recordPartitionEvent();
    });

    // Re-subscribe after any reconnect — ioredis resets subscription state on
    // reconnect, so we must re-issue psubscribe on every 'ready' event.
    // Also trigger reconciliation to merge any updates missed during the partition.
    this.sub.on('ready', () => {
      getLogger().info('RedisRoomStore: subscriber reconnected — re-subscribing + reconciling');
      subscribe();
      // UPGRADE 5: Re-sync cluster clock immediately after Redis reconnect
      void resyncClusterClock();
      // Trigger reconciliation after a short delay to allow subscriptions to stabilize
      setTimeout(() => void this._triggerReconciliation(), 500);
    });

    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      // ── room_invalidate:<fileId> ───────────────────────────────────────
      if (channel.startsWith('room_invalidate:')) {
        redisPubsubMessagesCounter.inc({ channel: 'room_invalidate' });
        const fileId = channel.slice('room_invalidate:'.length);
        const room   = this.rooms.get(fileId);
        if (!room) return;

        this._stopHeartbeat(fileId);
        if (this.ownedRooms.delete(fileId)) roomsOwnedGauge.set(this.ownedRooms.size);
        this.rooms.delete(fileId);
        getLogger().info({ fileId }, 'RedisRoomStore: room invalidated by remote node');

        try {
          if (room.state !== 'idle' && room.state !== 'destroying') room.markIdle();
          room.destroy();
        } catch (err) {
          getLogger().warn({ err, fileId }, 'RedisRoomStore: error destroying invalidated room');
        }
        return;
      }

      // ── presence:<fileId> ─────────────────────────────────────────────
      if (channel.startsWith('presence:')) {
        redisPubsubMessagesCounter.inc({ channel: 'presence' });
        const fileId = channel.slice('presence:'.length);
        try {
          const envelope = JSON.parse(message) as {
            nodeId:       string;
            connectionId: string;
            update:       string; // base64-encoded raw MSG_AWARENESS frame
          };

          // Skip updates that this node originally published — no-loop guarantee.
          if (envelope.nodeId === this.nodeId) return;

          // Ignore rooms not hosted locally — nothing to fan out to.
          if (!this.rooms.has(fileId)) return;

          const rawMsg = Buffer.from(envelope.update, 'base64');
          this.onRemotePresence?.(fileId, rawMsg);
          getLogger().debug(
            { fileId, remoteNodeId: envelope.nodeId },
            'presence update applied from redis',
          );
        } catch (err) {
          getLogger().warn({ err, channel }, 'RedisRoomStore: failed to parse presence envelope');
        }
      }

      // ── UPGRADE 3: pg:presence:channel:<fileId> ─────────────────────────
      if (channel.startsWith('pg:presence:channel:')) {
        redisPubsubMessagesCounter.inc({ channel: 'pg_presence' });
        const fileId = channel.slice('pg:presence:channel:'.length);
        try {
          const envelope = JSON.parse(message) as PresenceEnvelope;
          if (envelope.nodeId === this.nodeId) return;
          if (!this.rooms.has(fileId)) return;

          // Update local presence store
          this.presenceStore.set(fileId, {
            userId: envelope.userId,
            connectionId: envelope.connectionId,
            data: envelope.data,
          });
          presenceActiveEntries.set(this.presenceStore.totalEntries);

          // Delegate to the same remote presence handler
          const rawMsg = Buffer.from(JSON.stringify(envelope.data));
          this.onRemotePresence?.(fileId, rawMsg);
        } catch (err) {
          getLogger().warn({ err, channel }, 'RedisRoomStore: failed to parse pg:presence envelope');
        }
      }
    });

    // ── Reconciliation + topology message handler (non-pattern subscriptions) ─────
    this.sub.on('message', (channel: string, message: string) => {
      // ── UPGRADE 1: Topology change events ─────────────────────────────
      if (channel === TOPOLOGY_CHANGE_CHANNEL) {
        try {
          const event = JSON.parse(message) as ClusterTopologyEvent;
          if (event.nodeId === this.nodeId) return; // ignore self
          this.cluster.handleTopologyChange(event);
        } catch (err) {
          getLogger().warn({ err }, 'RedisRoomStore: failed to parse topology change');
        }
        return;
      }

      const myForwardWriteChannel = forwardWriteChannel(this.nodeId);
      if (channel === myForwardWriteChannel) {
        redisPubsubMessagesCounter.inc({ channel: 'forward_write' });
        let request: ForwardedWriteRequest;
        try {
          request = JSON.parse(message) as ForwardedWriteRequest;
        } catch (err) {
          getLogger().warn({ err }, 'RedisRoomStore: failed to parse forwarded write request');
          return;
        }

        if (!this.onForwardedWrite) {
          const nack: ForwardedWriteAck = {
            requestId: request.requestId,
            sourceConnectionId: request.sourceConnectionId,
            success: false,
            error: 'forward_write_handler_unavailable',
          };
          void this.redis.publish(forwardWriteAckChannel(request.sourceNodeId), JSON.stringify(nack));
          return;
        }

        void this.onForwardedWrite(request)
          .then((result) => {
            const ack: ForwardedWriteAck = {
              requestId: request.requestId,
              sourceConnectionId: request.sourceConnectionId,
              success: result.success,
              seq: typeof result.seq === 'bigint' ? result.seq.toString() : undefined,
              error: result.error,
            };
            return this.redis.publish(forwardWriteAckChannel(request.sourceNodeId), JSON.stringify(ack));
          })
          .catch((err) => {
            getLogger().warn({ err, fileId: request.fileId }, 'RedisRoomStore: forwarded write handling failed');
            const ack: ForwardedWriteAck = {
              requestId: request.requestId,
              sourceConnectionId: request.sourceConnectionId,
              success: false,
              error: 'forward_write_failed',
            };
            void this.redis.publish(forwardWriteAckChannel(request.sourceNodeId), JSON.stringify(ack));
          });
        return;
      }

      const myForwardWriteAckChannel = forwardWriteAckChannel(this.nodeId);
      if (channel === myForwardWriteAckChannel) {
        redisPubsubMessagesCounter.inc({ channel: 'forward_write_ack' });
        let ack: ForwardedWriteAck;
        try {
          ack = JSON.parse(message) as ForwardedWriteAck;
        } catch (err) {
          getLogger().warn({ err }, 'RedisRoomStore: failed to parse forwarded write ack');
          return;
        }

        const pending = this.pendingForwardAcks.get(ack.requestId);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingForwardAcks.delete(ack.requestId);

        if (!ack.success || !ack.seq) {
          pending.resolve(null);
          return;
        }

        try {
          pending.resolve(BigInt(ack.seq));
        } catch {
          pending.resolve(null);
        }
        return;
      }

      // Only process reconciliation channels
      const myReconcileChannel = reconcileChannel(this.nodeId);
      if (channel !== myReconcileChannel && channel !== RECONCILE_BROADCAST_CHANNEL) return;

      try {
        const parsed = JSON.parse(message) as ReconcileMessage;

        // Never process our own messages
        if (parsed.nodeId === this.nodeId) return;

        if (parsed.type === 'sv_request' && channel === RECONCILE_BROADCAST_CHANNEL) {
          // Another node is requesting reconciliation — compute diffs and respond
          const getDoc = (fileId: string) => this.rooms.get(fileId)?.getDocForReconciliation();

          const response = handleReconcileRequest(
            parsed as ReconcileRequestType,
            getDoc,
            this.nodeId,
          );

          // Publish response directly to the requesting node's channel
          if (response.diffs.length > 0) {
            this.redis
              .publish(reconcileChannel(parsed.nodeId), JSON.stringify(response))
              .catch((err) => {
                getLogger().warn({ err }, 'RedisRoomStore: failed to publish reconcile response');
              });
          }
        } else if (parsed.type === 'sv_response' && channel === myReconcileChannel) {
          // Response to our reconciliation request — apply diffs
          const getDoc = (fileId: string) => this.rooms.get(fileId)?.getDocForReconciliation();

          const applied = applyReconcileResponse(parsed as ReconcileResponseType, getDoc);
          getLogger().info(
            { remoteNodeId: parsed.nodeId, applied },
            'RedisRoomStore: reconciliation response applied',
          );
        }
      } catch (err) {
        getLogger().warn({ err, channel }, 'RedisRoomStore: failed to process reconcile message');
      }
    });
  }

  /**
   * Trigger a reconciliation round after Redis reconnect.
   *
   * Broadcasts our state vectors for all locally held rooms to the
   * `reconcile:broadcast` channel.  Other nodes respond with diffs via
   * our per-node `reconcile:<nodeId>` channel.
   */
  private async _triggerReconciliation(): Promise<void> {
    if (this._reconciling) return;
    if (this.rooms.size === 0) return;

    this._reconciling = true;
    try {
      const roomDocs: Array<[string, import('yjs').Doc]> = [];
      for (const [fileId, room] of this.rooms) {
        const doc = room.getDocForReconciliation();
        if (doc) roomDocs.push([fileId, doc]);
      }

      if (roomDocs.length === 0) return;

      const request = buildReconcileRequest(this.nodeId, roomDocs);
      await this.redis.publish(RECONCILE_BROADCAST_CHANNEL, JSON.stringify(request));

      getLogger().info(
        { rooms: roomDocs.length },
        'RedisRoomStore: reconciliation request broadcast',
      );
    } catch (err) {
      getLogger().error({ err }, 'RedisRoomStore: reconciliation trigger failed');
    } finally {
      this._reconciling = false;
    }
  }

  /** Start the periodic ownership heartbeat for `fileId`. */
  private _startHeartbeat(fileId: string): void {
    // Guard against duplicate timers (e.g. if getOrCreate races on this node)
    if (this.heartbeatTimers.has(fileId)) return;

    const timer = setInterval(() => {
      // Only refresh if the room is still locally alive
      if (!this.rooms.has(fileId)) {
        this._stopHeartbeat(fileId);
        return;
      }
      this.redis
        .set(ownerKey(fileId), this.nodeId, 'EX', OWNER_TTL_SEC)
        .catch((err) => {
          getLogger().warn({ err, fileId }, 'RedisRoomStore: heartbeat refresh failed');
        });
    }, HEARTBEAT_INTERVAL_MS);

    // Unref so the timer does not prevent Node.js from exiting cleanly
    if (typeof timer.unref === 'function') timer.unref();
    this.heartbeatTimers.set(fileId, timer);
  }

  /** Stop and remove the heartbeat timer for `fileId`. */
  private _stopHeartbeat(fileId: string): void {
    const timer = this.heartbeatTimers.get(fileId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatTimers.delete(fileId);
    }
  }
}
