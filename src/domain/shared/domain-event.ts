export abstract class DomainEvent {
  readonly occurredAt: Date;

  protected constructor(
    readonly aggregateId: string,
    readonly eventName: string,
  ) {
    this.occurredAt = new Date();
  }
}
