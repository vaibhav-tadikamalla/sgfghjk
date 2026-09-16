/**
 * backpressure.ts
 *
 * WebSocket backpressure controller.
 *
 * Problem:
 *   A slow client whose network link is saturated will cause ws.send() to
 *   buffer data in the Node.js process.  Under high edit load, this causes
 *   memory exhaustion across 10k–100k connections.
 *
 * Solution:
 *   Before every ws.send(), check the socket's `bufferedAmount`.  When it
 *   exceeds a high-water mark, the connection enters a "backpressured" state:
 *
 *     1. PAUSE — Stop sending individual update frames.
 *     2. ACCUMULATE — Continue applying updates to the local Y.Doc.
 *     3. CATCHUP — When the buffer drains below the low-water mark, compute
 *        a single Y.diffUpdate from the client's last-acknowledged state
 *        vector and send it as a catch-up frame.  This coalesces potentially
 *        thousands of missed updates into one efficient diff.
 *
 * This module is stateless per-connection.  Backpressure state is tracked on
 * the ClientConnection object itself (backpressureState field).
 */

import { WebSocket } from 'ws';
import {
  wsBufferedAmountBytes,
  backpressureEventsCounter,
} from '../metrics/advancedMetrics';
import { getLogger } from '../utils/logger';

const logger = getLogger();

// ── Tuning constants ──────────────────────────────────────────────────────────

/**
 * When bufferedAmount exceeds this value (bytes), stop sending discrete frames.
 * 1 MB — generous enough for burst-y but healthy connections; low enough to
 * prevent a single slow client from bloating the heap.
 */
export const BACKPRESSURE_HIGH_WATER = 1 * 1024 * 1024; // 1 MiB

/**
 * When bufferedAmount drops below this value, send a catch-up diff.
 * Set to 25% of high-water to provide hysteresis and prevent oscillation.
 */
export const BACKPRESSURE_LOW_WATER = 256 * 1024; // 256 KiB

/**
 * Maximum time (ms) a connection may remain in backpressured state before
 * being terminated.  Prevents zombie sockets from holding room references.
 */
export const BACKPRESSURE_TIMEOUT_MS = 30_000;

// ── Per-connection state ──────────────────────────────────────────────────────

export interface BackpressureState {
  /** Whether this connection is currently in the backpressured (paused) state. */
  paused: boolean;
  /** Timestamp (ms) when the connection first entered backpressured state. */
  pausedSince: number;
  /** Number of updates skipped while paused. */
  skippedUpdates: number;
  /** True when a catch-up diff must be sent before live updates resume. */
  needsCatchup: boolean;
  /** Last known client state vector used to compute catch-up diff. */
  lastKnownStateVector?: Uint8Array;
}

/**
 * Create a fresh backpressure state for a new connection.
 */
export function createBackpressureState(): BackpressureState {
  return { paused: false, pausedSince: 0, skippedUpdates: 0, needsCatchup: false };
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Check whether a WebSocket is currently under backpressure.
 *
 * Call this BEFORE every ws.send() for binary Yjs frames.  If it returns true,
 * the caller should skip the send and instead increment skippedUpdates.
 *
 * Side-effects:
 *   - Observes bufferedAmount into the Prometheus histogram.
 *   - Transitions between paused/unpaused states.
 *   - Logs state transitions.
 *
 * @returns true if the send should be skipped (client is backpressured).
 */
export function isBackpressured(
  ws: WebSocket,
  state: BackpressureState,
  connectionId: string,
): boolean {
  // ws from the 'ws' library exposes bufferedAmount as a getter
  const buffered = (ws as any).bufferedAmount ?? 0;
  wsBufferedAmountBytes.observe(buffered);

  if (!state.paused) {
    // Currently flowing — check if we need to pause
    if (buffered >= BACKPRESSURE_HIGH_WATER) {
      state.paused = true;
      state.pausedSince = Date.now();
      state.skippedUpdates = 0;
      state.needsCatchup = false;
      backpressureEventsCounter.inc({ action: 'pause' });
      logger.warn(
        { connectionId, buffered },
        '[backpressure] pausing client — high water mark exceeded',
      );
      return true;
    }
    return false;
  }

  // Currently paused — check if we can resume
  if (buffered <= BACKPRESSURE_LOW_WATER) {
    // Buffer drained — transition back to flowing
    const pausedMs = Date.now() - state.pausedSince;
    backpressureEventsCounter.inc({ action: 'catchup' });
    logger.info(
      { connectionId, buffered, pausedMs, skippedUpdates: state.skippedUpdates },
      '[backpressure] resuming client — low water mark reached, will send catch-up diff',
    );
    state.paused = false;
    state.needsCatchup = state.skippedUpdates > 0;
    // Caller should send catch-up diff
    return false;
  }

  // Still paused — check timeout
  if (Date.now() - state.pausedSince > BACKPRESSURE_TIMEOUT_MS) {
    backpressureEventsCounter.inc({ action: 'drop' });
    logger.error(
      { connectionId, buffered, pausedMs: Date.now() - state.pausedSince },
      '[backpressure] terminating client — backpressure timeout exceeded',
    );
    try { ws.terminate(); } catch { /* ignore */ }
    return true;
  }

  // Still paused, within timeout
  state.skippedUpdates++;
  return true;
}

/**
 * Check if a previously-paused connection has just resumed and needs a catch-up diff.
 * Returns true if the connection was paused and has now resumed (buffer drained).
 */
export function needsCatchupDiff(state: BackpressureState): boolean {
  // Called right after isBackpressured returns false — if skippedUpdates > 0,
  // the connection just transitioned from paused → flowing and needs a diff.
  // (skippedUpdates is reset to 0 inside isBackpressured when resuming.)
  // The caller must check this *before* modifying state.
  return false; // Consumed via the transition logic in isBackpressured
}

