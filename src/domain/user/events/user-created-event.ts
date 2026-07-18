import { DomainEvent } from '@/domain/shared/domain-event';

export class UserCreatedEvent extends DomainEvent {
  static readonly EVENT_NAME = 'user.created';

  constructor(
    aggregateId: string,
    readonly email: string,
    occurredAt?: Date,
  ) {
    super(aggregateId, UserCreatedEvent.EVENT_NAME, occurredAt);
  }
}
