import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';

const { on, close, WorkerMock } = vi.hoisted(() => {
  const on = vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>();
  const close = vi.fn<() => Promise<void>>();
  return {
    on,
    close,
    WorkerMock: vi.fn<
      (name: string, processor: (job: unknown) => Promise<void>, options: unknown) => unknown
    >(function Worker() {
      return { on, close };
    }),
  };
});

vi.mock('bullmq', () => ({ Worker: WorkerMock }));

import { JobWorker } from './job-worker';

const RETRYING = { attemptsMade: 1, finishedOn: undefined };
const DEAD = { attemptsMade: 3, finishedOn: 1_780_000_000_000 };

function makeJob(overrides: Record<string, unknown> = {}): Job {
  return {
    name: 'example.job',
    id: 'example.job.row-1',
    data: { value: 1 },
    ...RETRYING,
    ...overrides,
  } as unknown as Job;
}

function makeWorker(handlers: JobHandler[] = []) {
  const warn = vi.fn<Logger['warn']>();
  const error = vi.fn<Logger['error']>();
  const logger: Logger = { info: vi.fn(), warn, error, debug: vi.fn() };
  const quit = vi.fn<() => Promise<'OK'>>().mockResolvedValue('OK');
  const connection = { quit } as unknown as Redis;

  const worker = new JobWorker({
    connection,
    queuePrefix: 'test',
    concurrency: 1,
    handlers,
    logger,
  });

  return { worker, warn, error, quit };
}

function processor() {
  return WorkerMock.mock.calls[0]![1];
}

function listenerFor(event: string) {
  return on.mock.calls.find(([registered]) => registered === event)![1];
}

describe('JobWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    close.mockResolvedValue(undefined);
  });

  it('routes a job to the handler registered under its name', async () => {
    const handle = vi.fn<JobHandler['handle']>().mockResolvedValue(undefined);
    makeWorker([{ jobName: 'example.job', handle }]);

    await processor()(makeJob());

    expect(handle).toHaveBeenCalledWith({ value: 1 });
  });

  it('fails the job when no handler is registered for its name', async () => {
    makeWorker([]);

    await expect(processor()(makeJob())).rejects.toThrow(
      'No handler registered for job "example.job"',
    );
  });

  it('warns while BullMQ still intends to retry', () => {
    const { warn, error } = makeWorker([]);

    listenerFor('failed')(makeJob(RETRYING), new Error('transient'));

    expect(warn).toHaveBeenCalledWith('Job attempt failed, retry pending', {
      jobName: 'example.job',
      jobId: 'example.job.row-1',
      error: 'transient',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('reports a dead letter once BullMQ has declined to retry', () => {
    const { warn, error } = makeWorker([]);

    listenerFor('failed')(makeJob(DEAD), new Error('poison'));

    expect(error).toHaveBeenCalledWith('Job dead-lettered, no retry remains', {
      jobName: 'example.job',
      jobId: 'example.job.row-1',
      error: 'poison',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a dead letter when attempts remain but the error was unrecoverable', () => {
    const { error } = makeWorker([]);

    listenerFor('failed')(
      makeJob({ attemptsMade: 1, finishedOn: 1_780_000_000_000 }),
      new Error('unrecoverable'),
    );

    expect(error).toHaveBeenCalledOnce();
  });

  it('treats a retried job whose finishedOn was cleared as still retrying', () => {
    const { warn, error } = makeWorker([]);

    listenerFor('failed')(makeJob({ attemptsMade: 1, finishedOn: null }), new Error('transient'));

    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('reports a dead letter for a job the listener received without one', () => {
    const { error } = makeWorker([]);

    listenerFor('failed')(undefined, new Error('job vanished'));

    expect(error).toHaveBeenCalledWith('Job dead-lettered, no retry remains', {
      jobName: 'unidentified',
      jobId: undefined,
      error: 'job vanished',
    });
  });

  it('warns on a stall, which BullMQ reports on its own channel and not as a failure', () => {
    const { warn } = makeWorker([]);

    listenerFor('stalled')('example.job.row-1');

    expect(warn).toHaveBeenCalledWith('Job stalled, its processing lock expired', {
      jobId: 'example.job.row-1',
    });
  });

  it('closes the worker and the redis connection', async () => {
    const { worker, quit } = makeWorker([]);

    await worker.close();

    expect(close).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
