import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { REVOKE_USER_SESSIONS_JOB } from '@/application/jobs/revoke-user-sessions-job';
import { RevokeUserSessionsHandler } from '@/application/jobs/revoke-user-sessions-handler';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import { makeFixedClock } from '@test/unit/support/fakes';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeHandler() {
  const refreshTokenRepository = mock<RefreshTokenRepository>();
  refreshTokenRepository.revokeAllForUser.mockResolvedValue(undefined);
  const clock = makeFixedClock(NOW);
  const handler = new RevokeUserSessionsHandler({ refreshTokenRepository, clock });

  return { handler, refreshTokenRepository, clock };
}

describe('RevokeUserSessionsHandler', () => {
  it('exposes the revoke-user-sessions job name', () => {
    expect(makeHandler().handler.jobName).toBe(REVOKE_USER_SESSIONS_JOB);
  });

  it('revokes every refresh token for the payload user at the current instant', async () => {
    const { handler, refreshTokenRepository } = makeHandler();

    await handler.handle({ userId: 'user-1' });

    expect(refreshTokenRepository.revokeAllForUser).toHaveBeenCalledOnce();
    expect(refreshTokenRepository.revokeAllForUser).toHaveBeenCalledWith('user-1', NOW);
  });

  it('propagates a failure so the worker can retry the naturally idempotent revoke', async () => {
    const { handler, refreshTokenRepository } = makeHandler();
    refreshTokenRepository.revokeAllForUser.mockRejectedValue(new Error('db down'));

    await expect(handler.handle({ userId: 'user-1' })).rejects.toThrow('db down');
  });
});
