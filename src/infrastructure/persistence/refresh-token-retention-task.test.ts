import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { RefreshTokenRetentionTask } from './refresh-token-retention-task';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';

function makeTask() {
  const refreshTokenRepository = mock<RefreshTokenRepository>();
  refreshTokenRepository.deleteExpired.mockResolvedValue(0);
  const task = new RefreshTokenRetentionTask({ refreshTokenRepository });
  return { task, refreshTokenRepository };
}

describe('RefreshTokenRetentionTask', () => {
  it('names the resource it prunes', () => {
    const { task } = makeTask();
    expect(task.resource).toBe('refresh_tokens');
  });

  it('delegates to deleteExpired with the cutoff and returns the deleted count', async () => {
    const cutoff = new Date('2026-07-21T00:00:00.000Z');
    const { task, refreshTokenRepository } = makeTask();
    refreshTokenRepository.deleteExpired.mockResolvedValue(4);

    const deleted = await task.prune(cutoff);

    expect(refreshTokenRepository.deleteExpired).toHaveBeenCalledWith(cutoff);
    expect(deleted).toBe(4);
  });
});
