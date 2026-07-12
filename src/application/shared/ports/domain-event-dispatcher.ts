import type { DomainEvent } from '@/domain/shared/domain-event';

export interface DomainEventDispatcher {
  dispatch(events: readonly DomainEvent[]): Promise<void>;
}
