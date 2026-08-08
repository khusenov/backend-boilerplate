import { randomInt, createHmac } from 'node:crypto';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';

const CODE_DIGITS = 6;
const CODE_UPPER_BOUND_EXCLUSIVE = 1_000_000;

export interface CryptoVerificationCodeServiceDeps {
  verificationCodeSecret: string;
}

export class CryptoVerificationCodeService implements VerificationCodeService {
  private readonly secret: string;

  constructor({ verificationCodeSecret }: CryptoVerificationCodeServiceDeps) {
    this.secret = verificationCodeSecret;
  }

  generate(): string {
    return randomInt(0, CODE_UPPER_BOUND_EXCLUSIVE).toString().padStart(CODE_DIGITS, '0');
  }

  hash(code: string): string {
    return createHmac('sha256', this.secret).update(code).digest('hex');
  }
}
