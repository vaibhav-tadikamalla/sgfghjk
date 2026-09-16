/**
 * reconnectAdmission.ts
 *
 * Token-bucket rate limiter for WebSocket reconnect admission control.
 *
 * Problem:  When a PeerGrid node crashes while hosting 2 000 clients, all
 *           clients reconnect simultaneously to the surviving nodes.
 *           This "reconnect storm" causes:
 *             • CPU spike from concurrent TLS + WS handshakes
 *             • Redis lock contention as rooms are re-opened
 *             • Postgres snapshot loading burst
 *             • Stream replay overload
 *
 * Solution: Token-bucket limiter at the WebSocket connection handler.
 *           Excess connections receive a jittered `retryAfterMs` hint
 *           so clients naturally spread their reattempts over time.
 *
 * Algorithm:
 *   - Bucket starts full at `bucketCapacity` tokens.
 *   - Each admitted connection consumes 1 token.
 *   - Tokens refill at `refillRate` per second, up to capacity.
 *   - If no tokens → reject with a random retryAfterMs in [minRetryMs, maxRetryMs].
 *
 * All timing uses the cluster-wide monotonic clock via getClusterTimeMs().
 */

import { getClusterTimeMs } from './clusterClock';

// ── Configuration ────────────────────────────────────────────────────────────

export interface ReconnectAdmissionConfig {
  /**
   * Maximum tokens in the bucket (also initial fill).
   * Each admitted connection costs 1 token.
   * @default 500
   */
  bucketCapacity: number;

  /**
   * Tokens replenished per second.
   * @default 500
   */
  refillRate: number;

  /**
   * Minimum jittered retry delay returned to rejected clients (ms).
   * @default 50
   */
  minRetryMs: number;

  /**
   * Maximum jittered retry delay returned to rejected clients (ms).
   * @default 500
   */
  maxRetryMs: number;
}

const DEFAULT_CONFIG: ReconnectAdmissionConfig = {
  bucketCapacity: 500,
  refillRate: 500,
  minRetryMs: 50,
  maxRetryMs: 500,
};

// ── Admission decision ───────────────────────────────────────────────────────

export type AdmissionResult =
  | { admitted: true }
  | { admitted: false; retryAfterMs: number };

// ── Token-bucket implementation ──────────────────────────────────────────────

export class ReconnectAdmissionController {
  private readonly config: ReconnectAdmissionConfig;

  /** Current number of available tokens (fractional during refill). */
  private tokens: number;

  /** Cluster-clock timestamp (ms) of the last refill calculation. */
  private lastRefillTime: number;

  /**
   * Number of connections currently waiting / queued.
   * Exported as a metric via `getQueueDepth()`.
   */
  private queueDepth = 0;

  constructor(config: Partial<ReconnectAdmissionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokens = this.config.bucketCapacity;
    this.lastRefillTime = getClusterTimeMs();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Try to admit a new connection.
   *
   * @returns `{ admitted: true }` if allowed through immediately,
   *          or `{ admitted: false, retryAfterMs }` with a jittered
   *          delay the client should wait before retrying.
   */
  tryAdmit(): AdmissionResult {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { admitted: true };
    }

    // No tokens available — compute jittered retry delay
    const { minRetryMs, maxRetryMs } = this.config;
    const retryAfterMs = Math.round(
      minRetryMs + Math.random() * (maxRetryMs - minRetryMs),
    );

    return { admitted: false, retryAfterMs };
  }

  /**
   * Increment the queue depth counter (called when a connection is
   * waiting for admission or has been told to retry).
   */
  incrementQueueDepth(): void {
    this.queueDepth++;
  }

  /**
   * Decrement the queue depth counter (called when a waiting connection
   * is finally admitted or gives up).
   */
  decrementQueueDepth(): void {
    if (this.queueDepth > 0) this.queueDepth--;
  }

  /** Current queue depth — surfaced as a Prometheus gauge. */
  getQueueDepth(): number {
    return this.queueDepth;
  }

  /** Current available tokens (for testing / debugging). */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Reset the bucket to full capacity (useful after planned maintenance
   * or in tests).
   */
  reset(): void {
    this.tokens = this.config.bucketCapacity;
    this.lastRefillTime = getClusterTimeMs();
    this.queueDepth = 0;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Refill tokens based on elapsed time since last refill.
   * Uses monotonic cluster clock to avoid backward-time issues.
   */
  private refill(): void {
    const now = getClusterTimeMs();
    const elapsedMs = now - this.lastRefillTime;
    if (elapsedMs <= 0) return; // clock hasn't advanced

    const newTokens = (elapsedMs / 1000) * this.config.refillRate;
    this.tokens = Math.min(this.config.bucketCapacity, this.tokens + newTokens);
    this.lastRefillTime = now;
  }
}
