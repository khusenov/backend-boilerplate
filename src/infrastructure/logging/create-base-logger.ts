import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Builds a standalone base logger for non-HTTP entry points (CLI scripts, workers).
 *
 * Inside the HTTP server, Fastify constructs and owns the pino instance exposed as
 * `app.log`. Entry points that run outside Fastify have no such logger, so they build
 * their own here. Using pino directly keeps CLI output consistent with the server's
 * structured logs, and the return type asserts compatibility with what the composition
 * root (`registerDependencies`) expects.
 */
export function createBaseLogger(level: string): FastifyBaseLogger {
  return pino({ level });
}
