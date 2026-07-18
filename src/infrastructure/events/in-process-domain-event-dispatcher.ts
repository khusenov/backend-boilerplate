import type { DomainEventDispatcher } from '@/application/shared/ports/domain-event-dispatcher';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { DomainEventHandlerRegistry } from './domain-event-handler-registry';

export interface InProcessDomainEventDispatcherDeps {
  domainEventHandlerRegistry: DomainEventHandlerRegistry;
  logger: Logger;
}

export class InProcessDomainEventDispatcher implements DomainEventDispatcher {
  private readonly registry: DomainEventHandlerRegistry;
  private readonly logger: Logger;

  constructor({ domainEventHandlerRegistry, logger }: InProcessDomainEventDispatcherDeps) {
    this.registry = domainEventHandlerRegistry;
    this.logger = logger;
  }

  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.registry.handlersFor(event.eventName)) {
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
