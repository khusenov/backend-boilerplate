import { Queue } from 'bullmq';
import { DEFAULT_QUEUE_NAME } from './queue-name';
import type { Redis } from 'ioredis';
import type { JobScheduler, ScheduleOptions } from '@/application/shared/ports/job-scheduler';

export interface BullMqJobSchedulerDeps {
  connection: Redis;
  queuePrefix: string;
}

export class BullMqJobScheduler implements JobScheduler {
  private readonly queue: Queue;

  constructor({ connection, queuePrefix }: BullMqJobSchedulerDeps) {
    this.queue = new Queue(DEFAULT_QUEUE_NAME, { connection, prefix: queuePrefix });
  }

  async schedule<TPayload>(
    jobName: string,
    payload: TPayload,
    options: ScheduleOptions,
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      jobName,
      { every: options.everyMs },
      { name: jobName, data: payload },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
