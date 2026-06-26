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

const RAW_TOKEN = 'raw-refresh-token';
const TOKEN_HASH = 'hashed-raw-refresh-token';
const FAMILY_ID = 'family-abc';

const FAKE_TOKENS: AuthTokensDto = {
  accessToken: 'new.access.token',
  refreshToken: 'new-raw-refresh',
};

function makeActiveToken(): RefreshToken {
  return RefreshToken.create({
    id: 'token-1',
    userId: 'user-1',
    familyId: FAMILY_ID,
    tokenHash: TOKEN_HASH,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

function makeRevokedToken(): RefreshToken {
  const token = makeActiveToken();
  token.revoke();
  return token;
}

function makeUsedToken(): RefreshToken {
  const token = makeActiveToken();
  token.markUsed();
  return token;
}

function makeExpiredToken(): RefreshToken {
  return RefreshToken.create({
    id: 'token-1',
    userId: 'user-1',
    familyId: FAMILY_ID,
    tokenHash: TOKEN_HASH,
    expiresAt: new Date(Date.now() - 60_000),
  });
}

function makeActiveUser(): User {
  return User.create({
    id: 'user-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-secret',
  });
}

function makeInactiveUser(): User {
  const user = makeActiveUser();
  user.deactivate();
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

  const sut = new RefreshSession({
    userRepository: users,
    refreshTokenRepository: refreshTokens,
    opaqueTokenService: opaque,
    sessionService: sessions as unknown as SessionService,
  });

  return { sut, refreshTokens, users, opaque, sessions };
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
      expect(ctx.sessions.reissue).toHaveBeenCalledWith(user, FAMILY_ID);
      expect(result).toEqual(FAKE_TOKENS);
    });
  });
});
