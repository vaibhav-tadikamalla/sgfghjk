import { FastifyRequest, FastifyReply } from 'fastify';
import { getLogger } from '../utils/logger';

export async function errorHandler(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const logger = getLogger();

  // Validation error from Zod or Fastify schema
  if ('statusCode' in error && (error as any).statusCode === 400) {
    reply.code(400).send({
      error: 'Bad Request',
      message: error.message,
    });
    return;
  }

  // Database errors
  if ('code' in error) {
    const pgError = error as any;
    if (pgError.code === '23505') {
      // Unique constraint violation
      reply.code(409).send({
        error: 'Conflict',
        message: 'Resource already exists',
      });
      return;
    }
    if (pgError.code === '23503') {
      // Foreign key violation
      reply.code(404).send({
        error: 'Not Found',
        message: 'Related resource not found',
      });
      return;
    }
  }

  // Generic server error
  logger.error({ err: error, url: request.url, method: request.method }, 'Unhandled server error');

  reply.code(500).send({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
}
