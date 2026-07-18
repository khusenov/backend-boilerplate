import type { DomainEvent } from '@/domain/shared/domain-event';
import type { DomainEventFactory } from './domain-event-factories';
import type { SerializedDomainEvent } from './serialized-domain-event';

export class UnknownDomainEventError extends Error {
  constructor(eventName: string) {
    super(`No factory registered for domain event "${eventName}"`);
    this.name = 'UnknownDomainEventError';
  }
}

export interface DomainEventSerializerDeps {
  factories: Readonly<Record<string, DomainEventFactory>>;
}

export class DomainEventSerializer {
  private readonly factories: Readonly<Record<string, DomainEventFactory>>;

  constructor({ factories }: DomainEventSerializerDeps) {
    this.factories = factories;
  }

  serialize(event: DomainEvent): string {
    return JSON.stringify(event);
  }

  deserialize(eventName: string, payload: string): DomainEvent {
    const factory = this.factories[eventName];
    if (!factory) {
      throw new UnknownDomainEventError(eventName);
    }
    const data = JSON.parse(payload) as SerializedDomainEvent;
    return factory(data);
  }
}
