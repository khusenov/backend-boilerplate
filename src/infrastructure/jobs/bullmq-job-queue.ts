import type { Redis } from 'ioredis';
import type { JobOptions, JobQueue } from '@/application/shared/ports/job-queue';
import { Queue } from 'bullmq';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';
import { injectTraceContext } from '@/infrastructure/jobs/job-trace-context';

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 1000;
const ONE_HOUR_SECONDS = 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const KEEP_COMPLETED_COUNT = 1000;
const KEEP_FAILED_COUNT = 5000;

const KEEP_COMPLETED = { age: ONE_HOUR_SECONDS, count: KEEP_COMPLETED_COUNT };
const KEEP_FAILED = { age: SEVEN_DAYS_SECONDS, count: KEEP_FAILED_COUNT };

export interface BullMqJobQueueDeps {
  connection: Redis;
  queuePrefix: string;
}

export class BullMqJobQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor({ connection, queuePrefix }: BullMqJobQueueDeps) {
    this.connection = connection;
    this.queue = new Queue(DEFAULT_QUEUE_NAME, { connection, prefix: queuePrefix });
  }

  async enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void> {
    await this.queue.add(jobName, injectTraceContext(payload), {
      attempts: options?.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
      // BullMQ treats an add as a no-op while a job with the same id is still retained,
      // so KEEP_COMPLETED is what bounds the deduplication window for at-least-once producers.
      removeOnComplete: KEEP_COMPLETED,
      removeOnFail: KEEP_FAILED,
      ...(options?.delayMs !== undefined && { delay: options.delayMs }),
      ...(options?.deduplicationKey !== undefined && {
        jobId: toJobId(jobName, options.deduplicationKey),
      }),
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

// Job ids are unique per queue, not per job name, and every producer shares DEFAULT_QUEUE_NAME —
// hence the job-name prefix. A dot joins them because BullMQ rejects custom ids containing ':';
// job names already contain dots, so the pairing is unambiguous only while keys stay opaque ids.
function toJobId(jobName: string, deduplicationKey: string): string {
  return `${jobName}.${deduplicationKey}`;
}
