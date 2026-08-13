import { PasswordResetToken } from '@/domain/password-reset/password-reset-token-entity';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordResetConfig } from '@/application/auth/password-reset-config';

export interface IssuedPasswordResetToken {
  token: PasswordResetToken;
  rawToken: string;
}

interface PasswordResetTokenIssuerDeps {
  opaqueTokenService: OpaqueTokenService;
  idGenerator: IdGenerator;
  passwordResetConfig: PasswordResetConfig;
}

const MILLISECONDS_PER_SECOND = 1000;

export class PasswordResetTokenIssuer {
  private readonly opaqueTokens: OpaqueTokenService;
  private readonly ids: IdGenerator;
  private readonly config: PasswordResetConfig;

  constructor({
    opaqueTokenService,
    idGenerator,
    passwordResetConfig,
  }: PasswordResetTokenIssuerDeps) {
    this.opaqueTokens = opaqueTokenService;
    this.ids = idGenerator;
    this.config = passwordResetConfig;
  }

  issue(userId: string, now: Date): IssuedPasswordResetToken {
    const rawToken = this.opaqueTokens.generate();
    const token = PasswordResetToken.issue(
      {
        id: this.ids.generate(),
        userId,
        tokenHash: this.opaqueTokens.hash(rawToken),
        expiresAt: this.expiryFrom(now),
      },
      now,
    );
    return { token, rawToken };
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.ttlSeconds * MILLISECONDS_PER_SECOND);
  }
}
