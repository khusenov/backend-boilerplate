import type { EmailVerificationCode } from './email-verification-code-entity';

export interface EmailVerificationCodeRepository {
  create(code: EmailVerificationCode): Promise<void>;

  update(code: EmailVerificationCode): Promise<void>;

  findActiveByUserId(userId: string): Promise<EmailVerificationCode | null>;
}
