import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/presentation/http/app';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { SILENT_LOG_LEVEL } from './support/log-level';

describe('metrics endpoint (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      container: createAppContainer(createBaseLogger(SILENT_LOG_LEVEL)),
      disableRequestLogging: true,
      rateLimit: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes Prometheus metrics reflecting prior traffic', async () => {
    await app.inject({ method: 'GET', url: '/health/live' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toContain('route="/health/live"');
  });
});
