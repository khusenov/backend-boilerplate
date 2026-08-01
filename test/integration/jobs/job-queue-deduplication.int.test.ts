import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { JobWorker } from '@/infrastructure/jobs/job-worker';
import { DEFAULT_QUEUE_NAME } from '@/infrastructure/jobs/queue-name';

const JOB_NAME = 'example.job';
const FIRST_ROW_ID = '9f1c0d3e-0000-4000-8000-000000000001';
const SECOND_ROW_ID = '9f1c0d3e-0000-4000-8000-000000000002';
const noopLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('BullMqJobQueue deduplication', () => {
  let container: StartedRedisContainer;
  let url: string;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start();
    url = container.getConnectionUrl();
  });

  afterAll(async () => {
    await container?.stop();
  });

  function connect() {
    return new Redis(url, { maxRetriesPerRequest: null });
  }

  it('collapses a replay onto a job still waiting to be picked up', async () => {
    const queuePrefix = 'test-deduplication-waiting';
    const queue = new BullMqJobQueue({ connection: connect(), queuePrefix });
    const inspectorConnection = connect();
    const inspector = new Queue(DEFAULT_QUEUE_NAME, {
      connection: inspectorConnection,
      prefix: queuePrefix,
    });

    try {
      await queue.enqueue(JOB_NAME, { message: 'first' }, { deduplicationKey: FIRST_ROW_ID });
      await queue.enqueue(JOB_NAME, { message: 'replay' }, { deduplicationKey: FIRST_ROW_ID });
      await queue.enqueue(JOB_NAME, { message: 'other' }, { deduplicationKey: SECOND_ROW_ID });

      expect(await inspector.getWaitingCount()).toBe(2);
      const retained = await inspector.getJob(`${JOB_NAME}.${FIRST_ROW_ID}`);
      expect(retained?.data).toMatchObject({ message: 'first' });
    } finally {
      await inspector.close();
      await inspectorConnection.quit();
      await queue.close();
    }
  });

  it('collapses a replay onto a job that has already completed and been retained', async () => {
    const queuePrefix = 'test-deduplication-completed';
    const queue = new BullMqJobQueue({ connection: connect(), queuePrefix });
    const inspectorConnection = connect();
    const inspector = new Queue(DEFAULT_QUEUE_NAME, {
      connection: inspectorConnection,
      prefix: queuePrefix,
    });
    const handler: JobHandler = { jobName: JOB_NAME, handle: () => Promise.resolve() };
    const worker = new JobWorker({
      connection: connect(),
      queuePrefix,
      concurrency: 1,
      handlers: [handler],
      logger: noopLogger,
    });
    let workerClosed = false;

    try {
      await queue.enqueue(JOB_NAME, { message: 'first' }, { deduplicationKey: FIRST_ROW_ID });
      await vi.waitFor(
        async () => {
          expect(await inspector.getCompletedCount()).toBe(1);
        },
        { timeout: 10_000, interval: 50 },
      );

      // Stop consuming before replaying: with a live worker a wrongly-enqueued duplicate could be
      // drained before the assertion reads the wait list, so the test would pass by coincidence.
      workerClosed = true;
      await worker.close();

      await queue.enqueue(JOB_NAME, { message: 'replay' }, { deduplicationKey: FIRST_ROW_ID });

      expect(await inspector.getWaitingCount()).toBe(0);
      expect(await inspector.getCompletedCount()).toBe(1);
    } finally {
      if (!workerClosed) {
        await worker.close();
      }
      await inspector.close();
      await inspectorConnection.quit();
      await queue.close();
    }
  });
});
