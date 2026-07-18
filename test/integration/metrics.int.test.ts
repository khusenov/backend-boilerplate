import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/presentation/http/app';

describe('metrics endpoint (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logLevel: 'silent', disableRequestLogging: true, rateLimit: false });
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
