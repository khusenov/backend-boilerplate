import type { DomainEventCodec } from './domain-event-codec';
import {
  DuplicateDomainEventCodecError,
  MalformedDomainEventCodecError,
  UnknownDomainEventError,
} from './domain-event-errors';

export interface DomainEventCodecRegistryDeps {
  codecs: readonly DomainEventCodec[];
}

export class DomainEventCodecRegistry {
  private readonly codecs: Map<string, DomainEventCodec>;

  constructor({ codecs }: DomainEventCodecRegistryDeps) {
    this.codecs = new Map();
    for (const codec of codecs) {
      this.register(codec);
    }
  }

  codecFor(eventName: string): DomainEventCodec {
    const codec = this.codecs.get(eventName);
    if (!codec) {
      throw new UnknownDomainEventError(eventName);
    }
    return codec;
  }

  private register(codec: DomainEventCodec): void {
    assertWellFormedCodec(codec);
    if (this.codecs.has(codec.eventName)) {
      throw new DuplicateDomainEventCodecError(codec.eventName);
    }
    this.codecs.set(codec.eventName, codec);
  }
}

function assertWellFormedCodec(codec: DomainEventCodec): void {
  if (codec.eventName.length === 0) {
    throw new MalformedDomainEventCodecError('', 'eventName must not be empty');
  }
  if (!Number.isInteger(codec.eventVersion) || codec.eventVersion < 1) {
    throw new MalformedDomainEventCodecError(
      codec.eventName,
      `eventVersion must be a positive integer, got ${codec.eventVersion}`,
    );
  }
}
