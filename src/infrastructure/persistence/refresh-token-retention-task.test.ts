import { describe, expect, it, vi } from 'vitest';
import { RefreshTokenRetentionTask } from './refresh-token-retention-task';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';

function makeTask(deleteExpired = vi.fn().mockResolvedValue(0)) {
  const refreshTokenRepository = { deleteExpired } as unknown as RefreshTokenRepository;
  const task = new RefreshTokenRetentionTask({ refreshTokenRepository });
  return { task, deleteExpired };
}

describe('RefreshTokenRetentionTask', () => {
  it('names the resource it prunes', () => {
    const { task } = makeTask();
    expect(task.resource).toBe('refresh_tokens');
  });

  it('delegates to deleteExpired with the cutoff and returns the deleted count', async () => {
    const cutoff = new Date('2026-07-21T00:00:00.000Z');
    const { task, deleteExpired } = makeTask(vi.fn().mockResolvedValue(4));

    const deleted = await task.prune(cutoff);

    expect(deleteExpired).toHaveBeenCalledWith(cutoff);
    expect(deleted).toBe(4);
  });
});
