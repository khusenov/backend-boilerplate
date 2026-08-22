import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './session-service';
import type { AccessTokenService } from '@/application/shared/ports/access-token-service';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { Env } from '@/config/env';
import type { UserGrants } from '@/application/shared/ports/grants-reader';
import { makeUser } from '@test/unit/support/builders';

const ACCESS_TOKEN = 'signed.access.token';
const RAW_REFRESH = 'raw-opaque-refresh';
const TOKEN_HASH = 'hashed-opaque-refresh';
const FAMILY_ID = 'family-id-abc';
const TOKEN_ID = 'token-id-xyz';
const NEW_FAMILY_ID = 'new-family-id';
const TTL_SECONDS = 60 * 60 * 24 * 14;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const GRANTS: UserGrants = {
  systemRoleKeys: ['super-admin'],
  permissions: ['users.read', 'users.create'],
};

function makeCtx() {
  const accessTokenService = {
    sign: vi.fn<AccessTokenService['sign']>().mockResolvedValue(ACCESS_TOKEN),
    verify: vi.fn<AccessTokenService['verify']>(),
  } satisfies AccessTokenService;

  const opaqueTokenService = {
    generate: vi.fn<OpaqueTokenService['generate']>().mockReturnValue(RAW_REFRESH),
    hash: vi.fn<OpaqueTokenService['hash']>().mockReturnValue(TOKEN_HASH),
  } satisfies OpaqueTokenService;

  const refreshTokenRepository = {
    create: vi.fn<RefreshTokenRepository['create']>().mockResolvedValue(undefined),
    findByTokenHash: vi.fn<RefreshTokenRepository['findByTokenHash']>(),
    update: vi.fn<RefreshTokenRepository['update']>(),
    revokeFamily: vi.fn<RefreshTokenRepository['revokeFamily']>(),
    revokeAllForUser: vi.fn<RefreshTokenRepository['revokeAllForUser']>(),
    deleteExpired: vi.fn<RefreshTokenRepository['deleteExpired']>(),
  } satisfies RefreshTokenRepository;

  const idGenerator = {
    generate: vi.fn<IdGenerator['generate']>(),
  } satisfies IdGenerator;

  const env = { REFRESH_TOKEN_TTL: TTL_SECONDS } as Env;

  const sut = new SessionService({
    accessTokenService,
    opaqueTokenService,
    refreshTokenRepository,
    idGenerator,
    env,
  });

  return { sut, accessTokenService, opaqueTokenService, refreshTokenRepository, idGenerator };
}

describe('SessionService', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  describe('issue', () => {
    beforeEach(() => {
      ctx.idGenerator.generate.mockReturnValueOnce(NEW_FAMILY_ID).mockReturnValueOnce(TOKEN_ID);
    });

    it('returns the signed access token and raw refresh token', async () => {
      const result = await ctx.sut.issue(makeUser(), GRANTS, NOW);

      expect(result.accessToken).toBe(ACCESS_TOKEN);
      expect(result.refreshToken).toBe(RAW_REFRESH);
    });

    it('signs the access token with the user id, email, and grants as payload', async () => {
      const user = makeUser();
      await ctx.sut.issue(user, GRANTS, NOW);

      expect(ctx.accessTokenService.sign).toHaveBeenCalledOnce();
      expect(ctx.accessTokenService.sign).toHaveBeenCalledWith(
        {
          sub: user.id,
          email: user.email.toString(),
          systemRoleKeys: GRANTS.systemRoleKeys,
          permissions: GRANTS.permissions,
        },
        NOW,
      );
    });

    it('hashes the raw refresh token before storing', async () => {
      await ctx.sut.issue(makeUser(), GRANTS, NOW);

      expect(ctx.opaqueTokenService.hash).toHaveBeenCalledOnce();
      expect(ctx.opaqueTokenService.hash).toHaveBeenCalledWith(RAW_REFRESH);
    });

    it('persists the refresh token entity in the repository', async () => {
      await ctx.sut.issue(makeUser(), GRANTS, NOW);

      expect(ctx.refreshTokenRepository.create).toHaveBeenCalledOnce();
    });

    it('uses a freshly generated family id', async () => {
      await ctx.sut.issue(makeUser(), GRANTS, NOW);

      const [storedToken] = ctx.refreshTokenRepository.create.mock.calls[0]!;
      expect(storedToken.familyId).toBe(NEW_FAMILY_ID);
    });

    it('stamps the token and its expiry from the single passed instant', async () => {
      await ctx.sut.issue(makeUser(), GRANTS, NOW);

      const [storedToken] = ctx.refreshTokenRepository.create.mock.calls[0]!;

      expect(storedToken.createdAt).toEqual(NOW);
      expect(storedToken.expiresAt.getTime() - storedToken.createdAt.getTime()).toBe(
        TTL_SECONDS * 1000,
      );
      expect(ctx.accessTokenService.sign.mock.calls[0]![1]).toEqual(storedToken.createdAt);
    });
  });

  describe('reissue', () => {
    beforeEach(() => {
      ctx.idGenerator.generate.mockReturnValue(TOKEN_ID);
    });

    it('returns the signed access token and raw refresh token', async () => {
      const result = await ctx.sut.reissue(makeUser(), FAMILY_ID, GRANTS, NOW);

      expect(result.accessToken).toBe(ACCESS_TOKEN);
      expect(result.refreshToken).toBe(RAW_REFRESH);
    });

    it('signs the access token with the user id, email, and grants as payload', async () => {
      const user = makeUser();
      await ctx.sut.reissue(user, FAMILY_ID, GRANTS, NOW);

      expect(ctx.accessTokenService.sign).toHaveBeenCalledOnce();
      expect(ctx.accessTokenService.sign).toHaveBeenCalledWith(
        {
          sub: user.id,
          email: user.email.toString(),
          systemRoleKeys: GRANTS.systemRoleKeys,
          permissions: GRANTS.permissions,
        },
        NOW,
      );
    });

    it('preserves the existing family id rather than generating a new one', async () => {
      await ctx.sut.reissue(makeUser(), FAMILY_ID, GRANTS, NOW);

      const [storedToken] = ctx.refreshTokenRepository.create.mock.calls[0]!;
      expect(storedToken.familyId).toBe(FAMILY_ID);
    });

    it('calls idGenerator only once (for the token entity id, not a new family)', async () => {
      await ctx.sut.reissue(makeUser(), FAMILY_ID, GRANTS, NOW);

      expect(ctx.idGenerator.generate).toHaveBeenCalledOnce();
    });

    it('persists the refresh token entity in the repository', async () => {
      await ctx.sut.reissue(makeUser(), FAMILY_ID, GRANTS, NOW);

      expect(ctx.refreshTokenRepository.create).toHaveBeenCalledOnce();
    });
  });
});
