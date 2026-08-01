import { Entity, type EntityProps } from './entity';
import type { DomainEvent } from './domain-event';

export abstract class AggregateRoot<T extends EntityProps> extends Entity<T> {
  private readonly _domainEvents: DomainEvent[] = [];

  public pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }

  protected recordEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }
}
