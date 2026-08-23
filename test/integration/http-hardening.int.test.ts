import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '@/config/env';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { SILENT_LOG_LEVEL } from './support/log-level';
import { buildApp } from '@/presentation/http/app';

const FORGED_CLIENT_ADDRESS = '198.51.100.1';
const REAL_PEER_ADDRESS = '203.0.113.9';

describe('http hardening (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      container: createAppContainer(createBaseLogger(SILENT_LOG_LEVEL)),
      disableRequestLogging: true,
      rateLimit: false,
    });
    app.get('/client-address', (request) => ({ address: request.ip }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('applies the configured transport limits to the real server', () => {
    expect(app.server.requestTimeout).toBe(env.REQUEST_TIMEOUT_MS);
    expect(app.initialConfig.routerOptions?.maxParamLength).toBe(env.MAX_PARAM_LENGTH);
  });

  it('resolves the client address through the configured proxy hop count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/client-address',
      headers: { 'x-forwarded-for': `${FORGED_CLIENT_ADDRESS}, ${REAL_PEER_ADDRESS}` },
    });

    expect(response.json<{ address: string }>().address).toBe(REAL_PEER_ADDRESS);
  });
});
