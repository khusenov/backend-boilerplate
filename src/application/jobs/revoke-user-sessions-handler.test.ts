import { describe, expect, it, vi } from 'vitest';
import { REVOKE_USER_SESSIONS_JOB } from '@/application/jobs/revoke-user-sessions-job';
import { RevokeUserSessionsHandler } from '@/application/jobs/revoke-user-sessions-handler';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { Clock } from '@/application/shared/ports/clock';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeHandler() {
  const revokeAllForUser = vi
    .fn<RefreshTokenRepository['revokeAllForUser']>()
    .mockResolvedValue(undefined);
  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;
  const handler = new RevokeUserSessionsHandler({
    refreshTokenRepository: { revokeAllForUser } as unknown as RefreshTokenRepository,
    clock,
  });

  return { handler, revokeAllForUser, clock };
}

describe('RevokeUserSessionsHandler', () => {
  it('exposes the revoke-user-sessions job name', () => {
    expect(makeHandler().handler.jobName).toBe(REVOKE_USER_SESSIONS_JOB);
  });

  it('revokes every refresh token for the payload user at the current instant', async () => {
    const { handler, revokeAllForUser } = makeHandler();

    await handler.handle({ userId: 'user-1' });

    expect(revokeAllForUser).toHaveBeenCalledOnce();
    expect(revokeAllForUser).toHaveBeenCalledWith('user-1', NOW);
  });

  it('propagates a failure so the worker can retry the naturally idempotent revoke', async () => {
    const { handler, revokeAllForUser } = makeHandler();
    revokeAllForUser.mockRejectedValue(new Error('db down'));

    await expect(handler.handle({ userId: 'user-1' })).rejects.toThrow('db down');
  });
});
