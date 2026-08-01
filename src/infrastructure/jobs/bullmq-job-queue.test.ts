import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

const { add, close } = vi.hoisted(() => ({
  add: vi.fn<(name: string, data: unknown, options: Record<string, unknown>) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

// An arrow function cannot be called with `new`, and Vitest 4 does not paper over that.
vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return { add, close };
  }),
}));

import { BullMqJobQueue } from './bullmq-job-queue';

const quit = vi.fn<() => Promise<'OK'>>();
const connection = { quit } as unknown as Redis;

function makeQueue() {
  return new BullMqJobQueue({ connection, queuePrefix: 'test' });
}

function addOptions() {
  return add.mock.calls[0]![2];
}

describe('BullMqJobQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    add.mockResolvedValue(undefined);
    close.mockResolvedValue(undefined);
    quit.mockResolvedValue('OK');
  });

  it('applies bounded retries with exponential backoff by default', async () => {
    await makeQueue().enqueue('example.job', { value: 1 });

    expect(addOptions()).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  });

  it('retains completed jobs, which is what keeps a replayed deduplication key recognisable', async () => {
    await makeQueue().enqueue('example.job', { value: 1 });

    expect(addOptions()).toMatchObject({
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    });
  });

  it('omits jobId entirely when no deduplication key is supplied', async () => {
    await makeQueue().enqueue('example.job', { value: 1 });

    expect(addOptions()).not.toHaveProperty('jobId');
  });

  it('namespaces the deduplication key under the job name to build the job id', async () => {
    await makeQueue().enqueue('example.job', { value: 1 }, { deduplicationKey: 'row-42' });

    expect(addOptions()).toMatchObject({ jobId: 'example.job.row-42' });
  });

  it('scopes the deduplication key to the job name, so the same key under two names is two jobs', async () => {
    const queue = makeQueue();

    await queue.enqueue('first.job', { value: 1 }, { deduplicationKey: 'row-42' });
    await queue.enqueue('second.job', { value: 1 }, { deduplicationKey: 'row-42' });

    const ids = add.mock.calls.map((call) => call[2].jobId);
    expect(ids).toEqual(['first.job.row-42', 'second.job.row-42']);
  });

  it('builds a job id that satisfies BullMQ custom-id rules', async () => {
    await makeQueue().enqueue('example.job', { value: 1 }, { deduplicationKey: 'row-42' });

    const { jobId } = addOptions() as { jobId: string };
    // BullMQ rejects an id that round-trips through parseInt unchanged. It permits a colon only
    // in a three-segment id; never producing one at all is our own, stricter constraint.
    expect(`${Number.parseInt(jobId, 10)}`).not.toBe(jobId);
    expect(jobId).not.toContain(':');
  });

  it('forwards an explicit attempt count and delay', async () => {
    await makeQueue().enqueue('example.job', { value: 1 }, { attempts: 7, delayMs: 250 });

    expect(addOptions()).toMatchObject({ attempts: 7, delay: 250 });
  });

  it('closes the queue and the redis connection', async () => {
    await makeQueue().close();

    expect(close).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
