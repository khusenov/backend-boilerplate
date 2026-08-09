import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDb } from './support/harness';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('data retention (outbox)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('deletes delivered messages older than the retention window and keeps the rest', async () => {
    const now = Date.now();
    const old = new Date(now - 40 * DAY_MS);
    const recent = new Date(now - 1 * DAY_MS);

    await h.prisma.outboxMessage.createMany({
      data: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          aggregateId: '11111111-1111-1111-1111-1111111111a1',
          eventName: 'user.created',
          payload: '{}',
          occurredAt: old,
          publishedAt: old,
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          aggregateId: '22222222-2222-2222-2222-2222222222a2',
          eventName: 'user.created',
          payload: '{}',
          occurredAt: recent,
          publishedAt: recent,
        },
        {
          id: '33333333-3333-3333-3333-333333333333',
          aggregateId: '33333333-3333-3333-3333-3333333333a3',
          eventName: 'user.created',
          payload: '{}',
          occurredAt: old,
          publishedAt: null,
        },
      ],
    });

    await h.app.diContainer.resolve('enforceDataRetentionJob').handle(undefined);

    const survivors = await h.prisma.outboxMessage.findMany({ orderBy: { id: 'asc' } });
    expect(survivors.map((message) => message.id)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ]);
  });
});
