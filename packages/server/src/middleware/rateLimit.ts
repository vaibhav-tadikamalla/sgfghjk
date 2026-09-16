import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * In-memory sliding-window rate limiter.
 * No Redis required — uses a Map of timestamps per key.
 *
 * TODO(security): Replace with Redis-backed sliding window (e.g. ioredis + sorted sets)
 * for multi-node deployments. A per-process Map allows N×limit requests across N instances.
 */
const windows = new Map<string, number[]>();

// Periodic cleanup to prevent memory leaks
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of windows.entries()) {
    const filtered = timestamps.filter((t) => now - t < 3_600_000);
    if (filtered.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, filtered);
    }
  }
}, 60_000);
if (_cleanupTimer.unref) _cleanupTimer.unref();

export function createRateLimiter(options: {
  keyFn: (request: FastifyRequest) => string;
  maxRequests: number;
  windowSeconds: number;
  message?: string;
}) {
  const windowMs = options.windowSeconds * 1000;

  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = `ratelimit:${options.keyFn(request)}`;
    const now = Date.now();

    let timestamps = windows.get(key) ?? [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    reply.header('X-RateLimit-Limit', options.maxRequests);
    reply.header('X-RateLimit-Remaining', Math.max(0, options.maxRequests - timestamps.length));

    if (timestamps.length >= options.maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      reply.header('Retry-After', retryAfter);
      reply.code(429).send({
        error: 'Too Many Requests',
        message: options.message ?? 'Rate limit exceeded',
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    timestamps.push(now);
    windows.set(key, timestamps);
  };
}
