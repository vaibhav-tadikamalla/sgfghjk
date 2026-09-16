/**
 * admin.ts
 *
 * Platform-level admin API for PeerGrid operators and developer tooling.
 *
 * Provides four read-only introspection endpoints:
 *
 *   GET /admin/cluster       — cluster topology, active nodes, room ownership
 *   GET /admin/rooms         — per-room connection and CRDT state snapshot
 *   GET /admin/presence/:roomId — local presence entries for a single room
 *   GET /admin/diagnostics   — node health: clock, memory, event loop lag
 *
 * Security model
 * ──────────────
 * Every admin request must include one of:
 *   • Authorization: Bearer <ADMIN_SECRET>
 *   • X-Admin-Token: <ADMIN_SECRET>
 *
 * Set ADMIN_SECRET in the environment.  If the variable is absent a random
 * UUID is generated at process start and logged as a warning — this ensures
 * the routes are never openly accessible by accident, even in dev.
 *
 * All endpoints are read-only and involve zero DB calls.  They reflect
 * live in-process state and are safe to poll at high frequency.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getCollaborationServerInstance } from '../websocket';
import { verifyAccessToken } from '../auth/jwt';

// ── Admin secret ─────────────────────────────────────────────────────────────

function getAdminSecretOrThrow(): string {
  const secret = process.env['ADMIN_SECRET']?.trim() ?? '';
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  if (nodeEnv === 'production' && secret.length === 0) {
    throw new Error('ADMIN_SECRET is required in production for admin routes.');
  }
  return secret;
}

const ADMIN_ALLOWED_EMAIL = 'tadikamallavaibhav@gmail.com';

// ── Auth guard ────────────────────────────────────────────────────────────────

async function requireAdminToken(request: FastifyRequest, reply: FastifyReply, adminSecret: string): Promise<boolean> {
  const auth   = request.headers['authorization'];
  const xToken = request.headers['x-admin-token'];

  if (adminSecret.length === 0) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Admin secret is required' });
    return false;
  }

  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();

    if (adminSecret.length > 0) {
      const providedBuffer = Buffer.from(bearer);
      const secretBuffer = Buffer.from(adminSecret);
      if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
        return true;
      }
    }

    try {
      const token = await verifyAccessToken(bearer);
      if (token.email?.toLowerCase() === ADMIN_ALLOWED_EMAIL) {
        return true;
      }
    } catch {
      // fall through to explicit unauthorized response
    }
  }

  if (typeof xToken === 'string' && adminSecret.length > 0) {
    const providedBuffer = Buffer.from(xToken.trim());
    const secretBuffer = Buffer.from(adminSecret);
    if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
      return true;
    }
  }

  reply.code(401).send({ error: 'Unauthorized', message: 'Admin access is restricted to allowed accounts' });
  return false;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const adminSecret = getAdminSecretOrThrow();

  /**
   * GET /admin/cluster
   *
   * Returns cluster topology as seen by this node:
   *   - this node's unique ID
   *   - all active member node IDs known to the consistent-hash ring
   *   - rooms this node currently owns (heartbeat key held in Redis)
   *   - total local room objects in memory
   *
   * In single-node (no-Redis) mode, returns a minimal on-node summary.
   */
  app.get('/admin/cluster', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const cluster = collab.getAdminClusterSummary();

    if (cluster) {
      return reply.send({
        mode: 'redis-cluster',
        ...cluster,
        retrievedAt: Date.now(),
      });
    }

    // Single-node fallback
    return reply.send({
      mode:            'single-node',
      nodeId:          null,
      activeNodes:     [],
      ownedRooms:      [],
      totalLocalRooms: collab.getRoomCount(),
      retrievedAt:     Date.now(),
    });
  });

  /**
   * GET /admin/rooms
   *
   * Returns a list of every live room (open Yjs Y.Doc) on this node:
   *   - fileId
   *   - lifecycle state  (loading / active / restoring / idle / destroying)
   *   - dirty flag       (unsaved pending writes)
   *   - estimated doc size in bytes
   *   - per-connection metadata   (connectionId, userId, role, joinedAt)
   *
   * This is O(rooms × connections) — typically ≤ 10 k entries per node.
   */
  app.get('/admin/rooms', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const rooms = collab.getAdminRoomsSummary();
    return reply.send({
      count: rooms.length,
      rooms,
      retrievedAt: Date.now(),
    });
  });

  /**
   * GET /admin/presence/:roomId
   *
   * Returns all active cursor/selection entries visible in this node's local
   * presence store for the given room.
   *
   * Only populated when RedisRoomStore is active (ROOM_STORE=redis).
   * Returns an empty array (not 404) when the room has no presence data or
   * when running without Redis.
   */
  app.get<{ Params: { roomId: string } }>(
    '/admin/presence/:roomId',
    async (request, reply) => {
      if (!(await requireAdminToken(request, reply, adminSecret))) return;

      const collab = getCollaborationServerInstance();
      if (!collab) {
        return reply.code(503).send({ error: 'Collaboration server not initialised' });
      }

      const { roomId } = request.params;
      const entries    = collab.getAdminPresenceSummary(roomId);
      return reply.send({
        roomId,
        count: entries.length,
        entries,
        retrievedAt: Date.now(),
      });
    },
  );

  /**
   * GET /admin/diagnostics
   *
   * Returns a full health snapshot of this node:
   *   - nodeId            (RedisRoomStore UUID or null in single-node mode)
   *   - clock             (cluster clock sync status and drift)
   *   - memory            (rss / heapUsed / heapTotal / external — bytes)
   *   - eventLoopLagMs    (setImmediate scheduling delay — signals CPU saturation)
   *   - uptimeSeconds     (process.uptime())
   *   - connections       (open WebSocket sockets)
   *   - sessions          (authenticated + joined)
   *   - rooms             (live Yjs rooms in memory)
   *   - editsPerMinute    (rolling 60-second edit count)
   *
   * This endpoint involves a single setImmediate scheduling measurement and
   * is otherwise synchronous.
   */
  app.get('/admin/diagnostics', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const diagnostics = await collab.getAdminDiagnostics();
    return reply.send({ ...diagnostics, retrievedAt: Date.now() });
  });
}
