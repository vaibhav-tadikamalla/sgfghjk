import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from './config';
import { getLogger } from './utils/logger';
import { randomUUID } from 'node:crypto';
import { registerAuthMiddleware } from './auth/middleware';

// Route imports — Workspace system
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerFolderRoutes } from './routes/folders';
import { registerFileRoutes } from './routes/files';
import { registerPermissionRoutes } from './routes/permissions';
import { registerActivityRoutes } from './routes/activity';
import { registerSearchRoutes } from './routes/search';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerDebugRoutes } from './routes/debug';
import { registerAdminRoutes } from './routes/admin';
import { registerAdminDashboardRoutes } from './routes/admin-dashboard';
import { registerSimulationRoutes } from './routes/simulation';
import { registerRoutingRoutes } from './routes/routing';
import { registerVersionRoutes } from './routes/versions';
import { register as metricsRegistry } from './metrics/metrics';

function parseAdminTokenFromHeaders(headers: Record<string, unknown>): string | null {
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

function isAdminTokenValid(provided: string | null, secret: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const secretBuffer = Buffer.from(secret);
  if (providedBuffer.length !== secretBuffer.length) return false;
  return timingSafeEqual(providedBuffer, secretBuffer);
}

export async function createServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const logger = getLogger();
  const adminSecret = process.env['ADMIN_SECRET']?.trim() ?? '';

  if (config.NODE_ENV === 'production' && adminSecret.length === 0) {
    throw new Error('ADMIN_SECRET is required in production for admin, admin dashboard, and simulation routes.');
  }

  const app = Fastify({
    logger: false,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
    requestTimeout: 60_000,
  });

  // Plugins
  await app.register(cookie, {
    secret: config.COOKIE_SECRET,
    parseOptions: {},
  });

  await app.register(cors, {
    origin: config.NODE_ENV === 'production'
      ? [config.APP_URL]
      : ['http://localhost:4860', 'http://localhost:4870', 'http://localhost:5173'],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
  });

  // ── Correlation ID: read x-trace-id from upstream or generate a fresh UUID
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-trace-id'];
    request.traceId = (typeof incoming === 'string' && incoming.length > 0)
      ? incoming
      : randomUUID();
    reply.header('x-trace-id', request.traceId);
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    return payload;
  });

  // Auth middleware
  registerAuthMiddleware(app);

  // Error handler
  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const reqLog = logger.child({ traceId: request.traceId, reqId: request.id });
    if (statusCode >= 500) {
      reqLog.error({ err: error }, 'Unhandled server error');
    } else {
      reqLog.warn({ err: error }, 'Request error');
    }
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : (error.name || 'Error'),
      message: statusCode >= 500 ? 'An unexpected error occurred' : error.message,
      statusCode,
    });
  });

  // Not found handler
  app.setNotFoundHandler(async (_request, reply) => {
    reply.code(404).send({ error: 'Not Found', message: 'Route not found' });
  });

  // Register routes — workspace system
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerFolderRoutes(app);
  await registerFileRoutes(app);
  await registerPermissionRoutes(app);
  await registerActivityRoutes(app);
  await registerSearchRoutes(app);
  await registerDashboardRoutes(app);
  if (config.NODE_ENV !== 'production') {
    await registerDebugRoutes(app);
  }
  await registerAdminRoutes(app);
  await registerAdminDashboardRoutes(app);
  await registerSimulationRoutes(app);
  await registerRoutingRoutes(app);
  await registerVersionRoutes(app);

  // ── Prometheus metrics endpoint ───────────────────────────────────────────
  app.get('/metrics', async (request, reply) => {
    if (adminSecret.length === 0) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Metrics endpoint requires ADMIN_SECRET to be configured',
      });
    }

    const provided = parseAdminTokenFromHeaders(request.headers as Record<string, unknown>);
    if (!isAdminTokenValid(provided, adminSecret)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid admin token',
      });
    }

    reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(await metricsRegistry.metrics());
  });

  logger.info('Fastify server configured with workspace routes');
  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime?: number;
    /** Correlation trace ID — sourced from x-trace-id header or newly generated. */
    traceId: string;
  }
}
