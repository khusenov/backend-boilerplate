import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RefreshSession } from './refresh-session';
import type { AuthTokensDto } from './auth-dto';
import type { SessionService } from './session-service';
import { RefreshTokenInvalidError, RefreshTokenReusedError } from '@/domain/auth/auth-errors';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { GrantsReader, UserGrants } from '@/application/shared/ports/grants-reader';
import type { Clock } from '@/application/shared/ports/clock';

const RAW_TOKEN = 'raw-refresh-token';
const TOKEN_HASH = 'hashed-raw-refresh-token';
const FAMILY_ID = 'family-abc';
const GRANTS: UserGrants = { systemRoleKeys: [], permissions: ['users.read'] };
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

const FAKE_TOKENS: AuthTokensDto = {
  accessToken: 'new.access.token',
  refreshToken: 'new-raw-refresh',
};

function makeTokenExpiringAt(expiresAt: Date): RefreshToken {
  return RefreshToken.create(
    {
      id: 'token-1',
      userId: 'user-1',
      familyId: FAMILY_ID,
      tokenHash: TOKEN_HASH,
      expiresAt,
    },
    CREATED_AT,
  );
}

function makeActiveToken(): RefreshToken {
  return makeTokenExpiringAt(new Date(NOW.getTime() + 60_000));
}

function makeRevokedToken(): RefreshToken {
  const token = makeActiveToken();
  token.revoke(CREATED_AT);
  return token;
}

function makeUsedToken(): RefreshToken {
  const token = makeActiveToken();
  token.markUsed(CREATED_AT);
  return token;
}

function makeExpiredToken(): RefreshToken {
  return makeTokenExpiringAt(new Date(NOW.getTime() - 60_000));
}

function makeActiveUser(): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: Email.create('jane@example.com'),
      passwordHash: 'hashed-secret',
    },
    CREATED_AT,
  );
}

function makeInactiveUser(): User {
  const user = makeActiveUser();
  user.deactivate(CREATED_AT);
  return user;
}

function makeRefreshSession() {
  const refreshTokens = {
    create: vi.fn<RefreshTokenRepository['create']>(),
    findByTokenHash: vi.fn<RefreshTokenRepository['findByTokenHash']>(),
    update: vi.fn<RefreshTokenRepository['update']>().mockResolvedValue(undefined),
    revokeFamily: vi.fn<RefreshTokenRepository['revokeFamily']>().mockResolvedValue(undefined),
    revokeAllForUser: vi.fn<RefreshTokenRepository['revokeAllForUser']>(),
    deleteExpired: vi.fn<RefreshTokenRepository['deleteExpired']>(),
  } satisfies RefreshTokenRepository;

  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const opaque = {
    generate: vi.fn<OpaqueTokenService['generate']>(),
    hash: vi.fn<OpaqueTokenService['hash']>().mockReturnValue(TOKEN_HASH),
  } satisfies OpaqueTokenService;

  const sessions = {
    issue: vi.fn(),
    reissue: vi.fn().mockResolvedValue(FAKE_TOKENS),
  };

  const grants = {
    grantsFor: vi.fn<GrantsReader['grantsFor']>().mockResolvedValue(GRANTS),
  } satisfies GrantsReader;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new RefreshSession({
    userRepository: users,
    refreshTokenRepository: refreshTokens,
    opaqueTokenService: opaque,
    sessionService: sessions as unknown as SessionService,
    grants,
    clock,
  });

  return { sut, refreshTokens, users, opaque, sessions, grants, clock };
}

