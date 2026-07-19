import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';
import {
  runWithExtractedContext,
  stripTraceContext,
} from '@/infrastructure/jobs/job-trace-context';

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
    this.worker.on('failed', (job, error) => {
      this.logger.error('Job failed', { jobName: job?.name, jobId: job?.id, error: error.message });
    });
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

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }
}
