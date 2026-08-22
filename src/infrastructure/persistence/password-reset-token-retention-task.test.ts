import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PasswordResetTokenRetentionTask } from './password-reset-token-retention-task';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';

function makeTask() {
  const passwordResetTokenRepository = mock<PasswordResetTokenRepository>();
  passwordResetTokenRepository.deleteExpired.mockResolvedValue(0);
  const task = new PasswordResetTokenRetentionTask({ passwordResetTokenRepository });
  return { task, passwordResetTokenRepository };
}

describe('PasswordResetTokenRetentionTask', () => {
  it('names the resource it prunes', () => {
    const { task } = makeTask();
    expect(task.resource).toBe('password_reset_tokens');
  });

  it('delegates to deleteExpired with the cutoff and returns the deleted count', async () => {
    const cutoff = new Date('2026-07-21T00:00:00.000Z');
    const { task, passwordResetTokenRepository } = makeTask();
    passwordResetTokenRepository.deleteExpired.mockResolvedValue(4);

    const deleted = await task.prune(cutoff);

    expect(passwordResetTokenRepository.deleteExpired).toHaveBeenCalledWith(cutoff);
    expect(deleted).toBe(4);
  });
});
