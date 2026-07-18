import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';

export interface DomainEventHandlerRegistryDeps {
  handlers: DomainEventHandler[];
}

export class DomainEventHandlerRegistry {
  private readonly handlers: Map<string, DomainEventHandler[]>;

  constructor({ handlers }: DomainEventHandlerRegistryDeps) {
    this.handlers = new Map();
    for (const handler of handlers) {
      const group = this.handlers.get(handler.eventName) ?? [];
      group.push(handler);
      this.handlers.set(handler.eventName, group);
    }
  }

  handlersFor(eventName: string): readonly DomainEventHandler[] {
    return this.handlers.get(eventName) ?? [];
  }
}
