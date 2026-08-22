import { asClass, asFunction, asValue } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import { env } from '@/config/env';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { RetentionTask } from '@/application/shared/ports/retention-task';
import {
  EnforceDataRetentionJob,
  DATA_RETENTION_JOB,
} from '@/application/retention/enforce-data-retention-job';
import { RefreshTokenRetentionTask } from '@/infrastructure/persistence/refresh-token-retention-task';
import { OutboxRetentionTask } from '@/infrastructure/persistence/outbox-retention-task';
import { PasswordResetTokenRetentionTask } from '@/infrastructure/persistence/password-reset-token-retention-task';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    dataRetentionWindowMs: number;
    refreshTokenRetentionTask: RetentionTask;
    outboxRetentionTask: RetentionTask;
    passwordResetTokenRetentionTask: RetentionTask;
    enforceDataRetentionJob: JobHandler<unknown, typeof DATA_RETENTION_JOB>;
  }
}

export const retentionRegistrations = {
  dataRetentionWindowMs: asValue(env.DATA_RETENTION_TTL * 1000),
  refreshTokenRetentionTask: asClass(RefreshTokenRetentionTask).singleton(),
  outboxRetentionTask: asClass(OutboxRetentionTask).singleton(),
  passwordResetTokenRetentionTask: asClass(PasswordResetTokenRetentionTask).singleton(),
  enforceDataRetentionJob: asFunction(
    ({
      refreshTokenRetentionTask,
      outboxRetentionTask,
      passwordResetTokenRetentionTask,
      dataRetentionWindowMs,
      clock,
      logger,
    }: Pick<
      Cradle,
      | 'refreshTokenRetentionTask'
      | 'outboxRetentionTask'
      | 'passwordResetTokenRetentionTask'
      | 'dataRetentionWindowMs'
      | 'clock'
      | 'logger'
    >) =>
      new EnforceDataRetentionJob({
        retentionTasks: [
          refreshTokenRetentionTask,
          outboxRetentionTask,
          passwordResetTokenRetentionTask,
        ],
        dataRetentionWindowMs,
        clock,
        logger,
      }),
  ).singleton(),
} satisfies RegistrationMap;
