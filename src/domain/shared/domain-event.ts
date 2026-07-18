export abstract class DomainEvent {
  readonly occurredAt: Date;

  protected constructor(
    readonly aggregateId: string,
    readonly eventName: string,
    occurredAt?: Date,
  ) {
    this.occurredAt = occurredAt ?? new Date();
  }
}
