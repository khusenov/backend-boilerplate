import type { UserRepository } from '@/domain/user/user-repository';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import { SessionService } from './session-service';
import type { AuthTokensDto } from './auth-dto';
import { RefreshTokenInvalidError, RefreshTokenReusedError } from '@/domain/auth/auth-errors';

export interface RefreshSessionInput {
  refreshToken: string;
}

export type RefreshSessionOutput = AuthTokensDto;

interface RefreshSessionDeps {
  userRepository: UserRepository;
  refreshTokenRepository: RefreshTokenRepository;
  opaqueTokenService: OpaqueTokenService;
  sessionService: SessionService;
}

export class RefreshSession {
  private readonly users: UserRepository;
  private readonly refreshTokens: RefreshTokenRepository;
  private readonly opaque: OpaqueTokenService;
  private readonly sessions: SessionService;

  constructor({
    userRepository,
    refreshTokenRepository,
    opaqueTokenService,
    sessionService,
  }: RefreshSessionDeps) {
    this.users = userRepository;
    this.refreshTokens = refreshTokenRepository;
    this.opaque = opaqueTokenService;
    this.sessions = sessionService;
  }

  async execute(input: RefreshSessionInput): Promise<RefreshSessionOutput> {
    const now = new Date();
    const tokenHash = this.opaque.hash(input.refreshToken);
    const record = await this.refreshTokens.findByTokenHash(tokenHash);

    if (!record) throw new RefreshTokenInvalidError();
    if (record.isRevoked) throw new RefreshTokenInvalidError();

    if (record.isUsed) {
      await this.refreshTokens.revokeFamily(record.familyId, now);
      throw new RefreshTokenReusedError();
    }

    if (record.isExpired(now)) throw new RefreshTokenInvalidError();

    const user = await this.users.findById(record.userId);
    if (!user?.isActive) {
      await this.refreshTokens.revokeFamily(record.familyId, now);
      throw new RefreshTokenInvalidError();
    }

    record.markUsed();
    await this.refreshTokens.update(record);

    return this.sessions.reissue(user, record.familyId);
  }
}
