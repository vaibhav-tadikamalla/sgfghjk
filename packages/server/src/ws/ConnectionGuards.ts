/**
 * ConnectionGuards.ts
 *
 * Pure constants and stateless helpers for the four hardening safeguards
 * applied to incoming WebSocket traffic.  Keeping these here means
 * websocket.ts stays clean and every limit is tunable in one place.
 *
 *  1. MAX_MESSAGE_BYTES        — hard cap on any single WS frame
 *  2. MAX_SESSIONS_PER_USER    — max concurrent authenticated connections per user
 *  3. Edit burst throttle      — soft per-connection rate limit for sync frames
 *  4. MAX_JSON_CONTROL_BYTES   — hard cap on JSON text-frame payloads
 */

import type { RawData } from 'ws';

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum size of any single WebSocket frame (binary or text) in bytes (1 MiB). */
export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Maximum number of concurrent authenticated WebSocket connections per user.
 * Excess connections are rejected at auth time; existing connections are unaffected.
 */
export const MAX_SESSIONS_PER_USER = 5;

/**
 * Maximum size of a JSON control-message frame in bytes (64 KiB).
 * Generous enough for any real control message while still blocking
 * oversized payloads before JSON.parse is called.
 */
export const MAX_JSON_CONTROL_BYTES = 64 * 1024; // 64 KiB

/** Maximum Yjs sync frames a write-capable connection may send per window. */
export const EDIT_BURST_MAX = 50;

/** Duration of the burst-detection rolling window in milliseconds. */
export const EDIT_BURST_WINDOW_MS = 1_000;

/**
 * Exhaustive set of JSON message types the server accepts from authenticated
 * clients.  Any type not in this set causes immediate close(1008).
 *
 * 'auth'  — included so a client that re-sends auth after being accepted is
 *           handled gracefully (no-op) rather than disconnected.
 * 'error' — clients may echo structured error frames; server ignores them.
 */
export const KNOWN_JSON_CONTROL_TYPES = new Set([
  'subscribe_dashboard',
  'auth',
  'error',
] as const);

// ─────────────────────────────────────────────────────────────────────────────
// UUID validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a canonical (lower- or upper-case) UUID string.
 * Used to reject non-UUID workspaceId values before processing control messages,
 * preventing path-traversal or injection attempts that rely on unusual strings.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// RawData byte-length helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the byte length of a ws `RawData` value without copying any buffers.
 *
 * ws delivers messages as one of three shapes:
 *   - Buffer         (most common)
 *   - ArrayBuffer    (when ws is configured with binaryType = 'arraybuffer')
 *   - Buffer[]       (fragmented frames — ws concatenates by default but the
 *                     type still appears in the union)
 */
export function getRawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    let total = 0;
    for (const b of data) total += b.byteLength;
    return total;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit burst throttle
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable per-connection burst tracking state.  Stored in CollaborationServer. */
export interface EditBurstState {
  /** Number of sync frames counted within the current window. */
  count: number;
  /** Unix ms timestamp when the current window started. */
  windowStart: number;
}

/**
 * Check whether `connectionId` is currently over the burst rate limit.
 *
 * Semantics:
 *   - If no entry exists yet, create one (count = 1) and return false.
 *   - If the window has expired (>= EDIT_BURST_WINDOW_MS since windowStart),
 *     reset the counter to 1 and return false.
 *   - Otherwise increment the counter.
 *     Return true (throttled) only when the count EXCEEDS EDIT_BURST_MAX —
 *     i.e. the (EDIT_BURST_MAX + 1)th frame in the window should be dropped.
 *
 * This function both checks and mutates `tracker` atomically (single-threaded
 * Node.js event loop guarantees no races).
 *
 * @returns true when the frame should be dropped (soft-throttle active).
 */
/**
 * Result returned by isEditThrottled.
 *
 * drop      — true when the caller should discard the current frame.
 * firstDrop — true only on the very first dropped frame in a window so the
 *             caller can emit exactly one warning per second instead of
 *             one per dropped frame.
 */
export interface BurstThrottleResult {
  drop: boolean;
  firstDrop: boolean;
}

export function isEditThrottled(
  tracker: Map<string, EditBurstState>,
  connectionId: string,
): BurstThrottleResult {
  const now = Date.now();
  const state = tracker.get(connectionId);

  if (!state) {
    // First frame for this connection — initialise and allow
    tracker.set(connectionId, { count: 1, windowStart: now });
    return { drop: false, firstDrop: false };
  }

  if (now - state.windowStart >= EDIT_BURST_WINDOW_MS) {
    // Previous window expired — start a fresh window, allow this frame
    state.count = 1;
    state.windowStart = now;
    return { drop: false, firstDrop: false };
  }

  // Within the same window — increment and check
  state.count += 1;
  const drop = state.count > EDIT_BURST_MAX;
  // firstDrop is true only when the count has just crossed the threshold
  // (EDIT_BURST_MAX + 1), so the caller logs exactly once per window.
  const firstDrop = state.count === EDIT_BURST_MAX + 1;
  return { drop, firstDrop };
}
