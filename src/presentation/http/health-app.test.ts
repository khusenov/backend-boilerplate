import { describe, expect, it, vi } from 'vitest';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import type { MetricsExposition } from '@/application/shared/ports/metrics';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { buildHealthApp } from './health-app';

const logger = createBaseLogger('silent');

const metricsExposition = {
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
  render: vi
    .fn<MetricsExposition['render']>()
    .mockResolvedValue('# HELP test_metric\ntest_metric 1\n'),
} satisfies MetricsExposition;

describe('buildHealthApp', () => {
  it('serves liveness for the worker process', async () => {
    const healthCheck = { check: vi.fn<HealthCheck['check']>() } satisfies HealthCheck;
    const app = await buildHealthApp({
      healthCheck,
      metricsExposition,
      metricsEnabled: true,
      logger,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('maps a failing dependency to 503 on readiness', async () => {
    const healthCheck = {
      check: vi.fn<HealthCheck['check']>().mockRejectedValue(new Error('db down')),
    } satisfies HealthCheck;
    const app = await buildHealthApp({
      healthCheck,
      metricsExposition,
      metricsEnabled: true,
      logger,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });

  it('mounts /metrics when metrics are enabled', async () => {
    const healthCheck = { check: vi.fn<HealthCheck['check']>() } satisfies HealthCheck;
    const app = await buildHealthApp({
      healthCheck,
      metricsExposition,
      metricsEnabled: true,
      logger,
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toBe('# HELP test_metric\ntest_metric 1\n');
    await app.close();
  });

  it('omits /metrics when metrics are disabled', async () => {
    const healthCheck = { check: vi.fn<HealthCheck['check']>() } satisfies HealthCheck;
    const app = await buildHealthApp({
      healthCheck,
      metricsExposition,
      metricsEnabled: false,
      logger,
    });
    await app.ready();
    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(404);
    const healthRes = await app.inject({ method: 'GET', url: '/health/live' });
    expect(healthRes.statusCode).toBe(200);
    await app.close();
  });
});
