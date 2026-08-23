import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainEventSerializer } from './domain-event-serializer';
import { DomainEventCodecRegistry } from './domain-event-codec-registry';
import { domainEventCodecs } from './domain-event-codecs';
import {
  DomainEventDecodeError,
  DomainEventEncodeError,
  DomainEventVersionMismatchError,
  UnknownDomainEventError,
} from './domain-event-errors';
import type { DomainEventCodec } from './domain-event-codec';
import { DomainEvent } from '@/domain/shared/domain-event';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

const OCCURRED_AT = new Date('2026-01-02T03:04:05.678Z');
const STUB_EVENT_NAME = 'stub.event';

class StubEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly label: string,
    occurredAt: Date,
  ) {
    super(aggregateId, STUB_EVENT_NAME, occurredAt);
  }
}

type StubPayload = Omit<StubEvent, keyof DomainEvent>;

const stubPayloadSchema = z.object({ label: z.string().min(1) });

const stubCodec: DomainEventCodec<StubEvent> = {
  eventName: STUB_EVENT_NAME,
  eventVersion: 1,
  encode: (event): StubPayload =>
    stubPayloadSchema.parse({ label: event.label } satisfies StubPayload),
  decode: (payload, metadata) =>
    new StubEvent(
      metadata.aggregateId,
      stubPayloadSchema.parse(payload).label,
      metadata.occurredAt,
    ),
};

function makeSerializer(codecs: readonly DomainEventCodec[]): DomainEventSerializer {
  return new DomainEventSerializer({
    domainEventCodecRegistry: new DomainEventCodecRegistry({ codecs }),
  });
}

const stubSerializer = makeSerializer([stubCodec]);
const productionSerializer = makeSerializer(domainEventCodecs);

function makeStoredEnvelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventName: STUB_EVENT_NAME,
    eventVersion: 1,
    aggregateId: 'agg-1',
    occurredAt: OCCURRED_AT.toISOString(),
    payload: { label: 'hello' },
    ...overrides,
  });
}

