import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/middleware';
import { searchService } from '../services/searchService';

const searchSchema = z.object({ q: z.string().min(1).max(200) });

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/search?q=term — search files by name
  app.get('/api/search', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = searchSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: 'Query parameter "q" is required' });
    }
    const userId = request.user!.sub;
    const results = await searchService.searchFiles(parsed.data.q, userId);
    return reply.send(results);
  });
}
