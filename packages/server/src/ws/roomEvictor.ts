/**
 * roomEvictor.ts
 *
 * LRU-based automatic room eviction for bounded memory usage.
 *
 * Problem:
 *   At 10k–100k concurrent users collaborating on thousands of documents,
 *   keeping every ever-opened Y.Doc in memory is untenable.  A Y.Doc for a
 *   large document can occupy 10–50 MiB, and a node handling 1000 documents
 *   would consume 10–50 GiB of heap — well beyond typical container limits.
 *
 * Solution:
 *   Idle rooms (zero connections) are candidates for eviction.  The evictor
 *   runs on a periodic sweep interval and evicts rooms that:
 *
 *     1. Have zero active connections.
 *     2. Have been idle for >= IDLE_EVICTION_TIMEOUT_MS.
 *     3. Are not currently saving or in a transitional lifecycle state.
 *
 *   Eviction sequence:
 *     a. Snapshot the Y.Doc state to document_snapshots (if dirty).
 *     b. Destroy the Y.Doc to free heap memory.
 *     c. Remove the room from the local RoomStore.
 *     d. Record the eviction in metrics.
 *
 *   When a new client joins an evicted room, the normal getOrCreateRoom path
 *   loads the snapshot from PostgreSQL, so the eviction is transparent.
 *
 * Configuration:
 *   - MAX_ROOMS_IN_MEMORY   — hard cap on total in-memory rooms.
 *   - IDLE_EVICTION_TIMEOUT — minimum idle duration before a room is eligible.
 *   - EVICTION_SWEEP_INTERVAL — how often the evictor runs.
 */

import { getLogger } from '../utils/logger';
import { getClusterTimeMs } from './clusterClock';
import {
  roomEvictionCounter,
  roomEvictionDuration,
} from '../metrics/advancedMetrics';

const logger = getLogger();

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Hard cap on rooms held in memory per node.  LRU eviction fires above this. */
export const MAX_ROOMS_IN_MEMORY = 500;

/** Minimum idle time (ms) before a room with zero connections is evictable. */
export const IDLE_EVICTION_TIMEOUT_MS = 60 * 1000; // 1 minute

/** How often the evictor sweeps all rooms (ms). */
export const EVICTION_SWEEP_INTERVAL_MS = 15 * 1000; // 15 seconds

// ── LRU tracking ────────────────────────────────────────────────────────────

/**
 * Per-room LRU metadata.  Updated whenever a room receives activity.
 */
export interface RoomLruEntry {
  /** fileId — the room's key in the room store. */
  fileId: string;
  /** Unix timestamp (ms) of the last activity (connection add, edit, etc.). */
  lastActivityMs: number;
  /** Unix timestamp (ms) when the room transitioned to idle (zero connections). */
  idleSinceMs: number;
  /** Estimated byte size of the Y.Doc (updated periodically). */
  estimatedSizeBytes: number;
}

/**
 * LRU index — maps fileId → RoomLruEntry.
 * Maintained by the CollaborationServer on room create/activity/idle events.
 */
export class RoomLruIndex {
  private readonly entries = new Map<string, RoomLruEntry>();

  /** Register or update a room's activity timestamp. */
  touch(fileId: string, estimatedSizeBytes: number = 0): void {
    const existing = this.entries.get(fileId);
    if (existing) {
      existing.lastActivityMs = getClusterTimeMs();
      existing.idleSinceMs = 0; // not idle
      if (estimatedSizeBytes > 0) existing.estimatedSizeBytes = estimatedSizeBytes;
    } else {
      this.entries.set(fileId, {
        fileId,
        lastActivityMs: getClusterTimeMs(),
        idleSinceMs: 0,
        estimatedSizeBytes,
      });
    }
  }

  /** Mark a room as idle (zero connections). */
  markIdle(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (entry) {
      entry.idleSinceMs = getClusterTimeMs();
    }
  }

  /** Mark a room as active (connection added while idle). */
  markActive(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (entry) {
      entry.idleSinceMs = 0;
      entry.lastActivityMs = getClusterTimeMs();
    }
  }

  /** Remove tracking for a room that has been destroyed. */
  remove(fileId: string): void {
    this.entries.delete(fileId);
  }

  /** Get the total number of tracked rooms. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Return rooms eligible for eviction, sorted by least recently used first.
   *
   * A room is eviction-eligible if:
   *   1. It has been idle for >= minIdleMs.
   *   2. Its idleSinceMs is nonzero (i.e. it is actually idle).
   */
  getEvictionCandidates(minIdleMs: number): RoomLruEntry[] {
    const now = getClusterTimeMs();
    const candidates: RoomLruEntry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.idleSinceMs > 0 && (now - entry.idleSinceMs) >= minIdleMs) {
        candidates.push(entry);
      }
    }

    // Sort by lastActivityMs ascending — evict the "coldest" rooms first
    candidates.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
    return candidates;
  }

  /**
   * Return the number of rooms that should be evicted to get back under
   * MAX_ROOMS_IN_MEMORY.  Returns 0 if within the limit.
   */
  getOverflowCount(maxRooms: number): number {
    return Math.max(0, this.entries.size - maxRooms);
  }
}

/**
 * Eviction decision result.
 */
export interface EvictionPlan {
  /** fileIds that should be evicted, ordered by priority (coldest first). */
  toEvict: string[];
  /** Reason for eviction (for logging). */
  reason: 'idle_timeout' | 'memory_pressure' | 'both';
}

/**
 * Compute the eviction plan for the current sweep cycle.
 *
 * @param lru  The LRU index.
 * @param maxRooms  Maximum rooms allowed in memory.
 * @param minIdleMs  Minimum idle time before eviction.
 * @returns EvictionPlan with the fileIds to evict.
 */
export function computeEvictionPlan(
  lru: RoomLruIndex,
  maxRooms: number = MAX_ROOMS_IN_MEMORY,
  minIdleMs: number = IDLE_EVICTION_TIMEOUT_MS,
): EvictionPlan {
  const candidates = lru.getEvictionCandidates(minIdleMs);
  const overflow = lru.getOverflowCount(maxRooms);

  if (candidates.length === 0) {
    return { toEvict: [], reason: 'idle_timeout' };
  }

  if (overflow > 0) {
    // Must evict at least `overflow` rooms to stay under the cap
    const count = Math.max(overflow, candidates.length);
    return {
      toEvict: candidates.slice(0, count).map((c) => c.fileId),
      reason: overflow >= candidates.length ? 'memory_pressure' : 'both',
    };
  }

  // No memory pressure — evict all idle-timeout candidates
  return {
    toEvict: candidates.map((c) => c.fileId),
    reason: 'idle_timeout',
  };
}

