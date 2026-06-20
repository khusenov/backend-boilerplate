import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';

interface LogoutInput {
  refreshToken?: string | undefined;
}

interface LogoutDeps {
  refreshTokenRepository: RefreshTokenRepository;
  opaqueTokenService: OpaqueTokenService;
}

export class Logout {
  private readonly refreshTokens: RefreshTokenRepository;
  private readonly opaque: OpaqueTokenService;

  constructor({ refreshTokenRepository, opaqueTokenService }: LogoutDeps) {
    this.refreshTokens = refreshTokenRepository;
    this.opaque = opaqueTokenService;
  }

  async execute(input: LogoutInput): Promise<void> {
    if (!input.refreshToken) return;
    const now = new Date();
    const tokenHash = this.opaque.hash(input.refreshToken);
    const record = await this.refreshTokens.findByTokenHash(tokenHash);
    if (record) await this.refreshTokens.revokeFamily(record.familyId, now);
  }
}
