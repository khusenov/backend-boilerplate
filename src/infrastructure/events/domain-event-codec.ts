import type { DomainEvent } from '@/domain/shared/domain-event';

export interface DomainEventMetadata {
  readonly aggregateId: string;
  readonly occurredAt: Date;
}

export interface DomainEventCodec<E extends DomainEvent = DomainEvent> {
  readonly eventName: string;
  readonly eventVersion: number;
  encode(event: E): Record<string, unknown>;
  decode(payload: unknown, metadata: DomainEventMetadata): E;
}
