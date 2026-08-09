import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { DomainEventHandlerRegistry } from './domain-event-handler-registry';
import type { DomainEventSerializer } from './domain-event-serializer';

export const DISPATCH_DOMAIN_EVENT_JOB = 'domain-event.dispatch';

export interface DispatchDomainEventPayload {
  readonly eventName: string;
  readonly payload: string;
}

export interface DispatchDomainEventJobHandlerDeps {
  domainEventSerializer: DomainEventSerializer;
  domainEventHandlerRegistry: DomainEventHandlerRegistry;
}

export class DispatchDomainEventJobHandler implements JobHandler<
  DispatchDomainEventPayload,
  typeof DISPATCH_DOMAIN_EVENT_JOB
> {
  readonly jobName = DISPATCH_DOMAIN_EVENT_JOB;
  private readonly serializer: DomainEventSerializer;
  private readonly registry: DomainEventHandlerRegistry;

  constructor({
    domainEventSerializer,
    domainEventHandlerRegistry,
  }: DispatchDomainEventJobHandlerDeps) {
    this.serializer = domainEventSerializer;
    this.registry = domainEventHandlerRegistry;
  }

  async handle(payload: DispatchDomainEventPayload): Promise<void> {
    const event = this.serializer.deserialize(payload.eventName, payload.payload);
    for (const handler of this.registry.handlersFor(event.eventName)) {
      await handler.handle(event);
    }
  }
}
