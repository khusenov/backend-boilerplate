import { describe, expect, it } from 'vitest';
import { userCreatedEventCodec } from './user-created-event-codec';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

const OCCURRED_AT = new Date('2026-01-02T03:04:05.678Z');
const METADATA = { aggregateId: 'user-1', occurredAt: OCCURRED_AT };

describe('userCreatedEventCodec', () => {
  it('declares the routing key and payload version it reads', () => {
    expect(userCreatedEventCodec.eventName).toBe(UserCreatedEvent.EVENT_NAME);
    expect(userCreatedEventCodec.eventVersion).toBe(1);
  });

  it('encodes only the event-specific fields, leaving envelope fields out', () => {
    const event = new UserCreatedEvent('user-1', 'jane@example.com', OCCURRED_AT);

    expect(userCreatedEventCodec.encode(event)).toEqual({ email: 'jane@example.com' });
  });

  it('refuses to encode an event the reader would reject', () => {
    const event = new UserCreatedEvent('user-1', '', OCCURRED_AT);

    expect(() => userCreatedEventCodec.encode(event)).toThrow();
  });

  it('decodes a payload into a UserCreatedEvent carrying the envelope metadata', () => {
    const decoded = userCreatedEventCodec.decode({ email: 'jane@example.com' }, METADATA);

    expect(decoded).toBeInstanceOf(UserCreatedEvent);
    expect(decoded.aggregateId).toBe('user-1');
    expect(decoded.eventName).toBe(UserCreatedEvent.EVENT_NAME);
    expect(decoded.occurredAt).toEqual(OCCURRED_AT);
    expect(decoded.email).toBe('jane@example.com');
  });

  it('rejects a payload whose email is missing', () => {
    expect(() => userCreatedEventCodec.decode({}, METADATA)).toThrow();
  });

  it('rejects a payload whose email is not a string', () => {
    expect(() => userCreatedEventCodec.decode({ email: 42 }, METADATA)).toThrow();
  });

  it('rejects a payload whose email is empty', () => {
    expect(() => userCreatedEventCodec.decode({ email: '' }, METADATA)).toThrow();
  });

  it('rejects a payload that is not an object', () => {
    expect(() => userCreatedEventCodec.decode(null, METADATA)).toThrow();
  });
});
