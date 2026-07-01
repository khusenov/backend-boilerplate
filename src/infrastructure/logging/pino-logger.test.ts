import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ContextProvider } from '@/application/shared/ports/context-provider';
import { PinoLogger } from './pino-logger';

function makeBaseLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeContext(contextData: Record<string, unknown> = {}): ContextProvider {
  return { getAll: vi.fn(() => contextData) };
}

describe('PinoLogger', () => {
  it.each(['info', 'warn', 'error', 'debug'] as const)(
    '%s calls base with (object, message) argument order',
    (level) => {
      const base = makeBaseLogger();
      const logger = new PinoLogger(base, makeContext());
      logger[level]('hello', { x: 1 });
      expect(base[level]).toHaveBeenCalledWith(expect.any(Object), 'hello');
    },
  );

  it('enriches data with context fields when context is active', () => {
    const base = makeBaseLogger();
    const logger = new PinoLogger(base, makeContext({ correlationId: 'abc' }));
    logger.info('msg', { userId: '1' });
    expect(base.info).toHaveBeenCalledWith({ userId: '1', correlationId: 'abc' }, 'msg');
  });

  it('passes data unchanged when context is empty', () => {
    const base = makeBaseLogger();
    const logger = new PinoLogger(base, makeContext({}));
    logger.info('msg', { userId: '1' });
    expect(base.info).toHaveBeenCalledWith({ userId: '1' }, 'msg');
  });

  it('context value wins over caller data when both have the same key', () => {
    const base = makeBaseLogger();
    const logger = new PinoLogger(base, makeContext({ correlationId: 'ctx-value' }));
    logger.info('msg', { correlationId: 'caller-value' });
    expect(base.info).toHaveBeenCalledWith({ correlationId: 'ctx-value' }, 'msg');
  });

  it('returns context fields when data is undefined', () => {
    const base = makeBaseLogger();
    const logger = new PinoLogger(base, makeContext({ correlationId: 'abc' }));
    logger.info('msg');
    expect(base.info).toHaveBeenCalledWith({ correlationId: 'abc' }, 'msg');
  });
});
