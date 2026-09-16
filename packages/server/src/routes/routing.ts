import type { FastifyInstance } from 'fastify';
import { getCollaborationServerInstance } from '../websocket';
import { authenticate } from '../auth/middleware';

/**
 * Room-affinity routing endpoint.
 *
 * GET /route/room/:roomId
 *
 * Uses the consistent-hash ring to resolve the current owner node for a room
 * and returns the websocket URL clients should connect to.
 *
 * Requires authentication — unauthenticated callers get 401.
 */
export async function registerRoutingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { roomId: string } }>('/route/room/:roomId', { preHandler: [authenticate] }, async (request, reply) => {
    const collab = getCollaborationServerInstance();
    if (!collab) {
      return reply.code(503).send({ error: 'Collaboration server not initialised' });
    }

    const roomId = request.params.roomId;
    const hostHeader = request.headers['x-forwarded-host'] ?? request.headers['host'];
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const protocol = request.protocol === 'https' ? 'https' : 'http';

    const route = await collab.getRoomAffinityRoute(roomId, {
      protocol,
      host: host ?? undefined,
    });

    if (!route.ownerNodeId) {
      return reply.code(503).send({
        roomId,
        ownerNodeId: null,
        ownerAddress: null,
        websocketUrl: null,
        message: 'No active cluster nodes available for routing',
      });
    }

    return reply.send(route);
  });
}
