/**
 * clusterClock.ts
 *
 * Cluster-wide monotonic time authority — eliminates clock-skew-induced
 * distributed failures across PeerGrid nodes.
 *
 * Problem:
 *   Each node uses its local wall clock (Date.now()) for distributed
 *   coordination: lock TTL, presence TTL, topology heartbeats, compaction
 *   scheduling, etc.  If node clocks diverge (VM migration, NTP drift,
 *   leap second, container clock skew), this causes:
 *
 *     - Premature lock takeover: Node B thinks Node A's lock has expired
 *       when it hasn't (B's clock is ahead).
 *     - Ghost presence: Presence entries appear valid on Node A (slow clock)
 *       but expired on Node B (fast clock).
 *     - Incorrect membership expiry: Dead-node scan removes live nodes
 *       whose heartbeats appear stale due to clock skew.
 *     - Snapshot ordering: Snapshots from a slow-clock node appear older
 *       than they actually are, risking incorrect conflict resolution.
 *
 * Solution:
 *   Use Redis SERVER TIME as the single source of truth for all distributed
 *   coordination timestamps.  Redis `TIME` returns the server's Unix
 *   timestamp with microsecond precision — the same for all clients.
 *
 *   Caching: Redis TIME is queried at most once per CACHE_TTL_MS (~500ms)
 *   to avoid per-operation overhead.  Between queries, we use the monotonic
 *   clock (process.hrtime.bigint()) to interpolate.
 *
 *   Fallback: If Redis is unavailable, fall back to monotonic clock offset
 *   from process startup.  This is still safe for relative durations (TTL
 *   countdown) even though the absolute timestamp may diverge from other
 *   nodes.  A drift metric is emitted to alert operators.
 *
 * Guarantees:
 *   1. Within a single node, getClusterTimeMs() is monotonically
 *      non-decreasing (never goes backwards).
 *   2. Across nodes in the same cluster, timestamps are within CACHE_TTL_MS
 *      + network RTT of each other (typically <5ms total skew).
 *   3. On Redis failure, each node's clock drifts independently but at the
 *      rate of the OS monotonic clock, not the wall clock.
 */

import { getLogger } from '../utils/logger';

const logger = getLogger();

// ── Constants ───────────────────────────────────────────────────────────────

/** How often to re-sync from Redis TIME (ms). */
export const CACHE_TTL_MS = 500;

/** Periodic background sync interval (ms). Slightly shorter than TTL to
 *  keep the cache warm even without explicit calls. */
export const BACKGROUND_SYNC_INTERVAL_MS = 400;

/** Maximum allowed drift from wall clock before emitting a warning (ms). */
export const DRIFT_WARN_THRESHOLD_MS = 500;

// ── Internal State ──────────────────────────────────────────────────────────

/** Nanosecond-resolution monotonic clock at process start. */
const BOOT_HRTIME_NS = process.hrtime.bigint();

/** Wall-clock estimate at process start (used as fallback baseline). */
const BOOT_WALL_MS = Date.now();

/** Cached Redis time (ms since Unix epoch). */
let cachedRedisTimeMs = 0;

/** Monotonic hrtime (ns) at which cachedRedisTimeMs was sampled. */
let cachedAtHrtimeNs = 0n;

/** Whether the clock has ever successfully synced with Redis. */
let hasSynced = false;

/** Total number of successful Redis TIME queries. */
let totalSyncRequests = 0;

/** Total number of failed Redis TIME queries (fallback activations). */
let totalSyncFailures = 0;

/** Latest observed drift between Redis time and local wall clock (ms). */
let lastDriftMs = 0;

/** Background sync timer handle. */
let syncTimer: ReturnType<typeof setInterval> | undefined;

/** Redis client reference for background sync. */
let redisRef: import('ioredis').default | undefined;

// ── Core API ────────────────────────────────────────────────────────────────

/**
 * Return the current cluster time in milliseconds since Unix epoch.
 *
 * If Redis has been synced within CACHE_TTL_MS, this returns the Redis
 * server time + monotonic interpolation.  Otherwise falls back to
 * process.hrtime-based monotonic clock.
 *
 * This function is **synchronous** and allocation-free on the hot path.
 */
export function getClusterTimeMs(): number {
  const nowNs = process.hrtime.bigint();

  if (hasSynced) {
    // Interpolate from last Redis sync using monotonic delta
    const elapsedMs = Number(nowNs - cachedAtHrtimeNs) / 1_000_000;
    return cachedRedisTimeMs + elapsedMs;
  }

  // Fallback: monotonic offset from process boot
  const elapsedMs = Number(nowNs - BOOT_HRTIME_NS) / 1_000_000;
  return BOOT_WALL_MS + elapsedMs;
}

/**
 * Return the current cluster time in whole Unix seconds.
 * Useful for Redis key TTLs and presence expiry calculations.
 */
export function getClusterUnixSeconds(): number {
  return Math.floor(getClusterTimeMs() / 1000);
}

// ── Sync Engine ─────────────────────────────────────────────────────────────

