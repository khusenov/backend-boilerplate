import type { PrismaClient } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaUnitOfWork } from './prisma-unit-of-work';
import { DomainEvent } from '@/domain/shared/domain-event';
import type { PrismaOutboxWriter } from './prisma-outbox-writer';

class TestEvent extends DomainEvent {
  constructor(aggregateId: string, occurredAt: Date) {
    super(aggregateId, 'test.event', occurredAt);
  }
}

// The mock $transaction hands `work` a sentinel tx object and returns its result,
// so tests can assert the outbox flush received that exact tx client.
function makePrisma() {
  const tx = { __tx: true };
  const prisma = {
    $transaction: vi.fn().mockImplementation((work: (tx: object) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

function makeOutboxWriter() {
  const write = vi.fn<PrismaOutboxWriter['write']>().mockResolvedValue(undefined);
  return { write, writer: { write } as unknown as PrismaOutboxWriter };
}

describe('PrismaUnitOfWork', () => {
  it('executes work inside a Prisma transaction', async () => {
    const { prisma } = makePrisma();
    const { writer } = makeOutboxWriter();
    const sut = new PrismaUnitOfWork({ prisma, outboxWriter: writer });

    const result = await sut.run((context) => {
      expect(context.userRepository).toBeDefined();
      expect(context.roleRepository).toBeDefined();
      expect(context.permissionRepository).toBeDefined();
      expect(context.userRoleRepository).toBeDefined();
      expect(context.outbox).toBeDefined();
      return Promise.resolve('ok' as const);
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(result).toBe('ok');
  });

  it('flushes staged domain events to the outbox writer with the tx client', async () => {
    const { prisma, tx } = makePrisma();
    const { write, writer } = makeOutboxWriter();
    const sut = new PrismaUnitOfWork({ prisma, outboxWriter: writer });
    const event = new TestEvent('agg-1', new Date('2026-01-01T00:00:00.000Z'));

    await sut.run(({ outbox }) => {
      outbox.stage([event]);
      return Promise.resolve();
    });

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith([event], tx);
  });

  it('flushes an empty array when nothing was staged', async () => {
    const { prisma, tx } = makePrisma();
    const { write, writer } = makeOutboxWriter();
    const sut = new PrismaUnitOfWork({ prisma, outboxWriter: writer });

    await sut.run(() => Promise.resolve());

    expect(write).toHaveBeenCalledWith([], tx);
  });

  it('propagates errors so Prisma rolls back the transaction and never flushes', async () => {
    const { prisma } = makePrisma();
    const { write, writer } = makeOutboxWriter();
    const sut = new PrismaUnitOfWork({ prisma, outboxWriter: writer });

    await expect(sut.run(() => Promise.reject(new Error('rollback-trigger')))).rejects.toThrow(
      'rollback-trigger',
    );

    expect(write).not.toHaveBeenCalled();
  });
});
