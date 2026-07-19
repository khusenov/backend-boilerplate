import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { fastifyHelmet } from '@fastify/helmet';
import { fastifyRateLimit } from '@fastify/rate-limit';
import { registerErrorHandler } from '@/presentation/http/error-handler';
import {
  helmetOptions,
  RATE_LIMIT_KEY_NAMESPACE,
  rateLimitOptions,
} from '@/presentation/http/security';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(fastifyHelmet, helmetOptions(false));
  await app.register(fastifyRateLimit, rateLimitOptions(2, '1 minute'));
  registerErrorHandler(app);

  app.get('/ping', () => ({ ok: true }));
  app.post('/auth/login', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, () => ({
    ok: true,
  }));

  await app.ready();
  return app;
}

describe('security middleware', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('helmet', () => {
    it('sets hardening headers on responses', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('global rate limit', () => {
    it('exposes rate-limit headers', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' });
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
    });

    it('returns 429 in the app error envelope once the limit is exceeded', async () => {
      await app.inject({ method: 'GET', url: '/ping' });
      await app.inject({ method: 'GET', url: '/ping' });
      const res = await app.inject({ method: 'GET', url: '/ping' }); // 3rd > max(2)
      expect(res.statusCode).toBe(429);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    });
  });

  describe('strict auth limit', () => {
    it('trips on the 2nd auth request via its own per-route bucket', async () => {
      const first = await app.inject({ method: 'POST', url: '/auth/login' });
      const second = await app.inject({ method: 'POST', url: '/auth/login' }); // 2nd > max(1)
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(429);
    });
  });

  describe('rate-limit policy', () => {
    it('enables fail-open and a namespaced store', () => {
      const options = rateLimitOptions(2, '1 minute');
      expect(options.skipOnError).toBe(true);
      expect(options.nameSpace).toBe(RATE_LIMIT_KEY_NAMESPACE);
    });
  });
});
