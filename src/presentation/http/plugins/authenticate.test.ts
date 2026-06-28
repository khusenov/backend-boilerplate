import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import { authPlugin } from './authenticate';
import { registerErrorHandler } from '@/presentation/http/error-handler';
import type {
  AccessTokenPayload,
  AccessTokenService,
} from '@/application/shared/ports/access-token-service';
import { UnauthorizedError } from '@/shared/errors';

const VALID_PAYLOAD: AccessTokenPayload = {
  sub: 'user-1',
  email: 'user@example.com',
  systemRoleKeys: [],
  permissions: [],
};

function makeTokenService() {
  return {
    sign: vi.fn<AccessTokenService['sign']>(),
    verify: vi.fn<AccessTokenService['verify']>().mockResolvedValue(VALID_PAYLOAD),
  } satisfies AccessTokenService;
}

type TokenServiceMock = ReturnType<typeof makeTokenService>;

async function buildApp(service: AccessTokenService): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  registerErrorHandler(app);

  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });

  diContainer.register({ accessTokenService: asValue(service) });

  await app.register(authPlugin);

  app.get('/protected', { preHandler: [app.authenticate] }, (request, reply) => {
    return reply.send({ user: request.user });
  });

  return app;
}

describe('authPlugin', () => {
  let app: FastifyInstance;
  let service: TokenServiceMock;

  beforeEach(async () => {
    service = makeTokenService();
    app = await buildApp(service);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('missing or malformed Authorization header', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const res = await app.inject({ method: 'GET', url: '/protected' });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('MISSING_ACCESS_TOKEN');
    });

    it('returns 401 when scheme is not Bearer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('MISSING_ACCESS_TOKEN');
    });

    it('returns 401 when Bearer value is empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer ' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('MISSING_ACCESS_TOKEN');
    });

    it('returns 401 when Bearer value is whitespace-only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer   ' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('MISSING_ACCESS_TOKEN');
    });
  });

  describe('valid token', () => {
    it('returns 200 and sets request.user to the verified payload', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer some.jwt.token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user: VALID_PAYLOAD });
    });

    it('passes the extracted token to accessTokenService.verify', async () => {
      await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer my.token.here' },
      });
      expect(service.verify).toHaveBeenCalledOnce();
      expect(service.verify).toHaveBeenCalledWith('my.token.here');
    });
  });

  describe('accessTokenService.verify rejects', () => {
    it('propagates an UnauthorizedError from verify', async () => {
      vi.mocked(service.verify).mockRejectedValue(
        new UnauthorizedError('Token expired', { code: 'TOKEN_EXPIRED' }),
      );
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Bearer expired.token' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('TOKEN_EXPIRED');
    });
  });
});
