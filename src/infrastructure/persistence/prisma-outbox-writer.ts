import type { DomainEventSerializer } from '@/infrastructure/events/domain-event-serializer';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

export interface PrismaOutboxWriterDeps {
  domainEventSerializer: DomainEventSerializer;
  idGenerator: IdGenerator;
}

export class PrismaOutboxWriter {
  private readonly serializer: DomainEventSerializer;
  private readonly ids: IdGenerator;

  constructor({ domainEventSerializer, idGenerator }: PrismaOutboxWriterDeps) {
    this.serializer = domainEventSerializer;
    this.ids = idGenerator;
  }

  async write(events: readonly DomainEvent[], tx: PrismaTransactionalClient): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await tx.outboxMessage.createMany({
      data: events.map((event) => ({
        id: this.ids.generate(),
        aggregateId: event.aggregateId,
        eventName: event.eventName,
        payload: this.serializer.serialize(event),
        occurredAt: event.occurredAt,
      })),
    });
  }
}
