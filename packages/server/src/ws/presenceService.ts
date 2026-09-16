/**
 * presenceService.ts
 *
 * Global presence & awareness service — separates lightweight cursor/selection
 * updates from heavyweight CRDT document updates.
 *
 * Problem:
 *   Yjs awareness updates (cursors, selections, viewport) share the same
 *   pub/sub channels as heavyweight CRDT document updates. At scale (100k users,
 *   10k docs) this leads to:
 *     - Channel congestion: awareness updates dominate bandwidth
 *     - No rate limiting: a single user can flood the system at 60 Hz
 *     - No TTL: stale cursor positions linger until explicit cleanup
 *     - No viewport optimization: far-away cursors waste bandwidth
 *
 * Solution:
 *   Dedicated presence service with:
 *     1. Separate Redis pub/sub channel per room for presence only
 *     2. Per-connection rate limiter (configurable Hz, default 20)
 *     3. TTL-based auto-expiration of stale presence entries
 *     4. Viewport-based throttling tiers (near/mid/far)
 *     5. Efficient binary encoding for minimal overhead
 *
 * Redis key structure:
 *   - `pg:presence:<roomId>`         → Hash of userId → JSON presence data
 *   - `pg:presence:channel:<roomId>` → pub/sub channel for presence updates
 *   - `pg:presence:ttl:<roomId>`     → sorted set of userId with expire timestamps
 *
 * Wire format (presence update envelope):
 *   {
 *     nodeId:       string,      // source node (for loop prevention)
 *     connectionId: string,      // connection that generated the update
 *     userId:       string,      // authenticated user
 *     data: {
 *       cursor:    { line, ch },          // optional
 *       selection: { anchor, head },      // optional
 *       viewport:  { startLine, endLine }, // optional
 *       color:     string,
 *       displayName: string,
 *       timestamp: number,
 *     }
 *   }
 */

import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from './clusterClock';

const logger = getLogger();

// ── Types ───────────────────────────────────────────────────────────────────

export interface CursorPosition {
  line: number;
  ch: number;
}

export interface SelectionRange {
  anchor: CursorPosition;
  head: CursorPosition;
}

export interface ViewportRange {
  startLine: number;
  endLine: number;
}

export interface PresenceData {
  cursor?: CursorPosition;
  selection?: SelectionRange;
  viewport?: ViewportRange;
  color: string;
  displayName: string;
  timestamp: number;
}

export interface PresenceEntry {
  userId: string;
  connectionId: string;
  data: PresenceData;
}

export interface PresenceEnvelope {
  nodeId: string;
  connectionId: string;
  userId: string;
  data: PresenceData;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum presence updates per connection per second. */
export const PRESENCE_RATE_LIMIT_HZ = 20;

/** Minimum interval between presence updates (ms). */
export const PRESENCE_MIN_INTERVAL_MS = 1000 / PRESENCE_RATE_LIMIT_HZ; // 50ms

/** TTL for presence entries in Redis (seconds). */
export const PRESENCE_TTL_SEC = 30;

/** How often to sweep expired presence entries (ms). */
export const PRESENCE_SWEEP_INTERVAL_MS = 10_000;

/** How often to refresh presence TTLs in Redis (ms). */
export const PRESENCE_REFRESH_INTERVAL_MS = 10_000;

// ── Viewport throttle tiers ─────────────────────────────────────────────────

/**
 * Viewport-based throttle tiers. Users whose viewport is farther from the
 * update source receive updates less frequently.
 *
 * - NEAR:  overlapping viewports → full rate (20 Hz)
 * - MID:   within 200 lines → half rate (10 Hz)
 * - FAR:   beyond 200 lines → quarter rate (5 Hz)
 */
export const VIEWPORT_TIERS = {
  NEAR: { maxDistanceLines: 50, rateMultiplier: 1.0 },
  MID:  { maxDistanceLines: 200, rateMultiplier: 0.5 },
  FAR:  { maxDistanceLines: Infinity, rateMultiplier: 0.25 },
} as const;

// ── Redis key helpers ───────────────────────────────────────────────────────

/** Redis Hash storing all user presence for a room. */
export function presenceHashKey(roomId: string): string {
  return `pg:presence:${roomId}`;
}

/** Pub/sub channel for presence updates in a room. */
export function presencePubsubChannel(roomId: string): string {
  return `pg:presence:channel:${roomId}`;
}

/** Sorted set for TTL-based presence expiry tracking. */
export function presenceTtlKey(roomId: string): string {
  return `pg:presence:ttl:${roomId}`;
}

// ── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * Per-connection rate limiter for presence updates.
 *
 * Uses a simple token bucket algorithm:
 *   - Each connection gets 1 token per PRESENCE_MIN_INTERVAL_MS
 *   - If no token is available, the update is dropped (no queueing)
 *   - Token is replenished when enough time has passed since last send
 */
export class PresenceRateLimiter {
  /** connectionId → last send timestamp */
  private readonly lastSend = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(rateHz: number = PRESENCE_RATE_LIMIT_HZ) {
    this.minIntervalMs = 1000 / rateHz;
  }

