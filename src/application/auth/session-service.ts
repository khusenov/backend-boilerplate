import type { AuthTokensDto } from './auth-dto';
import type { AccessTokenService } from '@/application/shared/ports/access-token-service';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Env } from '@/config/env';
import type { User } from '@/domain/user/user-entity';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';
import type { UserGrants } from '@/application/shared/ports/grants-reader';

const MILLISECONDS_PER_SECOND = 1000;

interface SessionServiceDeps {
  accessTokenService: AccessTokenService;
  opaqueTokenService: OpaqueTokenService;
  refreshTokenRepository: RefreshTokenRepository;
  idGenerator: IdGenerator;
  env: Env;
}

export class SessionService {
  private readonly accessTokens: AccessTokenService;
  private readonly opaque: OpaqueTokenService;
  private readonly refreshTokens: RefreshTokenRepository;
  private readonly ids: IdGenerator;
  private readonly env: Env;

  constructor({
    accessTokenService,
    opaqueTokenService,
    refreshTokenRepository,
    idGenerator,
    env,
  }: SessionServiceDeps) {
    this.accessTokens = accessTokenService;
    this.opaque = opaqueTokenService;
    this.refreshTokens = refreshTokenRepository;
    this.ids = idGenerator;
    this.env = env;
  }

  issue(user: User, grants: UserGrants, now: Date): Promise<AuthTokensDto> {
    return this.mint(user, this.ids.generate(), grants, now);
  }

  reissue(user: User, familyId: string, grants: UserGrants, now: Date): Promise<AuthTokensDto> {
    return this.mint(user, familyId, grants, now);
  }

  private async mint(
    user: User,
    familyId: string,
    grants: UserGrants,
    now: Date,
  ): Promise<AuthTokensDto> {
    const accessToken = await this.accessTokens.sign(
      {
        sub: user.id,
        email: user.email.toString(),
        systemRoleKeys: grants.systemRoleKeys,
        permissions: grants.permissions,
      },
      now,
    );

    const rawRefresh = this.opaque.generate();
    await this.refreshTokens.create(this.buildRefreshToken(user, familyId, rawRefresh, now));

    return {
      accessToken,
      refreshToken: rawRefresh,
    };
  }

  private buildRefreshToken(
    user: User,
    familyId: string,
    rawRefresh: string,
    now: Date,
  ): RefreshToken {
    const expiresAt = new Date(
      now.getTime() + this.env.REFRESH_TOKEN_TTL * MILLISECONDS_PER_SECOND,
    );

    return RefreshToken.create(
      {
        id: this.ids.generate(),
        userId: user.id,
        familyId,
        tokenHash: this.opaque.hash(rawRefresh),
        expiresAt,
      },
      now,
    );
  }
}
