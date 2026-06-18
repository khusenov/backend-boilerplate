import { type ErrorKindType, ErrorKind, AppError } from '@/shared/errors';
import type { FastifyError, FastifyInstance } from 'fastify';

const KIND_TO_STATUS: Record<ErrorKindType, number> = {
  [ErrorKind.Validation]: 400,
  [ErrorKind.Unauthorized]: 401,
  [ErrorKind.Forbidden]: 403,
  [ErrorKind.NotFound]: 404,
  [ErrorKind.Conflict]: 409,
  [ErrorKind.Internal]: 500,
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      const status = KIND_TO_STATUS[error.kind];

      if (error.isOperational) request.log.info({ code: error.code }, error.message);
      else request.log.error({ err: error }, error.message);

      return reply.status(status).send({
        error: { ...error.toJSON(), requestId: request.id },
      });
    }

    if (error.validation) {
      request.log.info({ err: error }, 'request validation failed');
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: error.message, requestId: request.id },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal Server Error', requestId: request.id },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    });
  });
}
