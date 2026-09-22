import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { mock } from 'vitest-mock-extended';
import { registerErrorHandler } from './error-handler';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors';
import type { Logger } from '@/application/shared/ports/logger';
import { IcuTranslator } from '@/infrastructure/i18n/icu-translator';
import { messageCatalogue } from '@/infrastructure/i18n/messages/catalogue';
import { localePlugin } from '@/presentation/http/plugins/locale';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: unknown;
  };
}

const VALIDATION_ISSUE = {
  instancePath: '/email',
  keyword: 'invalid_format',
  schemaPath: '#/email/invalid_format',
  params: { origin: 'string', format: 'email' },
  message: 'Invalid email address',
};

function buildTranslator(): IcuTranslator {
  return new IcuTranslator({ messageCatalogue, logger: mock<Logger>() });
}

function registerRoutes(app: FastifyInstance): void {
  app.get('/throw/validation', () => {
    throw new ValidationError('bad input', { code: 'USER_NAME_INVALID' });
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
    throw new ForbiddenError('access denied', {
      code: 'FORBIDDEN',
      details: { required: ['roles:write'] },
    });
  });
  app.get('/throw/internal', () => {
    throw new InternalError('boom', { details: { eventName: 'user.created' } });
  });
  app.get('/throw/internal-untranslatable', () => {
    throw new InternalError('leaky internals', { code: 'USER_NOT_FOUND' });
  });
  app.get('/throw/interpolated', () => {
    throw new NotFoundError('User with id u-1 not found', {
      code: 'USER_NOT_FOUND',
      details: { id: 'u-1' },
    });
  });
  app.get('/throw/missing-icu-params', () => {
    throw new NotFoundError('User with id u-1 not found', { code: 'USER_NOT_FOUND' });
  });
  app.get('/throw/fastify-validation', () => {
    throw Object.assign(new Error('schema mismatch'), { validation: [VALIDATION_ISSUE] });
  });
  app.get('/throw/client-4xx', () => {
    throw Object.assign(new Error('gone'), { statusCode: 410, code: 'GONE' });
  });
  app.get('/throw/client-4xx-catalogued', () => {
    throw Object.assign(new Error('slow down'), { statusCode: 429, code: 'RATE_LIMITED' });
  });
  app.get('/throw/client-4xx-no-code', () => {
    throw Object.assign(new Error('bad request'), { statusCode: 400 });
  });
  app.get('/throw/unhandled', () => {
    throw new Error('kaboom');
  });
}

function buildTestApp(): FastifyInstance {
  const app = fastify({ logger: false });
  registerErrorHandler(app, { translator: buildTranslator() });
  registerRoutes(app);

  return app;
}

async function buildRussianApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(localePlugin, { defaultLocale: 'ru' });
  registerErrorHandler(app, { translator: buildTranslator() });
  registerRoutes(app);
  await app.ready();

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
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('USER_NAME_INVALID');
      expect(body.error.message).toBe('The name provided is not valid.');
    });

    it('maps NotFoundError to 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/not-found' });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    });

    it('maps ConflictError to 409', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/conflict' });
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe('CONFLICT');
    });

    it('maps UnauthorizedError to 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/unauthorized' });
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    });

    it('maps ForbiddenError to 403', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/forbidden' });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    });

    it('maps InternalError to 500', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/internal' });
      expect(res.statusCode).toBe(500);
      expect(res.json<ErrorBody>().error.code).toBe('INTERNAL');
    });

    it('includes requestId in the response body', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/validation' });
      expect(res.json<ErrorBody>().error.requestId).toBeDefined();
    });

    it('interpolates the error details into the catalogued message', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/interpolated' });
      expect(res.json<ErrorBody>().error.message).toBe('No user was found for the identifier u-1.');
    });

    it('falls back to the developer message when the template needs absent params', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/missing-icu-params' });
      expect(res.json<ErrorBody>().error.message).toBe('User with id u-1 not found');
    });
  });

  describe('redaction', () => {
    it('keeps details on an operational error', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/forbidden' });
      expect(res.json<ErrorBody>().error.details).toEqual({ required: ['roles:write'] });
    });

    it('drops details and the developer message on a non-operational error', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/internal' });
      const body = res.json<ErrorBody>();
      expect(body.error.details).toBeUndefined();
      expect(body.error.message).toBe('Something went wrong. Please try again later.');
    });

    it('sends the redacted fallback when a non-operational code cannot be formatted', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/internal-untranslatable' });
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('USER_NOT_FOUND');
      expect(body.error.message).toBe('Internal Server Error');
    });
  });

  describe('Fastify schema validation error (error.validation)', () => {
    it('returns 400 with code VALIDATION and localized field errors', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/fastify-validation' });
      expect(res.statusCode).toBe(400);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.message).toBe('The request contains invalid data.');
      expect(body.error.details).toEqual({
        fields: [
          {
            field: 'email',
            rule: 'invalid_format',
            message: 'This value is not in the expected format.',
          },
        ],
      });
    });
  });

  describe('4xx client error (non-AppError)', () => {
    it('uses the error statusCode and code', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/client-4xx' });
      expect(res.statusCode).toBe(410);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('GONE');
      expect(body.error.message).toBe('gone');
    });

    it('localizes a transport code that is in the registry', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/client-4xx-catalogued' });
      expect(res.statusCode).toBe(429);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toBe('Too many requests. Please slow down and try again shortly.');
    });

    it('falls back to BAD_REQUEST code when error has no code', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/client-4xx-no-code' });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('unhandled error', () => {
    it('returns 500 with the catalogued generic message', async () => {
      const res = await app.inject({ method: 'GET', url: '/throw/unhandled' });
      expect(res.statusCode).toBe(500);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('INTERNAL');
      expect(body.error.message).toBe('Something went wrong. Please try again later.');
    });
  });

  describe('not-found handler', () => {
    it('returns 404 with ROUTE_NOT_FOUND for unknown routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
      expect(res.statusCode).toBe(404);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('ROUTE_NOT_FOUND');
      expect(body.error.message).toBe('The requested route was not found.');
    });

    it('includes requestId in the not-found response', async () => {
      const res = await app.inject({ method: 'GET', url: '/missing' });
      expect(res.json<ErrorBody>().error.requestId).toBeDefined();
    });
  });
});

describe('registerErrorHandler with a negotiated locale', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRussianApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('localizes an AppError message', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw/validation' });
    expect(res.json<ErrorBody>().error.message).toBe('Указано некорректное имя.');
  });

  it('localizes the validation envelope and its field errors', async () => {
    const res = await app.inject({ method: 'GET', url: '/throw/fastify-validation' });
    const body = res.json<ErrorBody>();
    expect(body.error.message).toBe('Запрос содержит некорректные данные.');
    expect(body.error.details).toEqual({
      fields: [
        {
          field: 'email',
          rule: 'invalid_format',
          message: 'Значение не соответствует ожидаемому формату.',
        },
      ],
    });
  });

  it('localizes the not-found envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.json<ErrorBody>().error.message).toBe('Запрашиваемый маршрут не найден.');
  });

  it('honours an Accept-Language header that outranks the default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/throw/validation',
      headers: { 'accept-language': 'en-GB,en;q=0.9' },
    });
    expect(res.json<ErrorBody>().error.message).toBe('The name provided is not valid.');
  });
});
