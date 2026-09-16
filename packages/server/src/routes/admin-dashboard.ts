/**
 * admin-dashboard.ts
 *
 * Operational dashboard API for PeerGrid managers and operators.
 *
 * Provides comprehensive runtime observability endpoints under /admin/dashboard:
 *
 *   GET /admin/dashboard/summary     — full system snapshot (system, rooms, users, cluster)
 *   GET /admin/dashboard/rooms       — per-room activity with sorting
 *   GET /admin/dashboard/users       — per-user activity
 *   GET /admin/dashboard/health      — collaboration health & replication status
 *   GET /admin/dashboard/analytics   — usage analytics (rates, trends)
 *
 * All endpoints are read-only, O(rooms + connections), and involve zero DB calls.
 * Data is sourced from live in-memory state of the CollaborationServer singleton.
 *
 * Security: shares the same ADMIN_SECRET token scheme as admin.ts.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getCollaborationServerInstance } from '../websocket';
import { register as metricsRegistry } from '../metrics/metrics';
import { editTrackingService } from '../services/editTrackingService';
import { verifyAccessToken } from '../auth/jwt';

// ── Admin secret (reuses same env var as admin.ts) ────────────────────────────

function getAdminSecretOrThrow(): string {
  const secret = process.env['ADMIN_SECRET']?.trim() ?? '';
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  if (nodeEnv === 'production' && secret.length === 0) {
    throw new Error('ADMIN_SECRET is required in production for admin dashboard routes.');
  }
  return secret;
}

const ADMIN_ALLOWED_EMAIL = 'tadikamallavaibhav@gmail.com';

async function requireAdminToken(request: FastifyRequest, reply: FastifyReply, secret: string): Promise<boolean> {
  if (secret.length === 0) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Admin secret is required' });
    return false;
  }

  const auth   = request.headers['authorization'];
  const xToken = request.headers['x-admin-token'];

  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const bearer = auth.slice(7).trim();

    const providedBuffer = Buffer.from(bearer);
    const secretBuffer = Buffer.from(secret);
    if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
      return true;
    }

    try {
      const token = await verifyAccessToken(bearer);
      if (token.email?.toLowerCase() === ADMIN_ALLOWED_EMAIL) {
        return true;
      }
    } catch {
      // fall through to unauthorized response
    }
  }

  if (typeof xToken === 'string') {
    const providedBuffer = Buffer.from(xToken.trim());
    const secretBuffer = Buffer.from(secret);
    if (providedBuffer.length === secretBuffer.length && timingSafeEqual(providedBuffer, secretBuffer)) {
      return true;
    }
  }

  reply.code(401).send({ error: 'Unauthorized', message: 'Admin access is restricted to allowed accounts' });
  return false;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerAdminDashboardRoutes(app: FastifyInstance): Promise<void> {
  const adminSecret = getAdminSecretOrThrow();

  /**
   * GET /admin/dashboard/summary
   *
   * Full system snapshot: global metrics, per-room stats, per-user activity,
   * and cluster topology.  Intended for the main dashboard view.
   */
  app.get('/admin/dashboard/summary', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    return reply.send({
      ...collab.getAdminDashboardSummary(),
      retrievedAt: Date.now(),
    });
  });

  /**
   * GET /admin/dashboard/rooms
   *
   * Document activity panel.
   * Returns rooms sorted by activity (most recently active first) with
   * per-room edit stats, idle detection, and edits-per-minute estimates.
   */
  app.get('/admin/dashboard/rooms', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const summary = collab.getAdminDashboardSummary();
    const now = Date.now();
    const IDLE_THRESHOLD_MS = 300_000; // 5 minutes

    const rooms = summary.rooms
      .map(r => ({
        ...r,
        idleSinceMs: now - r.lastActivityTimestamp,
        isIdle: (now - r.lastActivityTimestamp) > IDLE_THRESHOLD_MS,
      }))
      .sort((a, b) => b.lastActivityTimestamp - a.lastActivityTimestamp);

    // Most-edited (by total updates applied)
    const mostEdited = [...rooms].sort((a, b) => b.updatesApplied - a.updatesApplied).slice(0, 10);
    // Most editors
    const mostEditors = [...rooms].sort((a, b) => b.editors - a.editors).slice(0, 10);
    // Idle documents
    const idleRooms = rooms.filter(r => r.isIdle);

    return reply.send({
      totalRooms: rooms.length,
      rooms,
      mostEdited,
      mostEditors,
      idleRooms,
      retrievedAt: now,
    });
  });

  /**
   * GET /admin/dashboard/users
   *
   * User activity panel.
   * Returns per-user session info sorted by most recent activity.
   */
  app.get('/admin/dashboard/users', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const summary = collab.getAdminDashboardSummary();
    const users = summary.users
      .sort((a, b) => b.lastActivityTimestamp - a.lastActivityTimestamp);

    return reply.send({
      totalUsers: users.length,
      users,
      retrievedAt: Date.now(),
    });
  });

  /**
   * GET /admin/dashboard/health
   *
   * Collaboration health panel.
   * Returns mirror replica status, owner node mapping, and replication metrics.
   */
  app.get('/admin/dashboard/health', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const summary = collab.getAdminDashboardSummary();
    const mem = process.memoryUsage();

    const mirrorRooms = summary.rooms.filter(r => r.mirrors);
    const dirtyRooms  = summary.rooms.filter(r => r.dirty);

    // Owner node distribution
    const ownerDistribution = new Map<string, number>();
    for (const r of summary.rooms) {
      const owner = r.ownerNode ?? 'local';
      ownerDistribution.set(owner, (ownerDistribution.get(owner) ?? 0) + 1);
    }

    return reply.send({
      cluster: summary.cluster,
      totalRooms: summary.rooms.length,
      mirrorReplicas: mirrorRooms.length,
      mirrorRoomIds: mirrorRooms.map(r => r.roomId),
      dirtyRooms: dirtyRooms.length,
      ownerNodeDistribution: Object.fromEntries(ownerDistribution),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      uptimeSeconds: process.uptime(),
      retrievedAt: Date.now(),
    });
  });

  /**
   * GET /admin/dashboard/analytics
   *
   * Usage analytics panel.
   * Returns rate-based metrics and current snapshot for trend visualization.
   */
  app.get('/admin/dashboard/analytics', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const summary = collab.getAdminDashboardSummary();
    const now = Date.now();
    const reviewerMetrics = await editTrackingService.getReviewerVisibilityMetrics(20);

    // Per-room update rates (updates per minute estimate based on room age)
    const roomRates = summary.rooms.map(r => {
      const ageMs = Math.max(now - r.lastActivityTimestamp, 1);
      const ageMins = ageMs / 60_000;
      return {
        roomId: r.roomId,
        updatesApplied: r.updatesApplied,
        updatesBroadcast: r.updatesBroadcast,
        editors: r.editors,
        connections: r.connections,
      };
    });

    return reply.send({
      editsPerMinute: summary.system.editsPerMinute,
      activeEditors: summary.system.activeEditors,
      activeViewers: summary.system.activeViewers,
      activeUsers: summary.system.activeUsers,
      totalRooms: summary.system.totalRooms,
      websocketConnections: summary.system.websocketConnections,
      roomRates,
      pasteEventsPerSession: reviewerMetrics.pasteEventsPerSession,
      avgEditsPerMinuteByUserFile: reviewerMetrics.avgEditsPerMinuteByUserFile,
      retrievedAt: now,
    });
  });

  /**
   * GET /admin/dashboard/activity-history
   *
   * Returns a time-series ring buffer of server activity snapshots.
   * Each entry is sampled every 5 seconds; the buffer holds up to 60 entries
   * (5 minutes of history), ordered oldest → newest.
   *
   * Used by the Realtime Activity Graph to show edits/sec, connections,
   * and room count over time.
   */
  app.get('/admin/dashboard/activity-history', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const history = collab.getActivityHistory();

    return reply.send({
      sampleIntervalMs: 5_000,
      maxSamples: 60,
      samples: history,
      retrievedAt: Date.now(),
    });
  });

  /**
   * GET /admin/dashboard/topology
   *
   * Cluster topology view — detailed per-node metrics for the topology panel.
   * Returns node-level breakdown of rooms owned, mirror replicas, and
   * connections routed through each node.  In single-node mode, returns
   * a single entry for the local node.
   */
  app.get('/admin/dashboard/topology', async (request, reply) => {
    if (!(await requireAdminToken(request, reply, adminSecret))) return;

    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const summary = collab.getAdminDashboardSummary();

    // Build per-node breakdown
    const nodeMap = new Map<string, {
      nodeId: string;
      ownedRooms: number;
      mirrorReplicas: number;
      connections: number;
      totalUpdatesApplied: number;
      roomIds: string[];
    }>();

    for (const room of summary.rooms) {
      const nodeId = room.ownerNode ?? 'local';
      let entry = nodeMap.get(nodeId);
      if (!entry) {
        entry = {
          nodeId,
          ownedRooms: 0,
          mirrorReplicas: 0,
          connections: 0,
          totalUpdatesApplied: 0,
          roomIds: [],
        };
        nodeMap.set(nodeId, entry);
      }
      entry.ownedRooms++;
      entry.connections += room.connections;
      entry.totalUpdatesApplied += room.updatesApplied;
      entry.roomIds.push(room.roomId);
      if (room.mirrors) entry.mirrorReplicas++;
    }

    // Ensure we have entries for all known cluster nodes (even if they own 0 rooms locally)
    for (const activeNode of summary.cluster.activeNodes) {
      if (!nodeMap.has(activeNode)) {
        nodeMap.set(activeNode, {
          nodeId: activeNode,
          ownedRooms: 0,
          mirrorReplicas: 0,
          connections: 0,
          totalUpdatesApplied: 0,
          roomIds: [],
        });
      }
    }

    const nodes = Array.from(nodeMap.values()).sort((a, b) => b.ownedRooms - a.ownedRooms);

    return reply.send({
      mode: summary.cluster.mode,
      localNodeId: summary.cluster.nodeId,
      totalRooms: summary.rooms.length,
      totalConnections: summary.system.websocketConnections,
      nodes,
      retrievedAt: Date.now(),
    });
  });
}
