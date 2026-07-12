import { describe, expect, it, vi } from 'vitest';
import { UserCreatedLogHandler } from './user-created-log-handler';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { Logger } from '@/application/shared/ports/logger';

function makeLogger() {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    debug: vi.fn<Logger['debug']>(),
  } satisfies Logger;
}

describe('UserCreatedLogHandler', () => {
  it('subscribes to the user.created routing key', () => {
    const handler = new UserCreatedLogHandler({ logger: makeLogger() });
    expect(handler.eventName).toBe(UserCreatedEvent.EVENT_NAME);
  });

  it('logs the creation with the event data', async () => {
    const logger = makeLogger();
    const handler = new UserCreatedLogHandler({ logger });
    const event = new UserCreatedEvent('user-1', 'ada@example.com');

    await handler.handle(event);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('User created', {
      aggregateId: 'user-1',
      email: 'ada@example.com',
      occurredAt: event.occurredAt.toISOString(),
    });
  });
});
