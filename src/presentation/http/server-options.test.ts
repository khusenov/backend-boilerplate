import { describe, expect, it } from 'vitest';
import { fastify, type FastifyInstance } from 'fastify';
import type { TrustProxySetting } from '@/config/trust-proxy';
import { httpHardeningOptions, type HttpHardeningInput } from './server-options';

const SOCKET_ADDRESS = '127.0.0.1';
const FORGED_CLIENT_ADDRESS = '198.51.100.1';
const REAL_PEER_ADDRESS = '203.0.113.9';
const FORGED_FORWARDED_FOR = `${FORGED_CLIENT_ADDRESS}, ${REAL_PEER_ADDRESS}`;

const baseInput: HttpHardeningInput = {
  trustProxy: false,
  bodyLimitBytes: 4096,
  requestTimeoutMs: 1000,
  keepAliveTimeoutMs: 2000,
  maxParamLength: 32,
};

async function withProbeApp<T>(
  input: HttpHardeningInput,
  run: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const app = fastify({ logger: false, ...httpHardeningOptions(input) });
  app.get('/client-address', (request) => ({ address: request.ip }));
  app.get('/echo/:value', (request) => request.params);
  app.post('/echo', (request) => request.body);
  await app.ready();
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

function readClientAddress(trustProxy: TrustProxySetting): Promise<string> {
  return withProbeApp({ ...baseInput, trustProxy }, async (app) => {
    const response = await app.inject({
      method: 'GET',
      url: '/client-address',
      headers: { 'x-forwarded-for': FORGED_FORWARDED_FOR },
    });
    return response.json<{ address: string }>().address;
  });
}

describe('httpHardeningOptions', () => {
  it('maps every configured limit onto its Fastify option', () => {
    const options = httpHardeningOptions({
      trustProxy: 1,
      bodyLimitBytes: 2048,
      requestTimeoutMs: 5000,
      keepAliveTimeoutMs: 6000,
      maxParamLength: 64,
    });

    expect(options).toEqual({
      trustProxy: 1,
      bodyLimit: 2048,
      requestTimeout: 5000,
      keepAliveTimeout: 6000,
      routerOptions: { maxParamLength: 64 },
    });
  });
});

describe('client address resolution', () => {
  it('uses the socket address when no proxy is trusted', async () => {
    await expect(readClientAddress(false)).resolves.toBe(SOCKET_ADDRESS);
  });

  it('discards a client-forged entry when the hop count matches the chain', async () => {
    await expect(readClientAddress(1)).resolves.toBe(REAL_PEER_ADDRESS);
  });

  it('accepts a client-forged entry when every hop is trusted', async () => {
    await expect(readClientAddress(true)).resolves.toBe(FORGED_CLIENT_ADDRESS);
  });

  it('accepts a client-forged entry when the hop count exceeds the chain', async () => {
    await expect(readClientAddress(2)).resolves.toBe(FORGED_CLIENT_ADDRESS);
  });
});

describe('request limits', () => {
  it('rejects a body larger than the configured limit', async () => {
    const status = await withProbeApp({ ...baseInput, bodyLimitBytes: 128 }, async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/echo',
        payload: { value: 'a'.repeat(256) },
      });
      return response.statusCode;
    });
    expect(status).toBe(413);
  });

  it('accepts a body within the configured limit', async () => {
    const status = await withProbeApp({ ...baseInput, bodyLimitBytes: 1024 }, async (app) => {
      const response = await app.inject({ method: 'POST', url: '/echo', payload: { value: 'ok' } });
      return response.statusCode;
    });
    expect(status).toBe(200);
  });

  it('answers 414 for a path parameter longer than the configured maximum', async () => {
    const status = await withProbeApp({ ...baseInput, maxParamLength: 10 }, async (app) => {
      const response = await app.inject({ method: 'GET', url: `/echo/${'a'.repeat(64)}` });
      return response.statusCode;
    });
    expect(status).toBe(414);
  });

  it('routes a path parameter within the configured maximum', async () => {
    const status = await withProbeApp({ ...baseInput, maxParamLength: 10 }, async (app) => {
      const response = await app.inject({ method: 'GET', url: '/echo/short' });
      return response.statusCode;
    });
    expect(status).toBe(200);
  });
});
