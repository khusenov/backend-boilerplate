import { asClass, asFunction, asValue } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { env } from '@/config/env';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { JobScheduler } from '@/application/shared/ports/job-scheduler';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import { ExampleJobHandler } from '@/application/jobs/example-job-handler';
import { EXAMPLE_JOB, type ExampleJobPayload } from '@/application/jobs/example-job';
import { SendVerificationEmailHandler } from '@/application/jobs/send-verification-email-handler';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';
import { SendPasswordResetEmailHandler } from '@/application/jobs/send-password-reset-email-handler';
import {
  SEND_PASSWORD_RESET_EMAIL_JOB,
  type SendPasswordResetEmailPayload,
} from '@/application/jobs/send-password-reset-email-job';
import { RevokeUserSessionsHandler } from '@/application/jobs/revoke-user-sessions-handler';
import {
  REVOKE_USER_SESSIONS_JOB,
  type RevokeUserSessionsPayload,
} from '@/application/jobs/revoke-user-sessions-job';
import { DATA_RETENTION_JOB } from '@/application/retention/enforce-data-retention-job';
import { OUTBOX_RELAY_JOB } from '@/infrastructure/events/outbox-relay';
import { DISPATCH_DOMAIN_EVENT_JOB } from '@/infrastructure/events/dispatch-domain-event-job-handler';
import { createRedisConnection } from '@/infrastructure/jobs/redis-connection';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { BullMqJobScheduler } from '@/infrastructure/jobs/bullmq-job-scheduler';
import { JobWorker } from '@/infrastructure/jobs/job-worker';
import { createDashboardQueue } from '@/infrastructure/jobs/dashboard-queue';
import { toJobHandlerList } from '@/job-catalogue';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    queuePrefix: string;
    queueConcurrency: number;
    redisConnection: Redis;
    workerConnection: Redis;
    jobQueue: JobQueue;
    jobWorker: JobWorker;
    jobScheduler: JobScheduler;
    dashboardQueue: Queue;
    exampleJobHandler: JobHandler<ExampleJobPayload, typeof EXAMPLE_JOB>;
    sendVerificationEmailHandler: JobHandler<
      SendVerificationEmailPayload,
      typeof SEND_VERIFICATION_EMAIL_JOB
    >;
    sendPasswordResetEmailHandler: JobHandler<
      SendPasswordResetEmailPayload,
      typeof SEND_PASSWORD_RESET_EMAIL_JOB
    >;
    revokeUserSessionsHandler: JobHandler<
      RevokeUserSessionsPayload,
      typeof REVOKE_USER_SESSIONS_JOB
    >;
  }
}

export const jobsRegistrations = {
  queuePrefix: asValue(env.QUEUE_PREFIX),
  queueConcurrency: asValue(env.QUEUE_CONCURRENCY),
  redisConnection: asFunction(() => createRedisConnection({ redisUrl: env.REDIS_URL })).singleton(),
  workerConnection: asFunction(() =>
    createRedisConnection({ redisUrl: env.REDIS_URL }),
  ).singleton(),
  exampleJobHandler: asClass(ExampleJobHandler).singleton(),
  sendVerificationEmailHandler: asClass(SendVerificationEmailHandler).singleton(),
  sendPasswordResetEmailHandler: asClass(SendPasswordResetEmailHandler).singleton(),
  revokeUserSessionsHandler: asClass(RevokeUserSessionsHandler).singleton(),
  jobQueue: asFunction(
    ({ redisConnection, queuePrefix }: Pick<Cradle, 'redisConnection' | 'queuePrefix'>) =>
      new BullMqJobQueue({
        connection: redisConnection,
        queuePrefix,
      }),
  )
    .singleton()
    .disposer((queue) => queue.close()),
  jobWorker: asFunction(
    ({
      workerConnection,
      exampleJobHandler,
      sendVerificationEmailHandler,
      sendPasswordResetEmailHandler,
      revokeUserSessionsHandler,
      outboxRelay,
      dispatchDomainEventJobHandler,
      enforceDataRetentionJob,
      logger,
      queuePrefix,
      queueConcurrency,
    }: Pick<
      Cradle,
      | 'workerConnection'
      | 'exampleJobHandler'
      | 'sendVerificationEmailHandler'
      | 'sendPasswordResetEmailHandler'
      | 'revokeUserSessionsHandler'
      | 'outboxRelay'
      | 'dispatchDomainEventJobHandler'
      | 'enforceDataRetentionJob'
      | 'logger'
      | 'queuePrefix'
      | 'queueConcurrency'
    >) =>
      new JobWorker({
        connection: workerConnection,
        queuePrefix,
        concurrency: queueConcurrency,
        handlers: toJobHandlerList({
          [EXAMPLE_JOB]: exampleJobHandler,
          [SEND_VERIFICATION_EMAIL_JOB]: sendVerificationEmailHandler,
          [SEND_PASSWORD_RESET_EMAIL_JOB]: sendPasswordResetEmailHandler,
          [REVOKE_USER_SESSIONS_JOB]: revokeUserSessionsHandler,
          [DATA_RETENTION_JOB]: enforceDataRetentionJob,
          [OUTBOX_RELAY_JOB]: outboxRelay,
          [DISPATCH_DOMAIN_EVENT_JOB]: dispatchDomainEventJobHandler,
        }),
        logger,
      }),
  )
    .singleton()
    .disposer((worker) => worker.close()),
  jobScheduler: asFunction(
    ({ redisConnection, queuePrefix }: Pick<Cradle, 'redisConnection' | 'queuePrefix'>) =>
      new BullMqJobScheduler({ connection: redisConnection, queuePrefix }),
  )
    .singleton()
    .disposer((scheduler) => scheduler.close()),
  dashboardQueue: asFunction(createDashboardQueue)
    .singleton()
    .disposer((queue) => queue.close()),
} satisfies RegistrationMap;
