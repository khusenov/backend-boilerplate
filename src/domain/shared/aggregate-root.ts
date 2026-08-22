import { Entity, type EntityProps } from './entity';
import type { DomainEvent } from './domain-event';

export const UNSAVED_VERSION = 0;

export interface AggregateRootProps extends EntityProps {
  readonly version: number;
}

export abstract class AggregateRoot<T extends AggregateRootProps> extends Entity<T> {
  private readonly _domainEvents: DomainEvent[] = [];

  get version(): number {
    return this.props.version;
  }

  public pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }

  protected recordEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }
}