describe('DomainEventSerializer', () => {
  it('round-trips a UserCreatedEvent through the production codecs', () => {
    const original = new UserCreatedEvent('user-1', 'jane@example.com', OCCURRED_AT);

    const restored = productionSerializer.deserialize(
      UserCreatedEvent.EVENT_NAME,
      productionSerializer.serialize(original),
    );

    expect(restored).toBeInstanceOf(UserCreatedEvent);
    expect(restored.aggregateId).toBe('user-1');
    expect(restored.eventName).toBe(UserCreatedEvent.EVENT_NAME);
    expect(restored.occurredAt).toEqual(OCCURRED_AT);
    expect((restored as UserCreatedEvent).email).toBe('jane@example.com');
  });

  it('writes the full envelope with the codec version and a nested payload', () => {
    const payload = stubSerializer.serialize(new StubEvent('agg-1', 'hello', OCCURRED_AT));

    expect(JSON.parse(payload)).toEqual({
      eventName: STUB_EVENT_NAME,
      eventVersion: 1,
      aggregateId: 'agg-1',
      occurredAt: OCCURRED_AT.toISOString(),
      payload: { label: 'hello' },
    });
  });

  it('serializes occurredAt as a top-level ISO-8601 string', () => {
    const payload = stubSerializer.serialize(new StubEvent('agg-1', 'hello', OCCURRED_AT));

    expect((JSON.parse(payload) as { occurredAt: string }).occurredAt).toBe(
      OCCURRED_AT.toISOString(),
    );
  });

  it('throws UnknownDomainEventError when deserializing an unregistered event name', () => {
    expect(() => stubSerializer.deserialize('does.not.exist', '{}')).toThrow(
      UnknownDomainEventError,
    );
  });

  it('throws UnknownDomainEventError when serializing an event with no codec', () => {
    const orphan = makeSerializer([]);

    expect(() => orphan.serialize(new StubEvent('agg-1', 'hello', OCCURRED_AT))).toThrow(
      UnknownDomainEventError,
    );
  });

  it('throws DomainEventEncodeError when the codec rejects the payload it would write', () => {
    expect(() => stubSerializer.serialize(new StubEvent('agg-1', '', OCCURRED_AT))).toThrow(
      DomainEventEncodeError,
    );
  });

  it('throws DomainEventEncodeError when the envelope itself would be invalid', () => {
    expect(() => stubSerializer.serialize(new StubEvent('', 'hello', OCCURRED_AT))).toThrow(
      DomainEventEncodeError,
    );
  });

  it('throws DomainEventEncodeError when the event carries an invalid date', () => {
    expect(() =>
      stubSerializer.serialize(new StubEvent('agg-1', 'hello', new Date('nope'))),
    ).toThrow(DomainEventEncodeError);
  });

  it('rejects a payload whose event-specific field is missing', () => {
    expect(() =>
      stubSerializer.deserialize(STUB_EVENT_NAME, makeStoredEnvelopeJson({ payload: {} })),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects a payload whose event-specific field has the wrong type', () => {
    expect(() =>
      stubSerializer.deserialize(
        STUB_EVENT_NAME,
        makeStoredEnvelopeJson({ payload: { label: 42 } }),
      ),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects an envelope with no payload object', () => {
    expect(() =>
      stubSerializer.deserialize(
        STUB_EVENT_NAME,
        JSON.stringify({
          eventName: STUB_EVENT_NAME,
          eventVersion: 1,
          aggregateId: 'agg-1',
          occurredAt: OCCURRED_AT.toISOString(),
        }),
      ),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects a row written in the pre-envelope flat format', () => {
    const legacyRow = JSON.stringify({
      aggregateId: 'agg-1',
      eventName: STUB_EVENT_NAME,
      occurredAt: OCCURRED_AT.toISOString(),
      label: 'hello',
    });

    expect(() => stubSerializer.deserialize(STUB_EVENT_NAME, legacyRow)).toThrow(
      DomainEventDecodeError,
    );
  });

  it('rejects a stored row that is not valid JSON', () => {
    expect(() => stubSerializer.deserialize(STUB_EVENT_NAME, 'not json')).toThrow(
      DomainEventDecodeError,
    );
  });

  it('rejects a stored row that is valid JSON but not an object', () => {
    expect(() => stubSerializer.deserialize(STUB_EVENT_NAME, 'null')).toThrow(
      DomainEventDecodeError,
    );
  });

  it('rejects an envelope whose event name disagrees with the row', () => {
    expect(() =>
      stubSerializer.deserialize(
        STUB_EVENT_NAME,
        makeStoredEnvelopeJson({ eventName: 'other.event' }),
      ),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects an envelope with an empty aggregate id', () => {
    expect(() =>
      stubSerializer.deserialize(STUB_EVENT_NAME, makeStoredEnvelopeJson({ aggregateId: '' })),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects an envelope whose occurredAt is not an ISO-8601 instant', () => {
    expect(() =>
      stubSerializer.deserialize(
        STUB_EVENT_NAME,
        makeStoredEnvelopeJson({ occurredAt: 'yesterday' }),
      ),
    ).toThrow(DomainEventDecodeError);
  });

  it('rejects an envelope whose version is not a positive integer', () => {
    const attempt = (): DomainEvent =>
      stubSerializer.deserialize(STUB_EVENT_NAME, makeStoredEnvelopeJson({ eventVersion: 0 }));

    expect(attempt).toThrow(DomainEventDecodeError);
    expect(attempt).not.toThrow(DomainEventVersionMismatchError);
  });

  it('rejects an envelope written at a version the codec does not read', () => {
    expect(() =>
      stubSerializer.deserialize(STUB_EVENT_NAME, makeStoredEnvelopeJson({ eventVersion: 2 })),
    ).toThrow(DomainEventVersionMismatchError);
  });

  it('keeps payload content out of the thrown error', () => {
    const attempt = (): DomainEvent => stubSerializer.deserialize(STUB_EVENT_NAME, 's3cret');

    expect(attempt).toThrow(DomainEventDecodeError);

    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainEventDecodeError);
      if (error instanceof DomainEventDecodeError) {
        expect(error.message).not.toContain('s3cret');
        expect(String(error.cause)).not.toContain('s3cret');
        expect(JSON.stringify(error.details ?? {})).not.toContain('s3cret');
      }
    }
  });
});
