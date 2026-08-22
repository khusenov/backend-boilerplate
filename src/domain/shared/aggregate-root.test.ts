import { describe, expect, it } from 'vitest';
import { AggregateRoot, UNSAVED_VERSION, type AggregateRootProps } from './aggregate-root';
import { DomainEvent } from './domain-event';

class RecordedEvent extends DomainEvent {
  constructor(aggregateId: string, occurredAt: Date) {
    super(aggregateId, 'test.recorded', occurredAt);
  }
}

interface TestAggregateProps extends AggregateRootProps {
  name: string;
}

class TestAggregate extends AggregateRoot<TestAggregateProps> {
  static create(id: string, now: Date): TestAggregate {
    return new TestAggregate({
      id,
      name: 'test',
      version: UNSAVED_VERSION,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static hydrate(props: TestAggregateProps): TestAggregate {
    return new TestAggregate(props);
  }

  emit(occurredAt: Date): void {
    this.recordEvent(new RecordedEvent(this.id, occurredAt));
  }
}

describe('AggregateRoot', () => {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  const firstOccurredAt = new Date('2026-08-01T01:00:00.000Z');
  const secondOccurredAt = new Date('2026-08-01T02:00:00.000Z');

  it('starts with an empty event buffer', () => {
    const aggregate = TestAggregate.create('agg-1', createdAt);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('records events and returns them in insertion order', () => {
    const aggregate = TestAggregate.create('agg-1', createdAt);
    aggregate.emit(firstOccurredAt);
    aggregate.emit(secondOccurredAt);

    const events = aggregate.pullDomainEvents();

    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(RecordedEvent);
    expect(events[0]?.occurredAt).toBe(firstOccurredAt);
    expect(events[1]?.occurredAt).toBe(secondOccurredAt);
  });

  it('clears the buffer after pulling (pull semantics)', () => {
    const aggregate = TestAggregate.create('agg-1', createdAt);
    aggregate.emit(firstOccurredAt);

    expect(aggregate.pullDomainEvents()).toHaveLength(1);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });

  it('starts a newly built aggregate at the unsaved version', () => {
    expect(TestAggregate.create('agg-1', createdAt).version).toBe(UNSAVED_VERSION);
  });

  it('reports the stored version of a hydrated aggregate', () => {
    const aggregate = TestAggregate.hydrate({
      id: 'agg-1',
      name: 'test',
      version: 3,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    });

    expect(aggregate.version).toBe(3);
  });
});