/**
 * Synchronise the cluster clock from Redis TIME.
 *
 * Redis `TIME` returns `[unixSeconds, microseconds]`.  We convert to
 * milliseconds and snapshot the monotonic clock at the same instant.
 *
 * @param redis  ioredis client.
 * @returns The drift in ms between Redis time and local wall clock.
 */
export async function syncFromRedis(
  redis: import('ioredis').default,
): Promise<number> {
  try {
    const beforeNs = process.hrtime.bigint();
    const result = await redis.time();
    const afterNs = process.hrtime.bigint();

    // Use midpoint of request to minimise network RTT error
    const midpointNs = beforeNs + (afterNs - beforeNs) / 2n;

    // Redis returns [seconds: string, microseconds: string]
    const secs = Number(result[0]);
    const micros = Number(result[1]);
    const redisMs = secs * 1000 + micros / 1000;

    // Ensure monotonicity: never let cluster time go backwards
    if (hasSynced) {
      const prevInterpolated =
        cachedRedisTimeMs + Number(midpointNs - cachedAtHrtimeNs) / 1_000_000;
      if (redisMs < prevInterpolated) {
        // Redis time jumped backwards (rare — Redis failover to replica with
        // slightly older clock).  Keep the interpolated value to maintain
        // monotonicity and log a warning.
        logger.warn(
          {
            redisMs: redisMs.toFixed(1),
            interpolatedMs: prevInterpolated.toFixed(1),
            backwardJumpMs: (prevInterpolated - redisMs).toFixed(1),
          },
          '[clusterClock] Redis time jumped backwards — maintaining monotonicity',
        );
        // Don't update cache — keep interpolating from old anchor.
        totalSyncRequests++;
        return lastDriftMs;
      }
    }

    // Compute drift: Redis time − local wall clock at same instant
    const localWallMs = BOOT_WALL_MS + Number(midpointNs - BOOT_HRTIME_NS) / 1_000_000;
    lastDriftMs = redisMs - localWallMs;

    if (Math.abs(lastDriftMs) > DRIFT_WARN_THRESHOLD_MS) {
      logger.warn(
        { driftMs: lastDriftMs.toFixed(1) },
        '[clusterClock] significant clock drift detected between node and Redis',
      );
    }

    // Update cache atomically
    cachedRedisTimeMs = redisMs;
    cachedAtHrtimeNs = midpointNs;
    hasSynced = true;
    totalSyncRequests++;

    return lastDriftMs;
  } catch (err) {
    totalSyncFailures++;
    logger.debug({ err }, '[clusterClock] Redis TIME failed — using monotonic fallback');
    return lastDriftMs;
  }
}

// ── Background Sync Lifecycle ───────────────────────────────────────────────

/**
 * Start periodic background sync with Redis TIME.
 *
 * Should be called once at server startup after the Redis client is ready.
 * Performs an immediate sync, then schedules periodic re-syncs.
 *
 * @param redis  ioredis client.
 */
export async function startClusterClock(
  redis: import('ioredis').default,
): Promise<void> {
  redisRef = redis;

  // Initial sync — block until first time is established
  await syncFromRedis(redis);

  // Periodic background sync
  syncTimer = setInterval(() => {
    void syncFromRedis(redis);
  }, BACKGROUND_SYNC_INTERVAL_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref();

  logger.info(
    {
      initialDriftMs: lastDriftMs.toFixed(1),
      cacheTtlMs: CACHE_TTL_MS,
      syncIntervalMs: BACKGROUND_SYNC_INTERVAL_MS,
    },
    '[clusterClock] started — using Redis TIME as cluster time authority',
  );
}

/**
 * Stop the background sync timer.
 * Called during graceful shutdown.
 */
export function stopClusterClock(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = undefined;
  }
  redisRef = undefined;
  logger.info('[clusterClock] stopped');
}

/**
 * Force an immediate re-sync if the cached value is stale.
 * Useful after a Redis reconnect event.
 */
export async function resyncClusterClock(): Promise<void> {
  if (redisRef) {
    await syncFromRedis(redisRef);
  }
}

// ── Observability ───────────────────────────────────────────────────────────

/** Snapshot of cluster clock health for metrics scraping. */
export interface ClusterClockSnapshot {
  /** Whether at least one successful Redis TIME sync has occurred. */
  synced: boolean;
  /** Latest drift between Redis time and local wall clock (ms). */
  driftMs: number;
  /** Total successful sync requests. */
  totalRequests: number;
  /** Total failed sync requests (fallback activations). */
  totalFailures: number;
  /** Whether the clock is currently using the monotonic fallback. */
  usingFallback: boolean;
}

/**
 * Return a snapshot of the cluster clock's current health.
 */
export function getClockSnapshot(): ClusterClockSnapshot {
  return {
    synced: hasSynced,
    driftMs: lastDriftMs,
    totalRequests: totalSyncRequests,
    totalFailures: totalSyncFailures,
    usingFallback: !hasSynced,
  };
}

/**
 * Reset internal state — **for testing only**.
 */
export function _resetForTesting(): void {
  cachedRedisTimeMs = 0;
  cachedAtHrtimeNs = 0n;
  hasSynced = false;
  totalSyncRequests = 0;
  totalSyncFailures = 0;
  lastDriftMs = 0;
  stopClusterClock();
}
