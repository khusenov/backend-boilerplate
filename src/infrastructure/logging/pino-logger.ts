import type { Logger } from '@/application/shared/ports/logger';
import type { FastifyBaseLogger } from 'fastify';
import type { ContextProvider } from '@/application/shared/ports/context-provider';

export class PinoLogger implements Logger {
  constructor(
    private readonly baseLogger: FastifyBaseLogger,
    private readonly context: ContextProvider,
  ) {}

  info(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.info(this.withContext(data), message);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.warn(this.withContext(data), message);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.error(this.withContext(data), message);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.baseLogger.debug(this.withContext(data), message);
  }

  private withContext(data?: Record<string, unknown>): Record<string, unknown> {
    return { ...data, ...this.context.getAll() };
  }
}
