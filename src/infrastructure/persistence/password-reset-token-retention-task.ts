import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';

export interface PasswordResetTokenRetentionTaskDeps {
  passwordResetTokenRepository: PasswordResetTokenRepository;
}

export class PasswordResetTokenRetentionTask implements RetentionTask {
  readonly resource = 'password_reset_tokens';
  private readonly passwordResetTokenRepository: PasswordResetTokenRepository;

  constructor({ passwordResetTokenRepository }: PasswordResetTokenRetentionTaskDeps) {
    this.passwordResetTokenRepository = passwordResetTokenRepository;
  }

  prune(cutoff: Date): Promise<number> {
    return this.passwordResetTokenRepository.deleteExpired(cutoff);
  }
}
