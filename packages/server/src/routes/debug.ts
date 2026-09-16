/**
 * debug.ts
 *
 * Temporary observability endpoint for stress testing.
 * Returns live in-memory state from CollaborationServer — no DB calls.
 *
 * Enable the 5-second console logger by starting the server with:
 *   STRESS_DEBUG=true node dist/index.js
 *
 * Remove this file (and its registration in server.ts) before shipping to
 * a publicly-routable production environment.
 */

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getCollaborationServerInstance } from '../websocket';

function parseAdminToken(headers: Record<string, unknown>): string | null {
  const authorization = headers['authorization'];
  const xAdminToken = headers['x-admin-token'];

  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim() || null;
  }
  if (typeof xAdminToken === 'string') {
    return xAdminToken.trim() || null;
  }
  return null;
}

function isTokenValid(token: string | null, secret: string): boolean {
  if (!token) return false;
  const tokenBuffer = Buffer.from(token);
  const secretBuffer = Buffer.from(secret);
  if (tokenBuffer.length !== secretBuffer.length) return false;
  return timingSafeEqual(tokenBuffer, secretBuffer);
}

export async function registerDebugRoutes(app: FastifyInstance): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const adminSecret = process.env['ADMIN_SECRET']?.trim() ?? '';

  if (nodeEnv === 'production') {
    return;
  }

  function authorizeDebug(headers: Record<string, unknown>): boolean {
    if (adminSecret.length === 0) {
      return true;
    }
    return isTokenValid(parseAdminToken(headers), adminSecret);
  }

  /**
   * GET /debug/state
   *
   * Returns a snapshot of live collaboration-server metrics.
   * All values are O(1) reads except `sessions` (O(n) scan of allConnections,
   * which is bounded by MAX_SESSIONS_PER_USER × unique users).
   *
   * Metric glossary (relevant to S1 — 50 concurrent editors):
   *
   *   connections          All open WS sockets including unauthenticated ones.
   *                        Rises to 50 during ramp-up; should stabilise there.
   *
   *   sessions             Connections that completed auth and joined a room.
   *                        Should equal `connections` once all 50 auth.
   *
   *   rooms                Live Yjs Y.Doc objects. Should be exactly 1 (one
   *                        shared file) for the entire S1 run.
   *
   *   userConnectionMapSize Distinct authenticated users. Should equal `sessions`
   *                        when each user has exactly one tab open.
   *
   *   burstTrackerSize     Per-connection burst-throttle entries.  Allocated on
   *                        first sync frame; deleted on disconnect.  A value
   *                        lower than `sessions` means some connections have not
   *                        yet sent a sync frame.
   *
   *   sessionTrackerSize   Sessions registered in SessionTrackingService (used
   *                        by the dashboard). Should converge to `sessions`.
   *
   *   editsPerMinute       Rolling 60-second Yjs update count server-wide.
   *                        Confirms editing load is actually reaching the server.
   *
   *   memory.heapUsed      V8 heap in bytes. Watch for monotonic growth (leak).
   *   memory.heapTotal     V8 heap capacity committed from OS.
   *   memory.rss           Resident set size. Includes native buffers and Yjs
   *                        ArrayBuffers outside V8 heap.
   */
  app.get('/debug/state', async (request, reply) => {
    if (!authorizeDebug(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid admin token' });
    }

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const m = process.memoryUsage();

    return reply.send({
      connections: collab.getConnectionCount(),
      sessions: collab.getSessionCount(),
      rooms: collab.getRoomCount(),
      userConnectionMapSize: collab.getUserConnectionCount(),
      burstTrackerSize: collab.getBurstTrackerSize(),
      sessionTrackerSize: collab.getSessionTrackerSize(),
      editsPerMinute: collab.getEditsPerMinute(),
      memory: {
        rss: m.rss,
        heapUsed: m.heapUsed,
        heapTotal: m.heapTotal,
      },
    });
  });

  /**
   * GET /debug/rooms
   *
   * Per-room runtime observability snapshot.
   * Returns per-room stats (editors, viewers, connections, mirrors,
   * updatesApplied, updatesBroadcast, ownerNode) plus aggregate totals.
   *
   * Complexity: O(rooms × connections-per-room).
   * No DB calls, no CRDT access, no locks.
   */
  app.get('/debug/rooms', async (request, reply) => {
    if (!authorizeDebug(request.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid admin token' });
    }

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    return reply.send(collab.getDebugRoomsSummary());
  });
}
