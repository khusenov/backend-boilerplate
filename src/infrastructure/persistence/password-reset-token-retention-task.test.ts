import { describe, expect, it, vi } from 'vitest';
import { PasswordResetTokenRetentionTask } from './password-reset-token-retention-task';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';

function makeTask(deleteExpired = vi.fn().mockResolvedValue(0)) {
  const passwordResetTokenRepository = { deleteExpired } as unknown as PasswordResetTokenRepository;
  const task = new PasswordResetTokenRetentionTask({ passwordResetTokenRepository });
  return { task, deleteExpired };
}

describe('PasswordResetTokenRetentionTask', () => {
  it('names the resource it prunes', () => {
    const { task } = makeTask();
    expect(task.resource).toBe('password_reset_tokens');
  });

  it('delegates to deleteExpired with the cutoff and returns the deleted count', async () => {
    const cutoff = new Date('2026-07-21T00:00:00.000Z');
    const { task, deleteExpired } = makeTask(vi.fn().mockResolvedValue(4));

    const deleted = await task.prune(cutoff);

    expect(deleteExpired).toHaveBeenCalledWith(cutoff);
    expect(deleted).toBe(4);
  });
});
