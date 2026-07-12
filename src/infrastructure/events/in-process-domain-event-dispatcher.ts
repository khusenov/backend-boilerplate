import type { DomainEvent } from '@/domain/shared/domain-event';
import type { DomainEventDispatcher } from '@/application/shared/ports/domain-event-dispatcher';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';

interface InProcessDomainEventDispatcherDeps {
  handlers: readonly DomainEventHandler[];
  logger: Logger;
}

export class InProcessDomainEventDispatcher implements DomainEventDispatcher {
  private readonly handlers: Map<string, DomainEventHandler[]>;
  private readonly logger: Logger;

  constructor({ handlers, logger }: InProcessDomainEventDispatcherDeps) {
    this.logger = logger;
    this.handlers = new Map();
    for (const handler of handlers) {
      const group = this.handlers.get(handler.eventName) ?? [];
      group.push(handler);
      this.handlers.set(handler.eventName, group);
    }
  }

  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const handlers = this.handlers.get(event.eventName) ?? [];
      for (const handler of handlers) {
        await this.runHandler(handler, event);
      }
    }
  }

  private async runHandler(handler: DomainEventHandler, event: DomainEvent): Promise<void> {
    try {
      await handler.handle(event);
    } catch (error) {
      this.logger.error('Domain event handler failed', {
        eventName: event.eventName,
        aggregateId: event.aggregateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
