import { Entity, type EntityProps } from '@/domain/shared/entity';
import {
  VerificationCodeExpiredError,
  VerificationCodeInvalidError,
  TooManyVerificationAttemptsError,
} from './verification-errors';

interface EmailVerificationCodeProps extends EntityProps {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
}

interface EmailVerificationCodeIssueParams {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  maxAttempts: number;
}

export class EmailVerificationCode extends Entity<EmailVerificationCodeProps> {
  private constructor(props: EmailVerificationCodeProps) {
    super(props);
  }

  get userId(): string {
    return this.props.userId;
  }

  get codeHash(): string {
    return this.props.codeHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get attempts(): number {
    return this.props.attempts;
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  get consumedAt(): Date | null {
    return this.props.consumedAt;
  }

  get isConsumed(): boolean {
    return this.props.consumedAt !== null;
  }

  static issue(params: EmailVerificationCodeIssueParams, now: Date): EmailVerificationCode {
    return new EmailVerificationCode({
      ...params,
      attempts: 0,
      consumedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static hydrate(props: EmailVerificationCodeProps): EmailVerificationCode {
    return new EmailVerificationCode(props);
  }

  verify(candidateHash: string, now: Date): void {
    if (this.isConsumed) {
      throw new VerificationCodeInvalidError();
    }
    if (now.getTime() >= this.props.expiresAt.getTime()) {
      throw new VerificationCodeExpiredError();
    }
    if (this.props.attempts >= this.props.maxAttempts) {
      throw new TooManyVerificationAttemptsError();
    }
    if (candidateHash !== this.props.codeHash) {
      this.props.attempts += 1;
      this.touch(now);
      throw new VerificationCodeInvalidError();
    }
    this.props.consumedAt = now;
    this.touch(now);
  }

  reissue(codeHash: string, expiresAt: Date, now: Date): void {
    this.props.codeHash = codeHash;
    this.props.expiresAt = expiresAt;
    this.props.attempts = 0;
    this.props.consumedAt = null;
    this.touch(now);
  }
}
