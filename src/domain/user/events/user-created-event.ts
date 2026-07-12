import { DomainEvent } from '@/domain/shared/domain-event';

export class UserCreatedEvent extends DomainEvent {
  static readonly EVENT_NAME = 'user.created';

  constructor(
    aggregateId: string,
    readonly email: string,
  ) {
    super(aggregateId, UserCreatedEvent.EVENT_NAME);
  }
}
