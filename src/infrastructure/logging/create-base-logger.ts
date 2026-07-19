import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { createLoggerOptions } from './logger-options';

export function createBaseLogger(level: string): FastifyBaseLogger {
  return pino(createLoggerOptions(level));
}
