import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';
import {
  runWithExtractedContext,
  stripTraceContext,
} from '@/infrastructure/jobs/job-trace-context';

const UNIDENTIFIED_JOB_NAME = 'unidentified';

export interface JobWorkerDeps {
  connection: Redis;
  queuePrefix: string;
  concurrency: number;
  handlers: JobHandler[];
  logger: Logger;
}

export class JobWorker {
  private readonly connection: Redis;
  private readonly handlers: Map<string, JobHandler>;
  private readonly logger: Logger;
  private readonly worker: Worker;

  constructor({ connection, queuePrefix, concurrency, handlers, logger }: JobWorkerDeps) {
    this.connection = connection;
    this.logger = logger;
    this.handlers = new Map(handlers.map((handler) => [handler.jobName, handler]));
    this.worker = new Worker(DEFAULT_QUEUE_NAME, (job) => this.process(job), {
      connection,
      prefix: queuePrefix,
      concurrency,
    });
    this.worker.on('failed', (job, error) => this.reportFailure(job, error));
    this.worker.on('stalled', (jobId) => this.reportStalled(jobId));
  }

  private process(job: Job): Promise<void> {
    return runWithExtractedContext(job.data, async () => {
      const handler = this.handlers.get(job.name);
      if (!handler) {
        throw new Error(`No handler registered for job "${job.name}"`);
      }
      await handler.handle(stripTraceContext(job.data));
    });
  }

  private reportFailure(job: Job | undefined, error: Error): void {
    const details = {
      jobName: job?.name ?? UNIDENTIFIED_JOB_NAME,
      jobId: job?.id,
      error: error.message,
    };

    if (job !== undefined && !isDeadLettered(job)) {
      this.logger.warn('Job attempt failed, retry pending', details);
      return;
    }

    this.logger.error('Job dead-lettered, no retry remains', details);
  }

  private reportStalled(jobId: string): void {
    this.logger.warn('Job stalled, its processing lock expired', { jobId });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }
}

// BullMQ sets finishedOn only when it has decided against a retry. That covers exhausted
// attempts, UnrecoverableError, job.discard() and a backoff strategy returning -1 alike,
// where comparing attemptsMade against opts.attempts would catch only the first.
function isDeadLettered(job: Job): boolean {
  return job.finishedOn != null;
}
