import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { JoseAccessTokenService } from './jose-access-token-service';
import { UnauthorizedError } from '@/shared/errors';
import type { Env } from '@/config/env';

function makeEnv(
  overrides: Partial<
    Pick<Env, 'JWT_ACCESS_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'ACCESS_TOKEN_TTL'>
  > = {},
): Env {
  return {
    JWT_ACCESS_SECRET: 'test-secret-long-enough-for-hs256!!',
    JWT_ISSUER: 'test-issuer',
    JWT_AUDIENCE: 'test-audience',
    ACCESS_TOKEN_TTL: 900,
    ...overrides,
  } as unknown as Env;
}

describe('JoseAccessTokenService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sign + verify round-trip', () => {
    it('returns the original payload after signing and verifying', async () => {
      const sut = new JoseAccessTokenService({ env: makeEnv() });

      const token = await sut.sign({
        sub: 'user-123',
        email: 'alice@example.com',
        systemRoleKeys: ['super-admin'],
        permissions: ['users.read', 'users.create'],
      });
      const result = await sut.verify(token);

      expect(result.sub).toBe('user-123');
      expect(result.email).toBe('alice@example.com');
      expect(result.systemRoleKeys).toEqual(['super-admin']);
      expect(result.permissions).toEqual(['users.read', 'users.create']);
    });

    it('defaults missing role/permission claims to empty arrays, never undefined', async () => {
      // A legacy token minted before the RBAC rollout carries no systemRoleKeys
      // or permissions claim. verify() must degrade it to empty arrays so the
      // guard does a clean `[].includes(...)` (403) instead of crashing on
      // `undefined.includes(...)` (500) for the whole rollout window (W13).
      const env = makeEnv();
      const legacyToken = await new SignJWT({ email: 'legacy@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user-legacy')
        .setIssuedAt()
        .setIssuer(env.JWT_ISSUER)
        .setAudience(env.JWT_AUDIENCE)
        .setExpirationTime('900s')
        .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));

      const result = await new JoseAccessTokenService({ env }).verify(legacyToken);

      expect(result.systemRoleKeys).toEqual([]);
      expect(result.permissions).toEqual([]);
    });
  });

  describe('verify', () => {
    it('throws UnauthorizedError for a malformed token', async () => {
      const sut = new JoseAccessTokenService({ env: makeEnv() });

      await expect(sut.verify('not.a.jwt')).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when signed with a different secret', async () => {
      const signer = new JoseAccessTokenService({
        env: makeEnv({ JWT_ACCESS_SECRET: 'secret-a-long-enough-for-hs256-tests!!' }),
      });
      const verifier = new JoseAccessTokenService({
        env: makeEnv({ JWT_ACCESS_SECRET: 'secret-b-long-enough-for-hs256-tests!!' }),
      });

      const token = await signer.sign({
        sub: 'user-1',
        email: 'x@x.com',
        systemRoleKeys: [],
        permissions: [],
      });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when the issuer does not match', async () => {
      const signer = new JoseAccessTokenService({ env: makeEnv() });
      const verifier = new JoseAccessTokenService({
        env: makeEnv({ JWT_ISSUER: 'different-issuer' }),
      });

      const token = await signer.sign({
        sub: 'user-1',
        email: 'x@x.com',
        systemRoleKeys: [],
        permissions: [],
      });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when the audience does not match', async () => {
      const signer = new JoseAccessTokenService({ env: makeEnv() });
      const verifier = new JoseAccessTokenService({
        env: makeEnv({ JWT_AUDIENCE: 'different-audience' }),
      });

      const token = await signer.sign({
        sub: 'user-1',
        email: 'x@x.com',
        systemRoleKeys: [],
        permissions: [],
      });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError for an expired token', async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const sut = new JoseAccessTokenService({ env: makeEnv({ ACCESS_TOKEN_TTL: 1 }) });
      const token = await sut.sign({
        sub: 'user-1',
        email: 'x@x.com',
        systemRoleKeys: [],
        permissions: [],
      });

      vi.setSystemTime(now + 5000);

      await expect(sut.verify(token)).rejects.toThrow(UnauthorizedError);
    });
  });
});
