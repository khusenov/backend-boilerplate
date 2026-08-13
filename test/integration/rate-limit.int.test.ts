import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/presentation/http/app';
import { createLoggerOptions } from '@/infrastructure/logging/logger-options';
import { env } from '@/config/env';
import { RATE_LIMIT_KEY_NAMESPACE } from '@/presentation/http/security';

const AUTH_LIMIT = env.RATE_LIMIT_AUTH_MAX;
const badCredentials = { email: 'nobody@finflow.dev', password: 'wrong-password' };

async function startRateLimitedApp(): Promise<FastifyInstance> {
  const app = await buildApp({
    loggerOptions: createLoggerOptions('silent'),
    disableRequestLogging: true,
    rateLimit: true,
  });
  await app.ready();
  return app;
}

describe('distributed rate limiting', () => {
  describe('enforcement backed by redis', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await startRateLimitedApp();
      const redis = app.diContainer.cradle.rateLimitRedis;
      if (redis.status !== 'ready') {
        await new Promise<void>((resolve) => {
          redis.once('ready', () => resolve());
        });
      }
      await redis.flushdb();
    });

    afterAll(async () => {
      await app.close();
    });

    it('trips the auth bucket at the limit and stores the counter in redis', async () => {
      let last = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: badCredentials,
      });
      const statuses = [last.statusCode];
      for (let attempt = 1; attempt <= AUTH_LIMIT; attempt += 1) {
        last = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: badCredentials });
        statuses.push(last.statusCode);
      }

      expect(last.statusCode).toBe(429);
      expect(last.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(statuses.slice(0, AUTH_LIMIT).every((status) => status !== 429)).toBe(true);

      const keys = await app.diContainer.cradle.rateLimitRedis.keys(`${RATE_LIMIT_KEY_NAMESPACE}*`);
      expect(keys.length).toBeGreaterThan(0);
    });

    it('trips the forgot-password bucket at the limit, independently of the login bucket', async () => {
      const payload = { email: 'nobody@finflow.dev' };
      let last = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload });
      const statuses = [last.statusCode];
      for (let attempt = 1; attempt <= AUTH_LIMIT; attempt += 1) {
        last = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload });
        statuses.push(last.statusCode);
      }

      expect(last.statusCode).toBe(429);
      expect(last.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(statuses.slice(0, AUTH_LIMIT).every((status) => status !== 429)).toBe(true);
    });

    it('trips the reset-password bucket at the limit, independently of the other auth buckets', async () => {
      const payload = { token: 'irrelevant-token', newPassword: 'irrelevant-password' };
      let last = await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload });
      const statuses = [last.statusCode];
      for (let attempt = 1; attempt <= AUTH_LIMIT; attempt += 1) {
        last = await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload });
        statuses.push(last.statusCode);
      }

      expect(last.statusCode).toBe(429);
      expect(last.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(statuses.slice(0, AUTH_LIMIT).every((status) => status !== 429)).toBe(true);
    });
  });

  describe('fail-open when redis is unreachable', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await startRateLimitedApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('serves requests instead of failing closed', async () => {
      app.diContainer.cradle.rateLimitRedis.disconnect();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: badCredentials,
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
