import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import { healthRoutes } from './health-routes';
import type { HealthCheck } from '@/application/shared/ports/health-check';

function makeHealthCheck() {
  return {
    check: vi.fn<HealthCheck['check']>().mockResolvedValue(undefined),
  } satisfies HealthCheck;
}

type HealthCheckMock = ReturnType<typeof makeHealthCheck>;

async function buildApp(healthCheck: HealthCheck): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });

  diContainer.register({ healthCheck: asValue(healthCheck) });

  await app.register(healthRoutes, { prefix: '/health' });

  return app;
}

describe('healthRoutes', () => {
  let app: FastifyInstance;
  let healthCheck: HealthCheckMock;

  beforeEach(async () => {
    healthCheck = makeHealthCheck();
    app = await buildApp(healthCheck);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health/live', () => {
    it('returns 200 and { status: "ok" } without running the readiness check', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(healthCheck.check).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 and { status: "ready" } when the dependency is healthy', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ready' });
      expect(healthCheck.check).toHaveBeenCalledOnce();
    });

    it('returns 503 and { status: "unavailable" } when the dependency is down', async () => {
      vi.mocked(healthCheck.check).mockRejectedValue(new Error('db unreachable'));
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable' });
    });
  });
});
