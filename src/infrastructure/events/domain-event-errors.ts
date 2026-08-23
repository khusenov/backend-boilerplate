import { InternalError, type SemanticErrorOptions } from '@/shared/errors';

export class UnknownDomainEventError extends InternalError {
  constructor(eventName: string) {
    super(`No codec registered for domain event "${eventName}"`, {
      code: 'DOMAIN_EVENT_UNKNOWN',
      details: { eventName },
    });
  }
}

export class DuplicateDomainEventCodecError extends InternalError {
  constructor(eventName: string) {
    super(`More than one codec is registered for domain event "${eventName}"`, {
      code: 'DOMAIN_EVENT_CODEC_DUPLICATE',
      details: { eventName },
    });
  }
}

export class MalformedDomainEventCodecError extends InternalError {
  constructor(eventName: string, reason: string) {
    super(`Codec declaration for domain event "${eventName}" is malformed: ${reason}`, {
      code: 'DOMAIN_EVENT_CODEC_MALFORMED',
      details: { eventName, reason },
    });
  }
}

export class DomainEventEncodeError extends InternalError {
  constructor(eventName: string, options?: Pick<SemanticErrorOptions, 'cause' | 'details'>) {
    super(`Failed to encode domain event "${eventName}"`, {
      code: 'DOMAIN_EVENT_ENCODE_FAILED',
      details: { eventName, ...options?.details },
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}

export class DomainEventDecodeError extends InternalError {
  constructor(eventName: string, reason: string, options?: SemanticErrorOptions) {
    super(`Failed to decode domain event "${eventName}": ${reason}`, {
      code: options?.code ?? 'DOMAIN_EVENT_DECODE_FAILED',
      details: { eventName, ...options?.details },
      ...(options?.cause !== undefined && { cause: options.cause }),
    });
  }
}

export class DomainEventVersionMismatchError extends DomainEventDecodeError {
  constructor(eventName: string, expectedVersion: number, storedVersion: number) {
    super(
      eventName,
      `stored at version ${storedVersion}, but the registered codec reads version ${expectedVersion}`,
      {
        code: 'DOMAIN_EVENT_VERSION_MISMATCH',
        details: { expectedVersion, storedVersion },
      },
    );
  }
}