describe('RefreshSession', () => {
  let ctx: ReturnType<typeof makeRefreshSession>;

  beforeEach(() => {
    ctx = makeRefreshSession();
  });

  describe('execute', () => {
    it('hashes the raw token before looking it up', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(null);

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );

      expect(ctx.opaque.hash).toHaveBeenCalledWith(RAW_TOKEN);
      expect(ctx.refreshTokens.findByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    });

    it('throws RefreshTokenInvalidError when the token is not found', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(null);

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );
    });

    it('throws RefreshTokenInvalidError when the token is revoked', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeRevokedToken());

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );
    });

    it.each([
      ['an unknown token', null],
      ['an already-revoked token', makeRevokedToken],
    ])('never reads the clock for %s', async (_case, arrange) => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(arrange?.() ?? null);

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );

      expect(ctx.clock.now).not.toHaveBeenCalled();
    });

    it('accepts a token expiring one millisecond after now and rejects one expiring before', async () => {
      ctx.users.findById.mockResolvedValue(makeActiveUser());

      ctx.refreshTokens.findByTokenHash.mockResolvedValue(
        makeTokenExpiringAt(new Date(NOW.getTime() + 1)),
      );
      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).resolves.toEqual(FAKE_TOKENS);

      ctx.refreshTokens.findByTokenHash.mockResolvedValue(
        makeTokenExpiringAt(new Date(NOW.getTime() - 1)),
      );
      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );
    });

    it('revokes the family and throws RefreshTokenReusedError on token reuse', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeUsedToken());

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenReusedError,
      );

      expect(ctx.refreshTokens.revokeFamily).toHaveBeenCalledOnce();
      const [calledFamilyId] = ctx.refreshTokens.revokeFamily.mock.calls[0]!;
      expect(calledFamilyId).toBe(FAMILY_ID);
    });

    it('throws RefreshTokenInvalidError when the token is expired', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeExpiredToken());

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );
    });

    it('revokes the family and throws RefreshTokenInvalidError when user is not found', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeActiveToken());
      ctx.users.findById.mockResolvedValue(null);

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );

      expect(ctx.refreshTokens.revokeFamily).toHaveBeenCalledOnce();
      const [calledFamilyId] = ctx.refreshTokens.revokeFamily.mock.calls[0]!;
      expect(calledFamilyId).toBe(FAMILY_ID);
    });

    it('revokes the family and throws RefreshTokenInvalidError when user is inactive', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeActiveToken());
      ctx.users.findById.mockResolvedValue(makeInactiveUser());

      await expect(ctx.sut.execute({ refreshToken: RAW_TOKEN })).rejects.toThrow(
        RefreshTokenInvalidError,
      );

      expect(ctx.refreshTokens.revokeFamily).toHaveBeenCalledOnce();
    });

    it('marks the token as used and persists it on success', async () => {
      const token = makeActiveToken();
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(token);
      ctx.users.findById.mockResolvedValue(makeActiveUser());

      await ctx.sut.execute({ refreshToken: RAW_TOKEN });

      expect(token.isUsed).toBe(true);
      expect(ctx.refreshTokens.update).toHaveBeenCalledOnce();
      expect(ctx.refreshTokens.update).toHaveBeenCalledWith(token);
    });

    it('returns new tokens by reissuing the same family on success', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeActiveToken());
      const user = makeActiveUser();
      ctx.users.findById.mockResolvedValue(user);

      const result = await ctx.sut.execute({ refreshToken: RAW_TOKEN });

      expect(ctx.sessions.reissue).toHaveBeenCalledOnce();
      expect(ctx.sessions.reissue).toHaveBeenCalledWith(user, FAMILY_ID, GRANTS, NOW);
      expect(result).toEqual(FAKE_TOKENS);
    });

    it('stamps usedAt and the reissue with one instant from a single clock reading', async () => {
      const token = makeActiveToken();
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(token);
      ctx.users.findById.mockResolvedValue(makeActiveUser());

      await ctx.sut.execute({ refreshToken: RAW_TOKEN });

      expect(token.usedAt).toEqual(NOW);
      expect(ctx.sessions.reissue.mock.calls[0]![3]).toEqual(token.usedAt);
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });

    it('re-resolves the user grants on every refresh rather than reusing old claims', async () => {
      ctx.refreshTokens.findByTokenHash.mockResolvedValue(makeActiveToken());
      const user = makeActiveUser();
      ctx.users.findById.mockResolvedValue(user);

      await ctx.sut.execute({ refreshToken: RAW_TOKEN });

      expect(ctx.grants.grantsFor).toHaveBeenCalledWith(user.id);
    });
  });
});
