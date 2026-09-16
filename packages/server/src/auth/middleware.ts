import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { verifyAccessToken, AccessTokenPayload } from './jwt';
import { getLogger } from '../utils/logger';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenPayload;
    requestId: string;
    startTime?: number;
  }
}

export function registerAuthMiddleware(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    request.startTime = Date.now();
  });
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const logger = getLogger();

  try {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);
    request.user = payload;
  } catch (err) {
    logger.warn({ err }, 'Authentication failed');
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

export async function optionalAuthenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return;

    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);
    request.user = payload;
  } catch {
    // Ignore auth errors for optional auth
  }
}
