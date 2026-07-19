import type { LoggerOptions } from 'pino';
import { isSpanContextValid, trace } from '@opentelemetry/api';

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

export function createLoggerOptions(level: string): LoggerOptions {
  return {
    level,
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
