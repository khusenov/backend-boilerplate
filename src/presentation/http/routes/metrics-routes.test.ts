import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import { metricsRoutes } from './metrics-routes';
import type { MetricsExposition } from '@/application/shared/ports/metrics';

function makeMetricsExposition(): MetricsExposition {
  return {
    render: () => Promise.resolve('# HELP http_request_duration_seconds Duration.\n'),
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  };
}

async function buildApp(metricsExposition: MetricsExposition): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });

  diContainer.register({ metricsExposition: asValue(metricsExposition) });

  await app.register(metricsRoutes, { prefix: '/metrics' });

  return app;
}

describe('metricsRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(makeMetricsExposition());
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with the Prometheus exposition content type and body', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('http_request_duration_seconds');
  });
});
