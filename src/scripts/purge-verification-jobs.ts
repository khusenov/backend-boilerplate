import { Queue } from 'bullmq';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';
import { env } from '@/config/env';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';
import { createRedisConnection } from '@/infrastructure/jobs/redis-connection';

const FAILED_PAGE_SIZE = 10_000;

async function main(): Promise<void> {
  const connection = createRedisConnection({ redisUrl: env.REDIS_URL });
  const queue = new Queue(DEFAULT_QUEUE_NAME, { connection, prefix: env.QUEUE_PREFIX });

  try {
    // Filtered by job name rather than queue.clean(…, 'failed'): the shared default queue also
    // holds dead-lettered domain-event.dispatch jobs, and OutboxRelay marks its row published on
    // a successful enqueue, so that failed job is the only surviving copy of the event.
    const failed = await queue.getFailed(0, FAILED_PAGE_SIZE);
    const stale = failed.filter((job) => job.name === SEND_VERIFICATION_EMAIL_JOB);
    await Promise.all(stale.map((job) => job.remove()));

    console.info('[purge-verification-jobs] done', {
      jobName: SEND_VERIFICATION_EMAIL_JOB,
      removed: stale.length,
      failedInspected: failed.length,
      queuePrefix: env.QUEUE_PREFIX,
    });
  } finally {
    await queue.close();
    await connection.quit();
  }
}

void main().catch((error: unknown) => {
  console.error('[purge-verification-jobs] failed', error);
  process.exit(1);
});
