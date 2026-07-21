import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';

export interface RefreshTokenRetentionTaskDeps {
  refreshTokenRepository: RefreshTokenRepository;
}

export class RefreshTokenRetentionTask implements RetentionTask {
  readonly resource = 'refresh_tokens';
  private readonly refreshTokenRepository: RefreshTokenRepository;

  constructor({ refreshTokenRepository }: RefreshTokenRetentionTaskDeps) {
    this.refreshTokenRepository = refreshTokenRepository;
  }

  prune(cutoff: Date): Promise<number> {
    return this.refreshTokenRepository.deleteExpired(cutoff);
  }
}
