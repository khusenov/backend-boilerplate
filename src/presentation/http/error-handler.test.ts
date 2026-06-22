import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './error-handler';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors';

function buildTestApp(): FastifyInstance {
  const app = fastify({ logger: false });
  registerErrorHandler(app);

  app.get('/throw/validation', () => {
    throw new ValidationError('bad input', { code: 'BAD_FIELD' });
  });
  app.get('/throw/not-found', () => {
    throw new NotFoundError('resource gone');
  });
  app.get('/throw/conflict', () => {
    throw new ConflictError('already exists');
  });
  app.get('/throw/unauthorized', () => {
    throw new UnauthorizedError('token missing');
  });
  app.get('/throw/forbidden', () => {
    throw new ForbiddenError('access denied');
  });
  app.get('/throw/internal', () => {
    throw new InternalError('boom');
  });
  app.get('/throw/fastify-validation', () => {
    throw Object.assign(new Error('schema mismatch'), { validation: [{ message: 'bad' }] });
  });
  app.get('/throw/client-4xx', () => {
    throw Object.assign(new Error('gone'), { statusCode: 410, code: 'GONE' });
  });
  app.get('/throw/client-4xx-no-code', () => {
    throw Object.assign(new Error('bad request'), { statusCode: 400 });
  });
  app.get('/throw/unhandled', () => {
    throw new Error('kaboom');
  });

  return app;
}

describe('registerErrorHandler', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('AppError mapping', () => {
    it('maps ValidationError to 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/validation' });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('BAD_FIELD');
      expect(body.error.message).toBe('bad input');
    });

    it('maps NotFoundError to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/not-found' });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    });

    it('maps ConflictError to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/conflict' });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    });

    it('maps UnauthorizedError to 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/unauthorized' });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    });

    it('maps ForbiddenError to 403', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/forbidden' });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });

    it('maps InternalError to 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/internal' });
      expect(res.statusCode).toBe(500);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INTERNAL');
    });

    it('includes requestId in the response body', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/validation' });
      const body = res.json<{ error: { requestId: unknown } }>();
      expect(body.error.requestId).toBeDefined();
    });
  });

  describe('Fastify schema validation error (error.validation)', () => {
    it('returns 400 with code VALIDATION', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/fastify-validation' });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toBe('schema mismatch');
    });
  });

  describe('4xx client error (non-AppError)', () => {
    it('uses the error statusCode and code', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/client-4xx' });
      expect(res.statusCode).toBe(410);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('GONE');
    });

    it('falls back to BAD_REQUEST code when error has no code', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/client-4xx-no-code' });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('unhandled error', () => {
    it('returns 500 with generic message', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/unhandled' });
      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toBe('Internal Server Error');
    });
  });

  describe('not-found handler', () => {
    it('returns 404 with ROUTE_NOT_FOUND for unknown routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
      expect(body.error.message).toContain('GET');
      expect(body.error.message).toContain('/does-not-exist');
    });

    it('includes requestId in the not-found response', async () => {
      const res = await app.inject({ method: 'GET', url: '/missing' });
      const body = res.json<{ error: { requestId: unknown } }>();
      expect(body.error.requestId).toBeDefined();
    });
  });
});
