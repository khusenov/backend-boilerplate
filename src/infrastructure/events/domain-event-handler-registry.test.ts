import { describe, expect, it, vi } from 'vitest';
import { DomainEventHandlerRegistry } from './domain-event-handler-registry';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';

function handler(eventName: string): DomainEventHandler {
  return { eventName, handle: vi.fn<DomainEventHandler['handle']>().mockResolvedValue(undefined) };
}

describe('DomainEventHandlerRegistry', () => {
  it('groups multiple handlers registered for the same event name', () => {
    const a = handler('user.created');
    const b = handler('user.created');
    const registry = new DomainEventHandlerRegistry({ handlers: [a, b] });

    expect(registry.handlersFor('user.created')).toEqual([a, b]);
  });

  it('keys handlers by their own event name', () => {
    const created = handler('user.created');
    const deleted = handler('user.deleted');
    const registry = new DomainEventHandlerRegistry({ handlers: [created, deleted] });

    expect(registry.handlersFor('user.created')).toEqual([created]);
    expect(registry.handlersFor('user.deleted')).toEqual([deleted]);
  });

  it('returns an empty list for an unregistered event name', () => {
    const registry = new DomainEventHandlerRegistry({ handlers: [] });

    expect(registry.handlersFor('nope')).toEqual([]);
  });
});
