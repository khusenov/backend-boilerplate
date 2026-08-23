import type { DomainEvent } from '@/domain/shared/domain-event';
import type { DomainEventCodec } from './domain-event-codec';
import type { DomainEventCodecRegistry } from './domain-event-codec-registry';
import { domainEventEnvelopeSchema, type DomainEventEnvelope } from './domain-event-envelope';
import {
  DomainEventDecodeError,
  DomainEventEncodeError,
  DomainEventVersionMismatchError,
} from './domain-event-errors';

export interface DomainEventSerializerDeps {
  domainEventCodecRegistry: DomainEventCodecRegistry;
}

export class DomainEventSerializer {
  private readonly registry: DomainEventCodecRegistry;

  constructor({ domainEventCodecRegistry }: DomainEventSerializerDeps) {
    this.registry = domainEventCodecRegistry;
  }

  serialize(event: DomainEvent): string {
    const codec = this.registry.codecFor(event.eventName);
    return JSON.stringify(this.buildEnvelope(codec, event));
  }

  deserialize(eventName: string, payload: string): DomainEvent {
    const codec = this.registry.codecFor(eventName);
    const envelope = this.parseEnvelope(eventName, payload);
    this.assertEnvelopeMatchesCodec(envelope, codec);
    return this.rebuildEvent(codec, envelope);
  }

  private buildEnvelope(codec: DomainEventCodec, event: DomainEvent): DomainEventEnvelope {
    try {
      return domainEventEnvelopeSchema.parse({
        eventName: event.eventName,
        eventVersion: codec.eventVersion,
        aggregateId: event.aggregateId,
        occurredAt: event.occurredAt.toISOString(),
        payload: codec.encode(event),
      });
    } catch (error) {
      throw new DomainEventEncodeError(event.eventName, { cause: error });
    }
  }

  private parseEnvelope(eventName: string, payload: string): DomainEventEnvelope {
    const parsed = domainEventEnvelopeSchema.safeParse(this.parseJson(eventName, payload));
    if (parsed.success) {
      return parsed.data;
    }
    throw new DomainEventDecodeError(eventName, 'envelope failed validation', {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }

  private parseJson(eventName: string, payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      throw new DomainEventDecodeError(eventName, 'payload is not valid JSON');
    }
  }

  private assertEnvelopeMatchesCodec(envelope: DomainEventEnvelope, codec: DomainEventCodec): void {
    if (envelope.eventName !== codec.eventName) {
      throw new DomainEventDecodeError(
        codec.eventName,
        'stored event name does not match the row',
        {
          details: { storedEventName: envelope.eventName },
        },
      );
    }
    if (envelope.eventVersion !== codec.eventVersion) {
      throw new DomainEventVersionMismatchError(
        codec.eventName,
        codec.eventVersion,
        envelope.eventVersion,
      );
    }
  }

  private rebuildEvent(codec: DomainEventCodec, envelope: DomainEventEnvelope): DomainEvent {
    try {
      return codec.decode(envelope.payload, {
        aggregateId: envelope.aggregateId,
        occurredAt: new Date(envelope.occurredAt),
      });
    } catch (error) {
      throw new DomainEventDecodeError(envelope.eventName, 'codec could not rebuild the event', {
        cause: error,
      });
    }
  }
}
