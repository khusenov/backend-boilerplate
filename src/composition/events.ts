import { asClass, asFunction } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { DomainEventDispatcher } from '@/application/shared/ports/domain-event-dispatcher';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import { UserCreatedLogHandler } from '@/application/user/events/user-created-log-handler';
import { InProcessDomainEventDispatcher } from '@/infrastructure/events/in-process-domain-event-dispatcher';
import { DomainEventHandlerRegistry } from '@/infrastructure/events/domain-event-handler-registry';
import { DomainEventSerializer } from '@/infrastructure/events/domain-event-serializer';
import { domainEventFactories } from '@/infrastructure/events/domain-event-factories';
import {
  DispatchDomainEventJobHandler,
  DISPATCH_DOMAIN_EVENT_JOB,
  type DispatchDomainEventPayload,
} from '@/infrastructure/events/dispatch-domain-event-job-handler';
import { OutboxRelay, OUTBOX_RELAY_JOB } from '@/infrastructure/events/outbox-relay';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    userCreatedLogHandler: DomainEventHandler;
    domainEventDispatcher: DomainEventDispatcher;
    domainEventHandlers: DomainEventHandler[];
    domainEventHandlerRegistry: DomainEventHandlerRegistry;
    domainEventSerializer: DomainEventSerializer;
    dispatchDomainEventJobHandler: JobHandler<
      DispatchDomainEventPayload,
      typeof DISPATCH_DOMAIN_EVENT_JOB
    >;
    outboxRelay: JobHandler<unknown, typeof OUTBOX_RELAY_JOB>;
  }
}

function createDomainEventDispatcher({
  domainEventHandlerRegistry,
  logger,
}: Pick<Cradle, 'domainEventHandlerRegistry' | 'logger'>): DomainEventDispatcher {
  return new InProcessDomainEventDispatcher({ domainEventHandlerRegistry, logger });
}

export const eventsRegistrations = {
  userCreatedLogHandler: asClass(UserCreatedLogHandler).singleton(),
  domainEventDispatcher: asFunction(createDomainEventDispatcher).singleton(),
  domainEventHandlers: asFunction(
    ({ userCreatedLogHandler }: Pick<Cradle, 'userCreatedLogHandler'>) => [userCreatedLogHandler],
  ).singleton(),
  domainEventHandlerRegistry: asFunction(
    ({ domainEventHandlers }: Pick<Cradle, 'domainEventHandlers'>) =>
      new DomainEventHandlerRegistry({ handlers: domainEventHandlers }),
  ).singleton(),
  domainEventSerializer: asFunction(
    () => new DomainEventSerializer({ factories: domainEventFactories }),
  ).singleton(),
  dispatchDomainEventJobHandler: asClass(DispatchDomainEventJobHandler).singleton(),
  outboxRelay: asClass(OutboxRelay).singleton(),
} satisfies RegistrationMap;
