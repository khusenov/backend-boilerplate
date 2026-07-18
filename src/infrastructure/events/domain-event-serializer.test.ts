import { describe, expect, it } from 'vitest';
import { DomainEventSerializer, UnknownDomainEventError } from './domain-event-serializer';
import { domainEventFactories } from './domain-event-factories';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

describe('DomainEventSerializer', () => {
  const serializer = new DomainEventSerializer({ factories: domainEventFactories });

  it('round-trips a UserCreatedEvent preserving its fields and original timestamp', () => {
    const occurredAt = new Date('2026-01-02T03:04:05.678Z');
    const original = new UserCreatedEvent('user-1', 'jane@example.com', occurredAt);

    const payload = serializer.serialize(original);
    const restored = serializer.deserialize(UserCreatedEvent.EVENT_NAME, payload);

    expect(restored).toBeInstanceOf(UserCreatedEvent);
    expect(restored.aggregateId).toBe('user-1');
    expect(restored.eventName).toBe(UserCreatedEvent.EVENT_NAME);
    expect(restored.occurredAt).toEqual(occurredAt);
    expect((restored as UserCreatedEvent).email).toBe('jane@example.com');
  });

  it('serializes occurredAt as an ISO-8601 string', () => {
    const occurredAt = new Date('2026-01-02T03:04:05.678Z');
    const payload = serializer.serialize(
      new UserCreatedEvent('user-1', 'jane@example.com', occurredAt),
    );

    const parsed = JSON.parse(payload) as { occurredAt: string };
    expect(parsed.occurredAt).toBe(occurredAt.toISOString());
  });

  it('throws UnknownDomainEventError for an unregistered event name', () => {
    expect(() => serializer.deserialize('does.not.exist', '{}')).toThrow(UnknownDomainEventError);
  });
});
