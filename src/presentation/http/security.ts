import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { errorResponseBuilderContext, FastifyRateLimitOptions } from '@fastify/rate-limit';
import type { FastifyError, FastifyRequest } from 'fastify';

export function helmetOptions(cspEnabled: boolean): FastifyHelmetOptions {
  return cspEnabled ? {} : { contentSecurityPolicy: false };
}

export function rateLimitOptions(max: number, timeWindow: string): FastifyRateLimitOptions {
  return {
    max,
    timeWindow,
    errorResponseBuilder: (_request: FastifyRequest, context: errorResponseBuilderContext) => {
      const error = new Error(`Rate limit exceeded, retry in ${context.after}`) as FastifyError;
      error.statusCode = context.statusCode;
      error.code = 'RATE_LIMITED';
      return error;
    },
  };
}
