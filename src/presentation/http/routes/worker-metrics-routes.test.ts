import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsExposition } from '@/application/shared/ports/metrics';
import { workerMetricsRoutes } from './worker-metrics-routes';

describe('workerMetricsRoutes', () => {
  it('renders the metrics exposition body with its content type', async () => {
    const metricsExposition = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      render: vi
        .fn<MetricsExposition['render']>()
        .mockResolvedValue('# HELP test_metric\ntest_metric 1\n'),
    } satisfies MetricsExposition;

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(workerMetricsRoutes, { metricsExposition });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toBe('# HELP test_metric\ntest_metric 1\n');
    await app.close();
  });
});
