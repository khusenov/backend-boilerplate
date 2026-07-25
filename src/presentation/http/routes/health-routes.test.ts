import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import { healthRoutes } from './health-routes';

async function buildTestApp(healthCheck: HealthCheck): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRoutes, { prefix: '/health', healthCheck });
  await app.ready();
  return app;
}

describe('healthRoutes', () => {
  it('serves liveness without touching dependencies', async () => {
    const healthCheck = { check: vi.fn<HealthCheck['check']>() } satisfies HealthCheck;
    const app = await buildTestApp(healthCheck);
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(healthCheck.check).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports readiness when every dependency is healthy', async () => {
    const healthCheck = {
      check: vi.fn<HealthCheck['check']>().mockResolvedValue(undefined),
    } satisfies HealthCheck;
    const app = await buildTestApp(healthCheck);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('returns 503 when a dependency is unavailable', async () => {
    const healthCheck = {
      check: vi.fn<HealthCheck['check']>().mockRejectedValue(new Error('redis down')),
    } satisfies HealthCheck;
    const app = await buildTestApp(healthCheck);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});
