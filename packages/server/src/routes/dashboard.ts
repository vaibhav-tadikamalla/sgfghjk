import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { permissionService } from '../services/workspacePermissionService';
import { sessionTracker } from '../ws/SessionTrackingService';
import { WorkspaceDashboardService } from '../services/workspaceDashboardService';

const paramsSchema = z.object({ workspaceId: z.string().uuid() });

// One dashboard service instance per process (shares the singleton tracker)
const dashboardService = new WorkspaceDashboardService(sessionTracker);

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/workspaces/:workspaceId/dashboard
   *
   * Returns a real-time snapshot of active users and active files in a
   * workspace.  The caller must hold at least viewer-level access.
   *
   * Response shape:
   * {
   *   workspaceId: string
   *   activeUsers: Array<{
   *     userId: string
   *     currentFileId: string
   *     sessionDuration: number   // ms
   *     lastActivityAt: number    // unix ms
   *     totalEdits: number
   *   }>
   *   activeFiles: Array<{
   *     fileId: string
   *     activeUsersCount: number
   *   }>
   * }
   */
  app.get(
    '/api/workspaces/:workspaceId/dashboard',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'workspaceId must be a valid UUID',
        });
      }

      const { workspaceId } = params.data;
      const userId = request.user!.sub;

      // Permission check — any role (viewer, editor, owner) may read the dashboard
      const canRead = await permissionService.canRead(workspaceId, userId);
      if (!canRead) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Workspace not found',
        });
      }

      const dashboard = dashboardService.getDashboard(workspaceId);
      return reply.send(dashboard);
    },
  );
}
