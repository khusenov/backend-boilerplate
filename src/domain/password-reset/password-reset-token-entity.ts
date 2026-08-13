import { Entity, type EntityProps } from '@/domain/shared/entity';
import {
  PasswordResetTokenExpiredError,
  PasswordResetTokenInvalidError,
} from './password-reset-errors';

interface PasswordResetTokenProps extends EntityProps {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface PasswordResetTokenIssueParams {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export class PasswordResetToken extends Entity<PasswordResetTokenProps> {
  private constructor(props: PasswordResetTokenProps) {
    super(props);
  }

  get userId(): string {
    return this.props.userId;
  }

  get tokenHash(): string {
    return this.props.tokenHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get usedAt(): Date | null {
    return this.props.usedAt;
  }

  get isUsed(): boolean {
    return this.props.usedAt !== null;
  }

  static issue(params: PasswordResetTokenIssueParams, now: Date): PasswordResetToken {
    return new PasswordResetToken({
      ...params,
      usedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static hydrate(props: PasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props);
  }

  consume(now: Date): void {
    if (this.isUsed) {
      throw new PasswordResetTokenInvalidError();
    }
    if (now.getTime() >= this.props.expiresAt.getTime()) {
      throw new PasswordResetTokenExpiredError();
    }
    this.props.usedAt = now;
    this.touch(now);
  }
}
