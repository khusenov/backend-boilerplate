import type { LoggerOptions } from 'pino';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { ServiceIdentity } from '../../config/service-identity';

export const REDACT_CENSOR = '[Redacted]';

export const REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
] as const;

export function createLoggerOptions(level: string, identity?: ServiceIdentity): LoggerOptions {
  return {
    level,
    ...(identity
      ? {
          base: {
            service: identity.service,
            env: identity.environment,
            version: identity.version,
          },
        }
      : {}),
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    mixin: traceCorrelationMixin,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
  };
}

export function traceCorrelationMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return {};
  }
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
