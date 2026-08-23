import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/presentation/http/app';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { SILENT_LOG_LEVEL } from './support/log-level';

describe('app bootstrap (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      container: createAppContainer(createBaseLogger(SILENT_LOG_LEVEL)),
      disableRequestLogging: true,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /health/live', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('serves GET /health/ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});
