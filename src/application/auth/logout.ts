import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { Clock } from '@/application/shared/ports/clock';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';

interface LogoutInput {
  refreshToken?: string | undefined;
}

interface LogoutDeps {
  refreshTokenRepository: RefreshTokenRepository;
  opaqueTokenService: OpaqueTokenService;
  clock: Clock;
}

export class Logout {
  private readonly refreshTokens: RefreshTokenRepository;
  private readonly opaque: OpaqueTokenService;
  private readonly clock: Clock;

  constructor({ refreshTokenRepository, opaqueTokenService, clock }: LogoutDeps) {
    this.refreshTokens = refreshTokenRepository;
    this.opaque = opaqueTokenService;
    this.clock = clock;
  }

  async execute(input: LogoutInput): Promise<void> {
    if (!input.refreshToken) return;
    const tokenHash = this.opaque.hash(input.refreshToken);
    const record = await this.refreshTokens.findByTokenHash(tokenHash);
    if (record) await this.refreshTokens.revokeFamily(record.familyId, this.clock.now());
  }
}
