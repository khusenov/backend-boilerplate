import type { FastifyHelmetOptions } from '@fastify/helmet';
import type { errorResponseBuilderContext, RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyError, FastifyRequest } from 'fastify';

export const RATE_LIMIT_KEY_NAMESPACE = 'finflow-rate-limit-';

export function helmetOptions(cspEnabled: boolean): FastifyHelmetOptions {
  return cspEnabled ? {} : { contentSecurityPolicy: false };
}

export function rateLimitOptions(max: number, timeWindow: string): RateLimitPluginOptions {
  return {
    max,
    timeWindow,
    skipOnError: true,
    nameSpace: RATE_LIMIT_KEY_NAMESPACE,
    errorResponseBuilder: (_request: FastifyRequest, context: errorResponseBuilderContext) => {
      const error = new Error(`Rate limit exceeded, retry in ${context.after}`) as FastifyError;
      error.statusCode = context.statusCode;
      error.code = 'RATE_LIMITED';
      return error;
    },
  };
}
