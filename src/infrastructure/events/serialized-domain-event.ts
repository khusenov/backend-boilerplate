export interface SerializedDomainEvent {
  readonly aggregateId: string;
  readonly eventName: string;
  readonly occurredAt: string;

  readonly [key: string]: unknown;
}
