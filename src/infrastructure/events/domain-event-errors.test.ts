import { describe, expect, it } from 'vitest';
import {
  DomainEventDecodeError,
  DomainEventEncodeError,
  DomainEventVersionMismatchError,
  DuplicateDomainEventCodecError,
  MalformedDomainEventCodecError,
  UnknownDomainEventError,
} from './domain-event-errors';
import { ErrorKind, InternalError } from '@/shared/errors';

const ANY_EVENT_NAME = 'any.event';

const CASES = [
  {
    name: 'UnknownDomainEventError',
    error: new UnknownDomainEventError(ANY_EVENT_NAME),
    code: 'DOMAIN_EVENT_UNKNOWN',
  },
  {
    name: 'DuplicateDomainEventCodecError',
    error: new DuplicateDomainEventCodecError(ANY_EVENT_NAME),
    code: 'DOMAIN_EVENT_CODEC_DUPLICATE',
  },
  {
    name: 'MalformedDomainEventCodecError',
    error: new MalformedDomainEventCodecError(ANY_EVENT_NAME, 'eventVersion must be positive'),
    code: 'DOMAIN_EVENT_CODEC_MALFORMED',
  },
  {
    name: 'DomainEventEncodeError',
    error: new DomainEventEncodeError(ANY_EVENT_NAME),
    code: 'DOMAIN_EVENT_ENCODE_FAILED',
  },
  {
    name: 'DomainEventDecodeError',
    error: new DomainEventDecodeError(ANY_EVENT_NAME, 'bad payload'),
    code: 'DOMAIN_EVENT_DECODE_FAILED',
  },
  {
    name: 'DomainEventVersionMismatchError',
    error: new DomainEventVersionMismatchError(ANY_EVENT_NAME, 2, 1),
    code: 'DOMAIN_EVENT_VERSION_MISMATCH',
  },
] as const;

describe.each(CASES)('$name', ({ name, error, code }) => {
  it('is a non-operational internal error carrying its own code and name', () => {
    expect(error).toBeInstanceOf(InternalError);
    expect(error.kind).toBe(ErrorKind.Internal);
    expect(error.isOperational).toBe(false);
    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
  });

  it('names the event in its details', () => {
    expect(error.details).toMatchObject({ eventName: ANY_EVENT_NAME });
  });
});

describe('DomainEventDecodeError', () => {
  it('merges the event name into the supplied details', () => {
    const error = new DomainEventDecodeError(ANY_EVENT_NAME, 'bad payload', {
      details: { storedEventName: 'user.deleted' },
    });

    expect(error.message).toContain('bad payload');
    expect(error.details).toEqual({
      eventName: ANY_EVENT_NAME,
      storedEventName: 'user.deleted',
    });
  });

  it('preserves the underlying cause when one is given, and omits it otherwise', () => {
    const cause = new Error('unexpected token');

    expect(new DomainEventDecodeError(ANY_EVENT_NAME, 'boom', { cause }).cause).toBe(cause);
    expect(new DomainEventDecodeError(ANY_EVENT_NAME, 'boom').cause).toBeUndefined();
  });
});

describe('DomainEventVersionMismatchError', () => {
  it('is a decode failure so one catch covers every unreadable row', () => {
    const error = new DomainEventVersionMismatchError(ANY_EVENT_NAME, 2, 1);

    expect(error).toBeInstanceOf(DomainEventDecodeError);
    expect(error.details).toEqual({
      eventName: ANY_EVENT_NAME,
      expectedVersion: 2,
      storedVersion: 1,
    });
  });
});

describe('DomainEventEncodeError', () => {
  it('preserves the underlying cause', () => {
    const cause = new Error('schema rejected the projection');

    expect(new DomainEventEncodeError(ANY_EVENT_NAME, { cause }).cause).toBe(cause);
  });
});
