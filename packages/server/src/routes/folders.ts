import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { folderService } from '../services/folderService';
import { permissionService } from '../services/workspacePermissionService';

const createSchema = z.object({ name: z.string().min(1).max(255) });
const renameSchema = z.object({ name: z.string().min(1).max(255) });
const paramsSchema = z.object({ folderId: z.string().uuid() });

export async function registerFolderRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/folders — list user's folders
  app.get('/api/folders', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.user!.sub;
    const folders = await folderService.listForUser(userId);
    return reply.send(folders);
  });

  // POST /api/folders — create folder
  app.post('/api/folders', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors });
    }
    const userId = request.user!.sub;
    const folder = await folderService.create(parsed.data.name, userId);
    return reply.code(201).send(folder);
  });

  // GET /api/folders/:folderId — get folder details
  app.get('/api/folders/:folderId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canRead(params.data.folderId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const folder = await folderService.getById(params.data.folderId);
    if (!folder) return reply.code(404).send({ error: 'Not Found' });
    const role = await permissionService.getRole(params.data.folderId, userId);
    return reply.send({ ...folder, role });
  });

  // PATCH /api/folders/:folderId — rename
  app.patch('/api/folders/:folderId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const body = renameSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation Error', details: body.error.errors });
    const userId = request.user!.sub;
    const isOwner = await permissionService.isOwner(params.data.folderId, userId);
    if (!isOwner) return reply.code(404).send({ error: 'Not Found' });
    const folder = await folderService.rename(params.data.folderId, body.data.name, userId);
    return reply.send(folder);
  });

  // DELETE /api/folders/:folderId — delete
  app.delete('/api/folders/:folderId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const isOwner = await permissionService.isOwner(params.data.folderId, userId);
    if (!isOwner) return reply.code(404).send({ error: 'Not Found' });

    // Collect file IDs before cascade-delete so we can close active WS rooms
    const { query } = await import('../db/pool');
    const filesResult = await query<{ id: string }>(
      'SELECT id FROM files WHERE folder_id = $1',
      [params.data.folderId],
    );
    const fileIds = filesResult.rows.map((r) => r.id);

    await folderService.remove(params.data.folderId, userId);

    // Close any active WebSocket rooms for files that just got cascade-deleted
    if (fileIds.length > 0) {
      const { getCollaborationServerInstance } = await import('../websocket');
      const collabServer = getCollaborationServerInstance();
      if (collabServer) {
        collabServer.closeRoomsForFolder(fileIds);
      }
    }

    return reply.code(204).send();
  });
}
