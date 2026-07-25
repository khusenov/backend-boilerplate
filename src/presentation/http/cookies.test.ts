import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { fastifyCookie } from '@fastify/cookie';
import { clearRefreshCookie, REFRESH_COOKIE, readRefreshCookie, setRefreshCookie } from './cookies';
import type { Env } from '@/config/env';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REFRESH_TOKEN_TTL: 86400,
    COOKIE_SECRET: '',
    COOKIE_SECURE: false,
    ...overrides,
  } as Env;
}

async function buildCookieApp(env: Env): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(fastifyCookie, env.COOKIE_SECRET ? { secret: env.COOKIE_SECRET } : {});

  app.get('/set', (_req, reply) => {
    setRefreshCookie(reply, 'mytoken', env);
    return reply.code(200).send({});
  });

  app.get('/clear', (_req, reply) => {
    clearRefreshCookie(reply, env);
    return reply.code(200).send({});
  });

  app.get('/read', (req, reply) => {
    const value = readRefreshCookie(req, env);
    return reply.code(200).send({ value: value ?? null });
  });

  return app;
}

describe('REFRESH_COOKIE', () => {
  it('equals "refreshToken"', () => {
    expect(REFRESH_COOKIE).toBe('refreshToken');
  });
});

describe('setRefreshCookie', () => {
  describe('without cookie secret (unsigned)', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildCookieApp(makeEnv());
    });

    afterEach(async () => {
      await app.close();
    });

    it('sets the refreshToken cookie with the raw token value', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.value).toBe('mytoken');
    });

    it('sets HttpOnly', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.httpOnly).toBe(true);
    });

    it('sets SameSite=Strict', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.sameSite).toBe('Strict');
    });

    it('sets Path=/v1/auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.path).toBe('/v1/auth');
    });

    it('sets Max-Age to REFRESH_TOKEN_TTL', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.maxAge).toBe(86400);
    });

    it('omits the Secure flag when COOKIE_SECURE is false', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.secure).toBeUndefined();
    });
  });

  describe('with COOKIE_SECURE=true', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildCookieApp(makeEnv({ COOKIE_SECURE: true }));
    });

    afterEach(async () => {
      await app.close();
    });

    it('includes the Secure flag', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      expect(cookie?.secure).toBe(true);
    });
  });

  describe('with cookie secret (signed)', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildCookieApp(makeEnv({ COOKIE_SECRET: 'supersecret' }));
    });

    afterEach(async () => {
      await app.close();
    });

    it('stores a signed value (token + HMAC), not the bare token', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
      // signing appends a dot-separated HMAC: "value.hmac"
      expect(cookie?.value).not.toBe('mytoken');
      expect(cookie?.value).toMatch(/^mytoken\..+/);
    });

    it('still sets a refreshToken cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/set' });
      expect(res.cookies.find((c) => c.name === REFRESH_COOKIE)).toBeDefined();
    });
  });
});

describe('clearRefreshCookie', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildCookieApp(makeEnv());
  });

  afterEach(async () => {
    await app.close();
  });

  it('clears the refreshToken cookie (Max-Age=0)', async () => {
    const res = await app.inject({ method: 'GET', url: '/clear' });
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.maxAge).toBe(0);
  });

  it('retains HttpOnly when clearing', async () => {
    const res = await app.inject({ method: 'GET', url: '/clear' });
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
  });

  it('retains Path=/v1/auth when clearing', async () => {
    const res = await app.inject({ method: 'GET', url: '/clear' });
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie?.path).toBe('/v1/auth');
  });
});

describe('readRefreshCookie', () => {
  describe('without cookie secret', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildCookieApp(makeEnv());
    });

    afterEach(async () => {
      await app.close();
    });

    it('returns undefined when no cookie is present', async () => {
      const res = await app.inject({ method: 'GET', url: '/read' });
      expect(res.json<{ value: unknown }>().value).toBeNull();
    });

    it('returns the raw cookie value', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/read',
        cookies: { [REFRESH_COOKIE]: 'mytoken' },
      });
      expect(res.json<{ value: string }>().value).toBe('mytoken');
    });
  });

  describe('with cookie secret', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildCookieApp(makeEnv({ COOKIE_SECRET: 'supersecret' }));
    });

    afterEach(async () => {
      await app.close();
    });

    it('returns undefined when no cookie is present', async () => {
      const res = await app.inject({ method: 'GET', url: '/read' });
      expect(res.json<{ value: unknown }>().value).toBeNull();
    });

    it('unsigns and returns the original token for a valid signed cookie', async () => {
      const setRes = await app.inject({ method: 'GET', url: '/set' });
      const signedValue = setRes.cookies.find((c) => c.name === REFRESH_COOKIE)?.value ?? '';

      const readRes = await app.inject({
        method: 'GET',
        url: '/read',
        cookies: { [REFRESH_COOKIE]: signedValue },
      });
      expect(readRes.json<{ value: string }>().value).toBe('mytoken');
    });

    it('returns undefined for a tampered cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/read',
        cookies: { [REFRESH_COOKIE]: 'mytoken.invalidsignature' },
      });
      expect(res.json<{ value: unknown }>().value).toBeNull();
    });
  });
});
