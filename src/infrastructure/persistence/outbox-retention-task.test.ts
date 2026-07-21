import { describe, expect, it, vi } from 'vitest';
import { OutboxRetentionTask } from './outbox-retention-task';
import type { PrismaClient } from '@/generated/prisma/client';

function makeTask(deleteMany = vi.fn().mockResolvedValue({ count: 0 })) {
  const prisma = { outboxMessage: { deleteMany } } as unknown as PrismaClient;
  const task = new OutboxRetentionTask({ prisma });
  return { task, deleteMany };
}

describe('OutboxRetentionTask', () => {
  it('names the resource it prunes', () => {
    const { task } = makeTask();
    expect(task.resource).toBe('outbox_messages');
  });

  it('deletes delivered messages older than the cutoff and returns the deleted count', async () => {
    const cutoff = new Date('2026-07-21T00:00:00.000Z');
    const { task, deleteMany } = makeTask(vi.fn().mockResolvedValue({ count: 9 }));

    const deleted = await task.prune(cutoff);

    expect(deleteMany).toHaveBeenCalledWith({ where: { publishedAt: { lt: cutoff } } });
    expect(deleted).toBe(9);
  });
});
