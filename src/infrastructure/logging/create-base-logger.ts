import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { createLoggerOptions } from './logger-options';
import type { ServiceIdentity } from '../../config/service-identity';

export function createBaseLogger(level: string, identity?: ServiceIdentity): FastifyBaseLogger {
  return pino(createLoggerOptions(level, identity));
}
