import type { DomainEventCodec } from './domain-event-codec';
import { userCreatedEventCodec } from './user-created-event-codec';

export const domainEventCodecs: readonly DomainEventCodec[] = [userCreatedEventCodec];
