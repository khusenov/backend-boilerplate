import type { DomainEvent } from './domain-event';

export interface EntityProps {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export abstract class Entity<T extends EntityProps> {
  protected readonly props: T;

  private readonly _domainEvents: DomainEvent[] = [];

  protected constructor(props: T) {
    this.props = props;
  }

  get id(): string {
    return this.props.id;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }

  get isDeleted(): boolean {
    return this.props.deletedAt !== null;
  }

  public pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }

  protected recordEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  public equals(other?: Entity<T>): boolean {
    if (other === null || other === undefined) return false;
    if (this === other) return true;
    if (!(other instanceof Entity)) return false;
    if (this.constructor !== other.constructor) return false;
    return this.id === other.id;
  }

  protected touch(): void {
    this.props.updatedAt = new Date();
  }

  public softDelete(): void {
    if (this.isDeleted) return;
    this.props.deletedAt = new Date();
    this.touch();
  }

  public restore(): void {
    if (!this.isDeleted) return;
    this.props.deletedAt = null;
    this.touch();
  }
}
