export abstract class DomainEvent {
  protected constructor(
    readonly aggregateId: string,
    readonly eventName: string,
    readonly occurredAt: Date,
  ) {}
}
