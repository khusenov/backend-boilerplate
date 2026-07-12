import type { DomainEvent } from '@/domain/shared/domain-event';

export interface DomainEventHandler<E extends DomainEvent = DomainEvent> {
  readonly eventName: string;
  handle(event: E): Promise<void>;
}
