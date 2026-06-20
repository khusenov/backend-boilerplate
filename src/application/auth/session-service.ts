import type { AuthTokensDto } from './auth-dto';
import type { AccessTokenService } from '@/application/shared/ports/access-token-service';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Env } from '@/config/env';
import type { User } from '@/domain/user/user-entity';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';

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

  issue(user: User): Promise<AuthTokensDto> {
    return this.mint(user, this.ids.generate());
  }

  reissue(user: User, familyId: string): Promise<AuthTokensDto> {
    return this.mint(user, familyId);
  }

  private async mint(user: User, familyId: string): Promise<AuthTokensDto> {
    const accessToken = await this.accessTokens.sign({
      sub: user.id,
      email: user.email.toString(),
    });

    const rawRefresh = this.opaque.generate();
    const tokenHash = this.opaque.hash(rawRefresh);
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL * 1000);

    const refresh = RefreshToken.create({
      id: this.ids.generate(),
      userId: user.id,
      familyId,
      tokenHash,
      expiresAt,
    });

    await this.refreshTokens.create(refresh);

    return {
      accessToken,
      refreshToken: rawRefresh,
    };
  }
}
