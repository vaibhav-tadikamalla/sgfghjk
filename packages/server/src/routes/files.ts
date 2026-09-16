import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { fileService } from '../services/fileService';
import { permissionService } from '../services/workspacePermissionService';
import { editTrackingService } from '../services/editTrackingService';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: z.string().uuid(),
});
const renameSchema = z.object({ name: z.string().min(1).max(255) });
const recordPasteSchema = z.object({ count: z.number().int().positive().max(20).default(1) });
const fileParamsSchema = z.object({ fileId: z.string().uuid() });
const folderParamsSchema = z.object({ folderId: z.string().uuid() });

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/files — create file
  app.post('/api/files', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', details: parsed.error.errors });
    }
    const userId = request.user!.sub;
    const canWrite = await permissionService.canWrite(parsed.data.folderId, userId);
    if (!canWrite) return reply.code(404).send({ error: 'Not Found' });
    const file = await fileService.create(parsed.data.name, parsed.data.folderId, userId);
    return reply.code(201).send(file);
  });

  // GET /api/folders/:folderId/files — list files in folder
  app.get('/api/folders/:folderId/files', { preHandler: [authenticate] }, async (request, reply) => {
    const params = folderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canRead(params.data.folderId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const files = await fileService.listInFolder(params.data.folderId);
    return reply.send(files);
  });

  // GET /api/files/:fileId — get file details
  app.get('/api/files/:fileId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canReadFile(params.data.fileId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const file = await fileService.getById(params.data.fileId);
    if (!file) return reply.code(404).send({ error: 'Not Found' });
    return reply.send(file);
  });

  // PATCH /api/files/:fileId — rename
  app.patch('/api/files/:fileId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const body = renameSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation Error', details: body.error.errors });
    const userId = request.user!.sub;
    const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
    if (!canWrite) return reply.code(404).send({ error: 'Not Found' });
    const file = await fileService.rename(params.data.fileId, body.data.name, userId);
    return reply.send(file);
  });

  // DELETE /api/files/:fileId — soft delete (move to trash)
  app.delete('/api/files/:fileId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
    if (!canWrite) return reply.code(404).send({ error: 'Not Found' });
    await fileService.softDelete(params.data.fileId, userId);
    return reply.code(204).send();
  });

  // POST /api/files/:fileId/restore — restore from trash
  app.post('/api/files/:fileId/restore', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
    if (!canWrite) return reply.code(404).send({ error: 'Not Found' });
    await fileService.restore(params.data.fileId, userId);
    return reply.send({ success: true });
  });

  // GET /api/folders/:folderId/trash — list trash
  app.get('/api/folders/:folderId/trash', { preHandler: [authenticate] }, async (request, reply) => {
    const params = folderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canRead(params.data.folderId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const files = await fileService.listTrash(params.data.folderId);
    return reply.send(files);
  });

  // DELETE /api/files/:fileId/permanent — permanently delete
  app.delete('/api/files/:fileId/permanent', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const folderId = await permissionService.getFolderIdForFile(params.data.fileId);
    if (!folderId) return reply.code(404).send({ error: 'Not Found' });
    const isOwner = await permissionService.isOwner(folderId, userId);
    if (!isOwner) return reply.code(404).send({ error: 'Not Found' });
    await fileService.permanentDelete(params.data.fileId);
    return reply.code(204).send();
  });

  // GET /api/files/:fileId/contributors — get contributors
  app.get('/api/files/:fileId/contributors', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canReadFile(params.data.fileId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const contributors = await editTrackingService.getContributors(params.data.fileId);
    return reply.send(contributors);
  });

  // POST /api/files/:fileId/session/paste — record paste events for active session
  app.post('/api/files/:fileId/session/paste', { preHandler: [authenticate] }, async (request, reply) => {
    const params = fileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });
    const body = recordPasteSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Validation Error', details: body.error.errors });

    const userId = request.user!.sub;
    const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
    if (!canWrite) return reply.code(404).send({ error: 'Not Found' });

    await editTrackingService.incrementPasteEventsBy(params.data.fileId, userId, body.data.count);
    return reply.code(204).send();
  });
}
