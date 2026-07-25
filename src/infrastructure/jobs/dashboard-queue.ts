import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';

interface DashboardQueueDependencies {
  redisConnection: Redis;
  queuePrefix: string;
}

export function createDashboardQueue({
  redisConnection,
  queuePrefix,
}: DashboardQueueDependencies): Queue {
  return new Queue(DEFAULT_QUEUE_NAME, {
    connection: redisConnection,
    prefix: queuePrefix,
  });
}
