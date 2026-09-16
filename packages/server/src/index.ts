import 'dotenv/config';
import net from 'node:net';
import { loadConfig, getConfig } from './config';
import { createLogger, getLogger } from './utils/logger';
import { createPool, shutdownPool, query } from './db/pool';
import { initializeKeys } from './auth/jwt';
import { createServer } from './server';
import { CollaborationServer, setCollaborationServerInstance } from './websocket';
import { InMemoryRoomStore } from './ws/RoomStore';
import { RedisRoomStore } from './ws/RedisRoomStore';
import { setPermissionChangeHook } from './services/workspacePermissionService';

async function assertPortAvailable(port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use on ${host}`));
        return;
      }
      reject(err);
    });
    probe.once('listening', () => {
      probe.close((closeErr) => {
        if (closeErr) { reject(closeErr); return; }
        resolve();
      });
    });
    probe.listen(port, host);
  });
}

async function waitForDatabase(maxAttempts = 20): Promise<void> {
  const logger = getLogger();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await query('SELECT 1');
      logger.info({ attempt }, 'Database ready');
      return;
    } catch (err) {
      logger.warn({ attempt, err }, 'Database not ready yet');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Database not reachable after max attempts');
}

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();

  // 2. Logger
  createLogger();
  const logger = getLogger();
  logger.info({ instanceId: config.INSTANCE_ID, port: config.PORT }, 'Starting server');

  // 3. JWT keys
  await initializeKeys();
  logger.info('JWT keys initialized');

  // 4. Database
  createPool();
  logger.info('Database pool created');
  await waitForDatabase();

  // 5. HTTP server
  const app = await createServer();

  // 6. WebSocket collaboration
  //    ROOM_STORE=redis  → distributed RedisRoomStore (requires REDIS_URL)
  //    ROOM_STORE=memory → in-process InMemoryRoomStore (default)
  const roomStore =
    process.env['ROOM_STORE'] === 'redis'
      ? new RedisRoomStore()
      : new InMemoryRoomStore();
  logger.info(
    { backend: process.env['ROOM_STORE'] === 'redis' ? 'redis' : 'memory' },
    'RoomStore initialised',
  );

  const collabServer = new CollaborationServer(roomStore);
  setCollaborationServerInstance(collabServer);
  // Wire the permission-change hook so revocations/downgrades close live WS connections
  setPermissionChangeHook((folderId, userId) => {
    collabServer.disconnectUserFromFolder(userId, folderId);
  });
  app.server.on('upgrade', (request, socket, head) => {
    void collabServer.handleUpgrade(request, socket, head);
  });
  logger.info('Collaboration WebSocket server attached');

  // 7. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully…');

    try { await collabServer.shutdown(); } catch (e) { logger.error(e, 'WS shutdown error'); }
    if (roomStore instanceof RedisRoomStore) {
      try { await roomStore.close(); } catch (e) { logger.error(e, 'RoomStore close error'); }
    }
    try { await app.close(); } catch (e) { logger.error(e, 'Fastify close error'); }
    try { await shutdownPool(); } catch (e) { logger.error(e, 'DB pool shutdown error'); }

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 8. Listen
  const host = '0.0.0.0';
  const port = config.PORT;
  await assertPortAvailable(port, host);
  await app.listen({ host, port });

  logger.info({ host, port, env: config.NODE_ENV }, `Server listening on http://${host}:${port}`);
  logger.info(`WebSocket endpoint: ws://${host}:${port}/ws`);
  logger.info('✅ Server is ready');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
