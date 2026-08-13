import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { Clock } from '@/application/shared/ports/clock';
import {
  REVOKE_USER_SESSIONS_JOB,
  type RevokeUserSessionsPayload,
} from '@/application/jobs/revoke-user-sessions-job';

export interface RevokeUserSessionsHandlerDeps {
  refreshTokenRepository: RefreshTokenRepository;
  clock: Clock;
}

export class RevokeUserSessionsHandler implements JobHandler<
  RevokeUserSessionsPayload,
  typeof REVOKE_USER_SESSIONS_JOB
> {
  readonly jobName = REVOKE_USER_SESSIONS_JOB;
  private readonly refreshTokens: RefreshTokenRepository;
  private readonly clock: Clock;

  constructor({ refreshTokenRepository, clock }: RevokeUserSessionsHandlerDeps) {
    this.refreshTokens = refreshTokenRepository;
    this.clock = clock;
  }

  async handle(payload: RevokeUserSessionsPayload): Promise<void> {
    await this.refreshTokens.revokeAllForUser(payload.userId, this.clock.now());
  }
}
