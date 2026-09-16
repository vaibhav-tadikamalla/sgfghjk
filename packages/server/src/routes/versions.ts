/**
 * routes/versions.ts
 *
 * REST API endpoints for Document Version History.
 *
 *   GET    /api/files/:fileId/versions              — list versions
 *   GET    /api/files/:fileId/versions/:versionId   — get version details
 *   POST   /api/files/:fileId/versions              — create named checkpoint
 *   GET    /api/files/:fileId/versions/:versionId/diff   — compute diff
 *   POST   /api/files/:fileId/versions/:versionId/restore — restore version
 *
 * All endpoints require JWT authentication and file-level read/write
 * permission (via the workspace permission service).
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { permissionService } from '../services/workspacePermissionService';
import { getCollaborationServerInstance } from '../websocket';
import {
  listVersions,
  createCheckpoint,
  diffVersions,
  restoreVersion,
} from '../services/versionService';

const fileParams = z.object({ fileId: z.string().uuid() });
const versionParams = z.object({
  fileId: z.string().uuid(),
  versionId: z.string().uuid(),
});
const createBody = z.object({
  label: z.string().min(1).max(255),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const diffQuery = z.object({
  toVersionId: z.string().uuid().optional(),
});

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/files/:fileId/versions — list versions ───────────────────────

  app.get(
    '/api/files/:fileId/versions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = fileParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });

      const userId = request.user!.sub;
      const canRead = await permissionService.canReadFile(params.data.fileId, userId);
      if (!canRead) return reply.code(404).send({ error: 'Not Found' });

      const query = listQuery.safeParse(request.query);
      const { limit, offset } = query.success ? query.data : { limit: 50, offset: 0 };

      const result = await listVersions(params.data.fileId, limit, offset);
      return reply.send(result);
    },
  );

  // ── GET /api/files/:fileId/versions/:versionId — get version details ──────

  app.get(
    '/api/files/:fileId/versions/:versionId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = versionParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid parameters' });

      const userId = request.user!.sub;
      const canRead = await permissionService.canReadFile(params.data.fileId, userId);
      if (!canRead) return reply.code(404).send({ error: 'Not Found' });

      // Import loadVersion directly for full snapshot retrieval
      const { loadVersion } = await import('../persistence/versionStore');
      const version = await loadVersion(params.data.fileId, params.data.versionId);
      if (!version) return reply.code(404).send({ error: 'Version not found' });

      // Return metadata + base64-encoded snapshot for client processing
      return reply.send({
        id: version.id,
        fileId: version.fileId,
        versionNum: version.versionNum,
        label: version.label,
        source: version.source,
        snapshotHash: version.snapshotHash,
        byteSize: version.byteSize,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
        snapshotBase64: version.snapshot.toString('base64'),
      });
    },
  );

  // ── POST /api/files/:fileId/versions — create named checkpoint ────────────

  app.post(
    '/api/files/:fileId/versions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = fileParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid file ID' });

      const body = createBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'Validation Error', details: body.error.errors });
      }

      const userId = request.user!.sub;
      const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
      if (!canWrite) return reply.code(404).send({ error: 'Not Found' });

      const version = await createCheckpoint(params.data.fileId, body.data.label, userId);
      if (!version) {
        return reply.code(500).send({ error: 'Failed to create version checkpoint' });
      }

      return reply.code(201).send(version);
    },
  );

  // ── GET /api/files/:fileId/versions/:versionId/diff — compute diff ────────

  app.get(
    '/api/files/:fileId/versions/:versionId/diff',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = versionParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid parameters' });

      const userId = request.user!.sub;
      const canRead = await permissionService.canReadFile(params.data.fileId, userId);
      if (!canRead) return reply.code(404).send({ error: 'Not Found' });

      const query = diffQuery.safeParse(request.query);
      const toVersionId = query.success ? query.data.toVersionId ?? null : null;

      const diff = await diffVersions(params.data.fileId, params.data.versionId, toVersionId);
      if (!diff) {
        return reply.code(404).send({ error: 'Could not compute diff — version(s) not found' });
      }

      return reply.send({
        fromVersionId: diff.fromVersionId,
        toVersionId: diff.toVersionId,
        diffBytes: diff.diffBytes,
        diffBase64: diff.diff.toString('base64'),
      });
    },
  );

  // ── POST /api/files/:fileId/versions/:versionId/restore — restore ─────────

  app.post(
    '/api/files/:fileId/versions/:versionId/restore',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = versionParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid parameters' });

      const userId = request.user!.sub;
      const canWrite = await permissionService.canWriteFile(params.data.fileId, userId);
      if (!canWrite) return reply.code(404).send({ error: 'Not Found' });

      const collab = getCollaborationServerInstance();
      const result = await restoreVersion(
        params.data.fileId,
        params.data.versionId,
        userId,
        collab
          ? (update) => {
              collab.applySystemUpdateToRoom(params.data.fileId, update);
            }
          : undefined,
      );

      if (!result.success) {
        return reply.code(result.error === 'Version not found' ? 404 : 500).send({
          error: result.error ?? 'Restore failed',
        });
      }

      return reply.send({
        status: 'ok',
        restoredVersionId: params.data.versionId,
        newVersionId: result.versionId,
        walSeq: result.walSeq ? String(result.walSeq) : null,
        bytesApplied: result.bytesApplied,
      });
    },
  );
}
