import { afterEach, describe, expect, it, vi } from 'vitest';
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

      const token = await sut.sign({ sub: 'user-123', email: 'alice@example.com' });
      const result = await sut.verify(token);

      expect(result.sub).toBe('user-123');
      expect(result.email).toBe('alice@example.com');
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

      const token = await signer.sign({ sub: 'user-1', email: 'x@x.com' });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when the issuer does not match', async () => {
      const signer = new JoseAccessTokenService({ env: makeEnv() });
      const verifier = new JoseAccessTokenService({
        env: makeEnv({ JWT_ISSUER: 'different-issuer' }),
      });

      const token = await signer.sign({ sub: 'user-1', email: 'x@x.com' });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when the audience does not match', async () => {
      const signer = new JoseAccessTokenService({ env: makeEnv() });
      const verifier = new JoseAccessTokenService({
        env: makeEnv({ JWT_AUDIENCE: 'different-audience' }),
      });

      const token = await signer.sign({ sub: 'user-1', email: 'x@x.com' });

      await expect(verifier.verify(token)).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError for an expired token', async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const sut = new JoseAccessTokenService({ env: makeEnv({ ACCESS_TOKEN_TTL: 1 }) });
      const token = await sut.sign({ sub: 'user-1', email: 'x@x.com' });

      vi.setSystemTime(now + 5000);

      await expect(sut.verify(token)).rejects.toThrow(UnauthorizedError);
    });
  });
});
