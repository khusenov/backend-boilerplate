import type { PasswordResetToken } from './password-reset-token-entity';

export interface PasswordResetTokenRepository {
  create(token: PasswordResetToken): Promise<void>;

  update(token: PasswordResetToken): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null>;

  invalidateAllForUser(userId: string, now: Date): Promise<void>;

  deleteExpired(cutoff: Date): Promise<number>;
}
