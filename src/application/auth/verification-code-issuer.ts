import { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { VerificationConfig } from '@/application/auth/verification-config';

export interface IssuedVerificationCode {
  code: EmailVerificationCode;
  rawCode: string;
}

interface VerificationCodeIssuerDeps {
  verificationCodeService: VerificationCodeService;
  idGenerator: IdGenerator;
  verificationConfig: VerificationConfig;
}

const MILLISECONDS_PER_SECOND = 1000;

export class VerificationCodeIssuer {
  private readonly codeService: VerificationCodeService;
  private readonly ids: IdGenerator;
  private readonly config: VerificationConfig;

  constructor({
    verificationCodeService,
    idGenerator,
    verificationConfig,
  }: VerificationCodeIssuerDeps) {
    this.codeService = verificationCodeService;
    this.ids = idGenerator;
    this.config = verificationConfig;
  }

  issue(userId: string, now: Date): IssuedVerificationCode {
    const rawCode = this.codeService.generate();
    const code = EmailVerificationCode.issue(
      {
        id: this.ids.generate(),
        userId,
        codeHash: this.codeService.hash(rawCode),
        expiresAt: this.expiryFrom(now),
        maxAttempts: this.config.maxAttempts,
      },
      now,
    );
    return { code, rawCode };
  }

  reissue(existing: EmailVerificationCode, now: Date): string {
    const rawCode = this.codeService.generate();
    existing.reissue(this.codeService.hash(rawCode), this.expiryFrom(now), now);
    return rawCode;
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.ttlSeconds * MILLISECONDS_PER_SECOND);
  }
}
