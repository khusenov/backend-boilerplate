import { describe, expect, it, vi } from 'vitest';
import { InProcessDomainEventDispatcher } from './in-process-domain-event-dispatcher';
import { DomainEvent } from '@/domain/shared/domain-event';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';

class TestEvent extends DomainEvent {
  constructor(aggregateId: string, eventName: string) {
    super(aggregateId, eventName);
  }
}

function makeLogger() {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    debug: vi.fn<Logger['debug']>(),
  } satisfies Logger;
}

function makeHandler(eventName: string) {
  return {
    eventName,
    handle: vi.fn<DomainEventHandler['handle']>().mockResolvedValue(undefined),
  } satisfies DomainEventHandler;
}

describe('InProcessDomainEventDispatcher', () => {
  it('routes an event to the handler whose eventName matches', async () => {
    const handler = makeHandler('user.created');
    const dispatcher = new InProcessDomainEventDispatcher({
      handlers: [handler],
      logger: makeLogger(),
    });
    const event = new TestEvent('agg-1', 'user.created');

    await dispatcher.dispatch([event]);

    expect(handler.handle).toHaveBeenCalledOnce();
    expect(handler.handle).toHaveBeenCalledWith(event);
  });

  it('does not invoke a handler registered for a different event name', async () => {
    const handler = makeHandler('user.deleted');
    const dispatcher = new InProcessDomainEventDispatcher({
      handlers: [handler],
      logger: makeLogger(),
    });

    await dispatcher.dispatch([new TestEvent('agg-1', 'user.created')]);

    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('invokes every handler for the same event, in registration order', async () => {
    const calls: string[] = [];
    const first = {
      eventName: 'user.created',
      handle: vi.fn<DomainEventHandler['handle']>(() => {
        calls.push('first');
        return Promise.resolve();
      }),
    } satisfies DomainEventHandler;
    const second = {
      eventName: 'user.created',
      handle: vi.fn<DomainEventHandler['handle']>(() => {
        calls.push('second');
        return Promise.resolve();
      }),
    } satisfies DomainEventHandler;
    const dispatcher = new InProcessDomainEventDispatcher({
      handlers: [first, second],
      logger: makeLogger(),
    });

    await dispatcher.dispatch([new TestEvent('agg-1', 'user.created')]);

    expect(calls).toEqual(['first', 'second']);
  });

  it('catches and logs a failing handler without rejecting, and runs the rest', async () => {
    const logger = makeLogger();
    const failing = {
      eventName: 'user.created',
      handle: vi.fn<DomainEventHandler['handle']>().mockRejectedValue(new Error('boom')),
    } satisfies DomainEventHandler;
    const healthy = makeHandler('user.created');
    const dispatcher = new InProcessDomainEventDispatcher({
      handlers: [failing, healthy],
      logger,
    });

    await expect(
      dispatcher.dispatch([new TestEvent('agg-1', 'user.created')]),
    ).resolves.toBeUndefined();

    expect(healthy.handle).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('isolates failures across events: a failing A still lets B dispatch', async () => {
    const logger = makeLogger();
    const failingA = {
      eventName: 'a',
      handle: vi.fn<DomainEventHandler['handle']>().mockRejectedValue(new Error('boom')),
    } satisfies DomainEventHandler;
    const handlerB = makeHandler('b');
    const dispatcher = new InProcessDomainEventDispatcher({
      handlers: [failingA, handlerB],
      logger,
    });

    await dispatcher.dispatch([new TestEvent('agg-1', 'a'), new TestEvent('agg-2', 'b')]);

    expect(handlerB.handle).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('is a no-op for an event with no registered handler', async () => {
    const logger = makeLogger();
    const dispatcher = new InProcessDomainEventDispatcher({ handlers: [], logger });

    await expect(
      dispatcher.dispatch([new TestEvent('agg-1', 'user.created')]),
    ).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
