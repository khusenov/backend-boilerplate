import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { Clock } from '@/application/shared/ports/clock';
import type { Logger } from '@/application/shared/ports/logger';

export const DATA_RETENTION_JOB = 'data.retention';
export const DATA_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // hourly

export interface EnforceDataRetentionJobDeps {
  retentionTasks: RetentionTask[];
  dataRetentionWindowMs: number;
  clock: Clock;
  logger: Logger;
}

export class EnforceDataRetentionJob implements JobHandler {
  readonly jobName = DATA_RETENTION_JOB;
  private readonly retentionTasks: RetentionTask[];
  private readonly dataRetentionWindowMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor({
    retentionTasks,
    dataRetentionWindowMs,
    clock,
    logger,
  }: EnforceDataRetentionJobDeps) {
    this.retentionTasks = retentionTasks;
    this.dataRetentionWindowMs = dataRetentionWindowMs;
    this.clock = clock;
    this.logger = logger;
  }

  async handle(): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - this.dataRetentionWindowMs);
    for (const task of this.retentionTasks) {
      try {
        const deleted = await task.prune(cutoff);
        this.logger.info('Pruned expired records', { resource: task.resource, deleted, cutoff });
      } catch (error) {
        this.logger.error('Failed to prune expired records', {
          resource: task.resource,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
