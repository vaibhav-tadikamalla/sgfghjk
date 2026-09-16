import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { permissionService, WorkspaceRole } from '../services/workspacePermissionService';

const grantSchema = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'viewer']),
});
const paramsSchema = z.object({ folderId: z.string().uuid() });
const removeSchema = z.object({ userId: z.string().uuid() });

export async function registerPermissionRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/folders/:folderId/permissions — list permissions
  app.get('/api/folders/:folderId/permissions', { preHandler: [authenticate] }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const userId = request.user!.sub;
    const canRead = await permissionService.canRead(params.data.folderId, userId);
    if (!canRead) return reply.code(404).send({ error: 'Not Found' });
    const permissions = await permissionService.listPermissions(params.data.folderId);
    return reply.send(permissions);
  });

  // POST /api/folders/:folderId/permissions — grant role (by email)
  app.post('/api/folders/:folderId/permissions', { preHandler: [authenticate] }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid folder ID' });
    const body = grantSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation Error', details: body.error.errors });

    const userId = request.user!.sub;
    const isOwner = await permissionService.isOwner(params.data.folderId, userId);
    if (!isOwner) return reply.code(404).send({ error: 'Not Found' });

    // Look up user by email
    const { query } = await import('../db/pool');
    const userResult = await query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [body.data.email.toLowerCase().trim()],
    );
    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found', message: 'No user with that email exists' });
    }

    const targetUserId = userResult.rows[0].id;
    if (targetUserId === userId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Cannot change your own permissions' });
    }

    await permissionService.grantRole(params.data.folderId, targetUserId, body.data.role);

    // Log activity
    const { activityService } = await import('../services/activityService');
    await activityService.log(userId, 'role_assigned', 'folder', params.data.folderId, {
      targetUserId,
      role: body.data.role,
      email: body.data.email,
    });

    return reply.code(201).send({ success: true });
  });

  // DELETE /api/folders/:folderId/permissions/:userId — revoke
  app.delete('/api/folders/:folderId/permissions/:userId', { preHandler: [authenticate] }, async (request, reply) => {
    const params = z.object({ folderId: z.string().uuid(), userId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid params' });

    const requestingUserId = request.user!.sub;
    const isOwner = await permissionService.isOwner(params.data.folderId, requestingUserId);
    if (!isOwner) return reply.code(404).send({ error: 'Not Found' });

    if (params.data.userId === requestingUserId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove your own permissions' });
    }

    await permissionService.revokeRole(params.data.folderId, params.data.userId);

    const { activityService } = await import('../services/activityService');
    await activityService.log(requestingUserId, 'role_revoked', 'folder', params.data.folderId, {
      targetUserId: params.data.userId,
    });

    return reply.code(204).send();
  });
}