  /**
   * Check if a presence update should be allowed for this connection.
   *
   * @returns true if the update should proceed, false if rate-limited.
   */
  allow(connectionId: string): boolean {
    const now = getClusterTimeMs();
    const last = this.lastSend.get(connectionId);

    if (last !== undefined && (now - last) < this.minIntervalMs) {
      return false; // rate-limited
    }

    this.lastSend.set(connectionId, now);
    return true;
  }

  /** Remove a connection from rate limiter tracking. */
  remove(connectionId: string): void {
    this.lastSend.delete(connectionId);
  }

  /** Get number of tracked connections. */
  get size(): number {
    return this.lastSend.size;
  }

  /** Clear all tracked connections. */
  clear(): void {
    this.lastSend.clear();
  }
}

// ── Viewport Distance Calculator ────────────────────────────────────────────

/**
 * Calculate the distance between two viewports.
 * Returns the number of lines between the closest edges.
 * If viewports overlap, distance is 0.
 */
export function viewportDistance(a: ViewportRange, b: ViewportRange): number {
  if (a.endLine < b.startLine) return b.startLine - a.endLine;
  if (b.endLine < a.startLine) return a.startLine - b.endLine;
  return 0; // overlapping
}

/**
 * Determine the throttle tier for a given viewport distance.
 */
export function getThrottleTier(distance: number): keyof typeof VIEWPORT_TIERS {
  if (distance <= VIEWPORT_TIERS.NEAR.maxDistanceLines) return 'NEAR';
  if (distance <= VIEWPORT_TIERS.MID.maxDistanceLines) return 'MID';
  return 'FAR';
}

/**
 * Check if an update should be sent based on viewport-aware throttling.
 *
 * @param sourceViewport  The viewport of the user generating the update.
 * @param targetViewport  The viewport of the user receiving the update.
 * @param baseRateHz      The base (unthrottled) rate.
 * @param lastSendTime    The last time an update was sent to this target.
 * @returns true if the update should proceed.
 */
export function shouldSendViewportAware(
  sourceViewport: ViewportRange | undefined,
  targetViewport: ViewportRange | undefined,
  baseRateHz: number,
  lastSendTime: number,
): boolean {
  // If either viewport is unknown, send at full rate
  if (!sourceViewport || !targetViewport) return true;

  const distance = viewportDistance(sourceViewport, targetViewport);
  const tier = getThrottleTier(distance);
  const effectiveInterval = 1000 / (baseRateHz * VIEWPORT_TIERS[tier].rateMultiplier);

  return (getClusterTimeMs() - lastSendTime) >= effectiveInterval;
}

// ── Presence Store ──────────────────────────────────────────────────────────

/**
 * In-memory per-room presence store.
 *
 * Maintains the latest presence data for each user in each room.
 * Entries are automatically expired based on their timestamp + TTL.
 */
export class LocalPresenceStore {
  /** roomId → Map<userId, PresenceEntry> */
  private readonly rooms = new Map<string, Map<string, PresenceEntry>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // Periodic sweep for expired entries
    this.sweepTimer = setInterval(() => this.sweepExpired(), PRESENCE_SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /**
   * Update presence data for a user in a room.
   */
  set(roomId: string, entry: PresenceEntry): void {
    let roomMap = this.rooms.get(roomId);
    if (!roomMap) {
      roomMap = new Map();
      this.rooms.set(roomId, roomMap);
    }
    roomMap.set(entry.userId, entry);
  }

  /**
   * Get all active presence entries for a room.
   */
  getRoom(roomId: string): PresenceEntry[] {
    const roomMap = this.rooms.get(roomId);
    if (!roomMap) return [];
    return [...roomMap.values()];
  }

  /**
   * Get a specific user's presence in a room.
   */
  getUser(roomId: string, userId: string): PresenceEntry | undefined {
    return this.rooms.get(roomId)?.get(userId);
  }

  /**
   * Remove a user's presence from a room.
   */
  remove(roomId: string, userId: string): void {
    const roomMap = this.rooms.get(roomId);
    if (!roomMap) return;
    roomMap.delete(userId);
    if (roomMap.size === 0) this.rooms.delete(roomId);
  }

  /**
   * Remove all presence data for a room.
   */
  removeRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  /**
   * Remove all presence entries for a connection (user disconnect).
   */
  removeByConnection(connectionId: string): void {
    for (const [roomId, roomMap] of this.rooms) {
      for (const [userId, entry] of roomMap) {
        if (entry.connectionId === connectionId) {
          roomMap.delete(userId);
        }
      }
      if (roomMap.size === 0) this.rooms.delete(roomId);
    }
  }

  /**
   * Sweep expired entries across all rooms.
   */
  private sweepExpired(): void {
    const cutoff = getClusterTimeMs() - (PRESENCE_TTL_SEC * 1000);
    let swept = 0;

    for (const [roomId, roomMap] of this.rooms) {
      for (const [userId, entry] of roomMap) {
        if (entry.data.timestamp < cutoff) {
          roomMap.delete(userId);
          swept++;
        }
      }
      if (roomMap.size === 0) this.rooms.delete(roomId);
    }

    if (swept > 0) {
      logger.debug({ swept }, '[presence] swept expired entries');
    }
  }

  /** Get total number of active presence entries across all rooms. */
  get totalEntries(): number {
    let count = 0;
    for (const roomMap of this.rooms.values()) count += roomMap.size;
    return count;
  }

  /** Get number of rooms with presence data. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Stop the sweep timer (for shutdown). */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.rooms.clear();
  }
}

// ── Redis Presence Publisher ────────────────────────────────────────────────

/**
 * Publish a presence update to Redis for cross-node fan-out.
 *
 * Publishes to the dedicated presence channel (separate from CRDT updates).
 * Also updates the presence hash and TTL sorted set in Redis.
 *
 * @param redis    ioredis client.
 * @param roomId   Room / file ID.
 * @param envelope Presence update envelope.
 */
export async function publishPresenceUpdate(
  redis: import('ioredis').default,
  roomId: string,
  envelope: PresenceEnvelope,
): Promise<void> {
  try {
    const pipeline = redis.pipeline();

    // Publish to dedicated presence channel
    pipeline.publish(
      presencePubsubChannel(roomId),
      JSON.stringify(envelope),
    );

    // Update presence hash (stores latest state for each user)
    pipeline.hset(
      presenceHashKey(roomId),
      envelope.userId,
      JSON.stringify(envelope.data),
    );

    // Update TTL sorted set (score = expiry timestamp)
    pipeline.zadd(
      presenceTtlKey(roomId),
      (getClusterTimeMs() + PRESENCE_TTL_SEC * 1000).toString(),
      envelope.userId,
    );

    // Set TTL on the presence hash itself (auto-cleanup if room goes idle)
    pipeline.expire(presenceHashKey(roomId), PRESENCE_TTL_SEC * 2);
    pipeline.expire(presenceTtlKey(roomId), PRESENCE_TTL_SEC * 2);

    await pipeline.exec();
  } catch (err) {
    logger.debug({ err, roomId }, '[presence] publish failed');
  }
}

/**
 * Load all presence entries for a room from Redis.
 *
 * Used on node startup or room creation to hydrate the local presence store
 * with the latest state from other nodes.
 */
export async function loadPresenceFromRedis(
  redis: import('ioredis').default,
  roomId: string,
): Promise<Map<string, PresenceData>> {
  const result = new Map<string, PresenceData>();
  try {
    const hash = await redis.hgetall(presenceHashKey(roomId));
    for (const [userId, dataStr] of Object.entries(hash)) {
      try {
        const data = JSON.parse(dataStr) as PresenceData;
        // Skip expired entries
        if (getClusterTimeMs() - data.timestamp > PRESENCE_TTL_SEC * 1000) continue;
        result.set(userId, data);
      } catch {
        // Corrupt entry — skip
      }
    }
  } catch (err) {
    logger.warn({ err, roomId }, '[presence] load from Redis failed');
  }
  return result;
}

/**
 * Remove a user's presence from Redis (disconnect cleanup).
 */
export async function removePresenceFromRedis(
  redis: import('ioredis').default,
  roomId: string,
  userId: string,
): Promise<void> {
  try {
    const pipeline = redis.pipeline();
    pipeline.hdel(presenceHashKey(roomId), userId);
    pipeline.zrem(presenceTtlKey(roomId), userId);
    await pipeline.exec();
  } catch (err) {
    logger.debug({ err, roomId, userId }, '[presence] remove from Redis failed');
  }
}

/**
 * Clean up expired presence entries in Redis for a room.
 */
export async function sweepExpiredPresence(
  redis: import('ioredis').default,
  roomId: string,
): Promise<number> {
  try {
    // Get expired members from TTL sorted set
    const expired = await redis.zrangebyscore(
      presenceTtlKey(roomId),
      '-inf',
      getClusterTimeMs().toString(),
    );

    if (expired.length === 0) return 0;

    const pipeline = redis.pipeline();
    for (const userId of expired) {
      pipeline.hdel(presenceHashKey(roomId), userId);
      pipeline.zrem(presenceTtlKey(roomId), userId);
    }
    await pipeline.exec();

    return expired.length;
  } catch (err) {
    logger.warn({ err, roomId }, '[presence] sweep expired failed');
    return 0;
  }
}
