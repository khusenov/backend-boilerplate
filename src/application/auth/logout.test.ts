import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logout } from './logout';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { Clock } from '@/application/shared/ports/clock';

const TOKEN_HASH = 'hashed-raw-token';
const FAMILY_ID = 'family-abc';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeActiveToken(): RefreshToken {
  return RefreshToken.create(
    {
      id: 'token-1',
      userId: 'user-1',
      familyId: FAMILY_ID,
      tokenHash: TOKEN_HASH,
      expiresAt: new Date(CREATED_AT.getTime() + 60_000),
    },
    CREATED_AT,
  );
}

function makeLogout() {
  const refreshTokens = {
    create: vi.fn<RefreshTokenRepository['create']>(),
    findByTokenHash: vi.fn<RefreshTokenRepository['findByTokenHash']>(),
    update: vi.fn<RefreshTokenRepository['update']>(),
    revokeFamily: vi.fn<RefreshTokenRepository['revokeFamily']>().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn<RefreshTokenRepository['revokeAllForUser']>(),
    deleteExpired: vi.fn<RefreshTokenRepository['deleteExpired']>(),
  } satisfies RefreshTokenRepository;

  const opaque = {
    generate: vi.fn<OpaqueTokenService['generate']>(),
    hash: vi.fn<OpaqueTokenService['hash']>().mockReturnValue(TOKEN_HASH),
  } satisfies OpaqueTokenService;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new Logout({
    refreshTokenRepository: refreshTokens,
    opaqueTokenService: opaque,
    clock,
  });

  return { sut, refreshTokens, opaque, clock };
}

describe('Logout', () => {
  let ctx: ReturnType<typeof makeLogout>;

  beforeEach(() => {
    ctx = makeLogout();
  });

  describe('execute', () => {
    it('does nothing when no refreshToken is provided', async () => {
      await ctx.sut.execute({});

      expect(ctx.opaque.hash).not.toHaveBeenCalled();
      expect(ctx.refreshTokens.findByTokenHash).not.toHaveBeenCalled();
      expect(ctx.refreshTokens.revokeFamily).not.toHaveBeenCalled();
      expect(ctx.clock.now).not.toHaveBeenCalled();
    });

    it('does nothing when the token is not found in the repository', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(null);

      await ctx.sut.execute({ refreshToken: 'raw-token' });

      expect(ctx.opaque.hash).toHaveBeenCalledOnce();
      expect(ctx.refreshTokens.findByTokenHash).toHaveBeenCalledOnce();
      expect(ctx.refreshTokens.revokeFamily).not.toHaveBeenCalled();
    });

    it('revokes the token family when a valid token is found', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeActiveToken());

      await ctx.sut.execute({ refreshToken: 'raw-token' });

      expect(ctx.refreshTokens.revokeFamily).toHaveBeenCalledOnce();
      expect(ctx.refreshTokens.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, NOW);
    });

    it('hashes the provided raw token before looking it up', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(null);

      await ctx.sut.execute({ refreshToken: 'my-raw-token' });

      expect(ctx.opaque.hash).toHaveBeenCalledWith('my-raw-token');
      expect(ctx.refreshTokens.findByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    });
  });
});
