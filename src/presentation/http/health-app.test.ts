import { describe, expect, it, vi } from 'vitest';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { buildHealthApp } from './health-app';

const logger = createBaseLogger('silent');

describe('buildHealthApp', () => {
  it('serves liveness for the worker process', async () => {
    const healthCheck = { check: vi.fn<HealthCheck['check']>() } satisfies HealthCheck;
    const app = await buildHealthApp({ healthCheck, logger });
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
    const app = await buildHealthApp({ healthCheck, logger });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});
