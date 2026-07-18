import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { SerializedDomainEvent } from './serialized-domain-event';

export type DomainEventFactory = (data: SerializedDomainEvent) => DomainEvent;

export const domainEventFactories: Readonly<Record<string, DomainEventFactory>> = {
  [UserCreatedEvent.EVENT_NAME]: (data) =>
    new UserCreatedEvent(data.aggregateId, data.email as string, new Date(data.occurredAt)),
};
