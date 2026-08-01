import { describe, expect, it, vi } from 'vitest';
import { OutboxRelay } from './outbox-relay';
import { DISPATCH_DOMAIN_EVENT_JOB } from './dispatch-domain-event-job-handler';
import type { PrismaClient } from '@/generated/prisma/client';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Logger } from '@/application/shared/ports/logger';
import type { Clock } from '@/application/shared/ports/clock';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function row(id: string) {
  return {
    id,
    aggregateId: `agg-${id}`,
    eventName: 'user.created',
    payload: `payload-${id}`,
    occurredAt: new Date(`2026-01-0${id}T00:00:00Z`),
    publishedAt: null,
  };
}

function makeRelay(
  pending: ReturnType<typeof row>[],
  enqueue = vi.fn().mockResolvedValue(undefined),
) {
  const findMany = vi.fn().mockResolvedValue(pending);
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const prisma = { outboxMessage: { findMany, updateMany } } as unknown as PrismaClient;
  const jobQueue = { enqueue } as unknown as JobQueue;
  const error = vi.fn<Logger['error']>();
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() };

  const clock = { now: () => NOW } satisfies Clock;

  const relay = new OutboxRelay({ prisma, jobQueue, clock, logger });
  return { relay, findMany, updateMany, enqueue, error };
}

// The single arg the relay passes to updateMany when marking rows published.
function markPublishedArg(updateMany: ReturnType<typeof vi.fn>) {
  return updateMany.mock.calls[0]![0] as {
    where: { id: { in: string[] } };
    data: { publishedAt: unknown };
  };
}

function deduplicationKeys(enqueue: ReturnType<typeof vi.fn>): string[] {
  return enqueue.mock.calls.map(
    (call) => (call[2] as { deduplicationKey: string }).deduplicationKey,
  );
}

describe('OutboxRelay', () => {
  it('exposes the relay job name', () => {
    const { relay } = makeRelay([]);
    expect(relay.jobName).toBe('outbox.relay');
  });

  it('enqueues a dispatch job per pending row and marks exactly those ids published', async () => {
    const { relay, updateMany, enqueue } = makeRelay([row('1'), row('2'), row('3')]);

    await relay.handle();

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledWith(
      DISPATCH_DOMAIN_EVENT_JOB,
      { eventName: 'user.created', payload: 'payload-1' },
      { deduplicationKey: '1' },
    );
    expect(updateMany).toHaveBeenCalledOnce();
    const marked = markPublishedArg(updateMany);
    expect(marked.where).toEqual({ id: { in: ['1', '2', '3'] } });
    expect(marked.data.publishedAt).toEqual(NOW);
  });

  it('never marks anything published when every enqueue fails, and logs each error', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('redis down'));
    const { relay, updateMany, error } = makeRelay([row('1'), row('2')], enqueue);

    await relay.handle();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(updateMany).not.toHaveBeenCalled(); // nothing is lost — all rows stay unpublished
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('marks only the successfully-enqueued rows when one enqueue fails', async () => {
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce(undefined) // row 1 ok
      .mockRejectedValueOnce(new Error('boom')) // row 2 fails
      .mockResolvedValueOnce(undefined); // row 3 ok
    const { relay, updateMany, error } = makeRelay([row('1'), row('2'), row('3')], enqueue);

    await relay.handle();

    expect(updateMany).toHaveBeenCalledOnce();
    const marked = markPublishedArg(updateMany);
    expect(marked.where).toEqual({ id: { in: ['1', '3'] } }); // row 2 stays unpublished
    expect(marked.data.publishedAt).toEqual(NOW);
    expect(error).toHaveBeenCalledOnce();
  });

  it('keys each dispatch job on its outbox row id so a replayed batch is delivered once', async () => {
    const { relay, enqueue } = makeRelay([row('1'), row('2'), row('3')]);

    await relay.handle();

    expect(deduplicationKeys(enqueue)).toEqual(['1', '2', '3']);
  });

  it('does nothing when there are no pending rows', async () => {
    const { relay, updateMany, enqueue } = makeRelay([]);

    await relay.handle();

    expect(enqueue).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
