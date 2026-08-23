import { describe, expect, it } from 'vitest';
import { DomainEventCodecRegistry } from './domain-event-codec-registry';
import { domainEventCodecs } from './domain-event-codecs';
import { userCreatedEventCodec } from './user-created-event-codec';
import {
  DuplicateDomainEventCodecError,
  MalformedDomainEventCodecError,
  UnknownDomainEventError,
} from './domain-event-errors';
import type { DomainEventCodec } from './domain-event-codec';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

function makeCodecDeclaring(eventName: string, eventVersion: number): DomainEventCodec {
  return {
    eventName,
    eventVersion,
    encode: () => ({}),
    decode: () => {
      throw new Error('not used');
    },
  };
}

describe('DomainEventCodecRegistry', () => {
  it('resolves a registered codec by its event name', () => {
    const registry = new DomainEventCodecRegistry({ codecs: domainEventCodecs });

    expect(registry.codecFor(UserCreatedEvent.EVENT_NAME)).toBe(userCreatedEventCodec);
  });

  it('resolves every codec in the production list', () => {
    const registry = new DomainEventCodecRegistry({ codecs: domainEventCodecs });

    for (const codec of domainEventCodecs) {
      expect(registry.codecFor(codec.eventName)).toBe(codec);
    }
  });

  it('throws UnknownDomainEventError for an unregistered event name', () => {
    const registry = new DomainEventCodecRegistry({ codecs: [] });

    expect(() => registry.codecFor('does.not.exist')).toThrow(UnknownDomainEventError);
  });

  it('throws UnknownDomainEventError for inherited object property names', () => {
    const registry = new DomainEventCodecRegistry({ codecs: domainEventCodecs });

    expect(() => registry.codecFor('__proto__')).toThrow(UnknownDomainEventError);
    expect(() => registry.codecFor('constructor')).toThrow(UnknownDomainEventError);
  });

  it('rejects two codecs registered for the same event name', () => {
    const codecs = [userCreatedEventCodec, userCreatedEventCodec];

    expect(() => new DomainEventCodecRegistry({ codecs })).toThrow(DuplicateDomainEventCodecError);
  });

  it('rejects a codec whose version is not a positive integer', () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new DomainEventCodecRegistry({ codecs: [makeCodecDeclaring('stub.event', version)] }),
      ).toThrow(MalformedDomainEventCodecError);
    }
  });

  it('rejects a codec with an empty event name', () => {
    expect(() => new DomainEventCodecRegistry({ codecs: [makeCodecDeclaring('', 1)] })).toThrow(
      MalformedDomainEventCodecError,
    );
  });
});
