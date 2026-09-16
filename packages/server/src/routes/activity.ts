import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { activityService } from '../services/activityService';
import { permissionService } from '../services/workspacePermissionService';

const folderParamsSchema = z.object({ folderId: z.string().uuid() });
const fileParamsSchema = z.object({ fileId: z.string().uuid() });

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/folders/:folderId/activity — folder activity (includes file activity)
  app.get('/api/folders/:folderId/activity', { preHandler: [authenticate] }, async (request, reply) => {
    const params = folderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canRead(params.data.folderId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const activity = await activityService.listForFolder(params.data.folderId);
    return reply.send(activity);
  });

  // GET /api/files/:fileId/activity — file activity
  app.get('/api/files/:fileId/activity', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canReadFile(params.data.fileId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const activity = await activityService.listForEntity('file', params.data.fileId);
    return reply.send(activity);
  });
}
