import { describe, expect, it, vi } from 'vitest';
import {
  DispatchDomainEventJobHandler,
  DISPATCH_DOMAIN_EVENT_JOB,
  type DispatchDomainEventPayload,
} from './dispatch-domain-event-job-handler';
import { DomainEventSerializer } from './domain-event-serializer';
import { UnknownDomainEventError } from './domain-event-errors';
import { DomainEventHandlerRegistry } from './domain-event-handler-registry';
import { DomainEventCodecRegistry } from './domain-event-codec-registry';
import { domainEventCodecs } from './domain-event-codecs';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';

const serializer = new DomainEventSerializer({
  domainEventCodecRegistry: new DomainEventCodecRegistry({ codecs: domainEventCodecs }),
});

function makeSut(handlers: DomainEventHandler[]) {
  const registry = new DomainEventHandlerRegistry({ handlers });
  return new DispatchDomainEventJobHandler({
    domainEventSerializer: serializer,
    domainEventHandlerRegistry: registry,
  });
}

const payload: DispatchDomainEventPayload = {
  eventName: UserCreatedEvent.EVENT_NAME,
  payload: serializer.serialize(
    new UserCreatedEvent('user-1', 'jane@example.com', new Date('2026-01-01T00:00:00Z')),
  ),
};

describe('DispatchDomainEventJobHandler', () => {
  it('exposes the dispatch job name', () => {
    expect(makeSut([]).jobName).toBe(DISPATCH_DOMAIN_EVENT_JOB);
  });

  it('deserializes the event and invokes every registered handler', async () => {
    const handleA = vi.fn<DomainEventHandler['handle']>().mockResolvedValue(undefined);
    const handleB = vi.fn<DomainEventHandler['handle']>().mockResolvedValue(undefined);
    const sut = makeSut([
      { eventName: 'user.created', handle: handleA },
      { eventName: 'user.created', handle: handleB },
    ]);

    await sut.handle(payload);

    expect(handleA).toHaveBeenCalledOnce();
    expect(handleB).toHaveBeenCalledOnce();
    const [event] = handleA.mock.calls[0]!;
    expect(event).toBeInstanceOf(UserCreatedEvent);
    expect((event as UserCreatedEvent).email).toBe('jane@example.com');
  });

  it('propagates a handler failure so BullMQ can retry the job', async () => {
    const handle = vi
      .fn<DomainEventHandler['handle']>()
      .mockRejectedValue(new Error('handler failed'));
    const sut = makeSut([{ eventName: 'user.created', handle }]);

    await expect(sut.handle(payload)).rejects.toThrow('handler failed');
  });

  it('propagates UnknownDomainEventError when the event has no codec', async () => {
    const sut = makeSut([]);

    await expect(sut.handle({ eventName: 'unknown.event', payload: '{}' })).rejects.toBeInstanceOf(
      UnknownDomainEventError,
    );
  });

  it('is a no-op when no handler is registered for the event', async () => {
    const sut = makeSut([]);

    await expect(sut.handle(payload)).resolves.toBeUndefined();
  });
});
