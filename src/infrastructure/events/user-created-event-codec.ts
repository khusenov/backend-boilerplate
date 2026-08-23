import { z } from 'zod';
import type { DomainEvent } from '@/domain/shared/domain-event';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { DomainEventCodec } from './domain-event-codec';

type UserCreatedPayload = Omit<UserCreatedEvent, keyof DomainEvent>;

const userCreatedPayloadSchema = z.object({
  email: z.string().min(1),
});

export const userCreatedEventCodec: DomainEventCodec<UserCreatedEvent> = {
  eventName: UserCreatedEvent.EVENT_NAME,
  eventVersion: 1,
  encode: (event): UserCreatedPayload =>
    userCreatedPayloadSchema.parse({ email: event.email } satisfies UserCreatedPayload),
  decode: (payload, metadata) =>
    new UserCreatedEvent(
      metadata.aggregateId,
      userCreatedPayloadSchema.parse(payload).email,
      metadata.occurredAt,
    ),
};
