import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_JOB, type ExampleJobPayload } from '@/application/jobs/example-job';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { JobWorker } from '@/infrastructure/jobs/job-worker';

const QUEUE_PREFIX = 'test';
const noopLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('BullMQ job round-trip', () => {
  let container: StartedRedisContainer;
  let url: string;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start();
    url = container.getConnectionUrl();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('routes an enqueued job to its registered handler', async () => {
    const queueConnection = new Redis(url, { maxRetriesPerRequest: null });
    const workerConnection = new Redis(url, { maxRetriesPerRequest: null });

    let resolveReceived: (payload: ExampleJobPayload) => void;
    const received = new Promise<ExampleJobPayload>((resolve) => {
      resolveReceived = resolve;
    });
    const handler: JobHandler<ExampleJobPayload> = {
      jobName: EXAMPLE_JOB,
      handle: (payload) => {
        resolveReceived(payload);
        return Promise.resolve();
      },
    };

    const worker = new JobWorker({
      connection: workerConnection,
      queuePrefix: QUEUE_PREFIX,
      concurrency: 1,
      handlers: [handler],
      logger: noopLogger,
    });
    const queue = new BullMqJobQueue({ connection: queueConnection, queuePrefix: QUEUE_PREFIX });

    await queue.enqueue(EXAMPLE_JOB, { message: 'hello' });

    await expect(received).resolves.toEqual({ message: 'hello' });

    await worker.close();
    await queue.close();
  });

  it('logs a failure when a job has no registered handler', async () => {
    const queueConnection = new Redis(url, { maxRetriesPerRequest: null });
    const workerConnection = new Redis(url, { maxRetriesPerRequest: null });

    let resolveFailure: (meta: Record<string, unknown>) => void;
    const failure = new Promise<Record<string, unknown>>((resolve) => {
      resolveFailure = resolve;
    });
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn((_message: string, meta?: Record<string, unknown>) =>
        resolveFailure(meta ?? {}),
      ),
    };

    const worker = new JobWorker({
      connection: workerConnection,
      queuePrefix: QUEUE_PREFIX,
      concurrency: 1,
      handlers: [],
      logger,
    });
    const queue = new BullMqJobQueue({ connection: queueConnection, queuePrefix: QUEUE_PREFIX });

    // attempts: 1 so the job dead-letters on its first failure and the test stays fast.
    await queue.enqueue('unregistered.job', { message: 'x' }, { attempts: 1 });

    await expect(failure).resolves.toMatchObject({ jobName: 'unregistered.job' });

    await worker.close();
    await queue.close();
  });
});
