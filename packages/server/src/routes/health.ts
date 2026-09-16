import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/pool';

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

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const adminSecret = process.env['ADMIN_SECRET']?.trim() ?? '';
  // GET /health — liveness probe
  app.get('/health', async (_request, reply) => {
    const memUsage = process.memoryUsage();
    return reply.code(200).send({
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    });
  });

  // GET /health/ready — readiness probe
  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, { status: string; latencyMs?: number }> = {};
    let healthy = true;

    // PostgreSQL check
    try {
      const start = Date.now();
      await getPool().query('SELECT 1');
      checks.postgres = { status: 'ok', latencyMs: Date.now() - start };
    } catch {
      checks.postgres = { status: 'error' };
      healthy = false;
    }

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /health/db — pool saturation metrics (admin-only)
  app.get('/health/db', async (request, reply) => {
    if (adminSecret.length === 0) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: '/health/db requires ADMIN_SECRET to be configured',
      });
    }

    const provided = parseAdminToken(request.headers as Record<string, unknown>);
    if (!provided) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Missing admin token' });
    }
    const providedBuf = Buffer.from(provided);
    const secretBuf = Buffer.from(adminSecret);
    if (providedBuf.length !== secretBuf.length || !timingSafeEqual(providedBuf, secretBuf)) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid admin token' });
    }

    const pool = getPool();
    try {
      await pool.query('SELECT 1');
      return reply.code(200).send({
        status: 'ok',
        db: {
          connected: true,
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingClients: pool.waitingCount,
        },
      });
    } catch {
      return reply.code(500).send({
        status: 'error',
        db: {
          connected: false,
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingClients: pool.waitingCount,
        },
      });
    }
  });
}
