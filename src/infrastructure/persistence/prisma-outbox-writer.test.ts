import { describe, expect, it, vi } from 'vitest';
import { PrismaOutboxWriter } from './prisma-outbox-writer';
import { DomainEventSerializer } from '@/infrastructure/events/domain-event-serializer';
import { domainEventFactories } from '@/infrastructure/events/domain-event-factories';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

function makeWriter() {
  const serializer = new DomainEventSerializer({ factories: domainEventFactories });
  const generate = vi.fn<IdGenerator['generate']>();
  const writer = new PrismaOutboxWriter({
    domainEventSerializer: serializer,
    idGenerator: { generate },
  });

  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const tx = { outboxMessage: { createMany } } as unknown as PrismaTransactionalClient;

  return { writer, serializer, generate, createMany, tx };
}

describe('PrismaOutboxWriter', () => {
  it('creates one row per event with correctly serialized columns, using the tx client', async () => {
    const { writer, serializer, generate, createMany, tx } = makeWriter();
    generate.mockReturnValueOnce('outbox-1').mockReturnValueOnce('outbox-2');

    const first = new UserCreatedEvent('user-1', 'a@example.com', new Date('2026-01-01T00:00:00Z'));
    const second = new UserCreatedEvent(
      'user-2',
      'b@example.com',
      new Date('2026-01-02T00:00:00Z'),
    );

    await writer.write([first, second], tx);

    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          id: 'outbox-1',
          aggregateId: 'user-1',
          eventName: 'user.created',
          payload: serializer.serialize(first),
          occurredAt: first.occurredAt,
        },
        {
          id: 'outbox-2',
          aggregateId: 'user-2',
          eventName: 'user.created',
          payload: serializer.serialize(second),
          occurredAt: second.occurredAt,
        },
      ],
    });
  });

  it('performs no write for an empty event array', async () => {
    const { writer, generate, createMany, tx } = makeWriter();

    await writer.write([], tx);

    expect(createMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
