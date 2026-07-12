import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

interface UserCreatedLogHandlerDeps {
  logger: Logger;
}

export class UserCreatedLogHandler implements DomainEventHandler<UserCreatedEvent> {
  readonly eventName = UserCreatedEvent.EVENT_NAME;
  private readonly logger: Logger;

  constructor({ logger }: UserCreatedLogHandlerDeps) {
    this.logger = logger;
  }

  handle(event: UserCreatedEvent): Promise<void> {
    this.logger.info('User created', {
      aggregateId: event.aggregateId,
      email: event.email,
      occurredAt: event.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}
