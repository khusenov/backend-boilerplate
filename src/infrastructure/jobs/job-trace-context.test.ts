import { beforeAll, describe, it, expect } from 'vitest';
import { context, propagation, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  injectTraceContext,
  runWithExtractedContext,
  stripTraceContext,
} from './job-trace-context';

const CARRIER_KEY = '__otelCarrier';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

function withActiveSpan<T>(run: () => T): T {
  const spanContext: SpanContext = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  };
  const span = trace.wrapSpanContext(spanContext);
  return context.with(trace.setSpan(context.active(), span), run);
}

describe('injectTraceContext', () => {
  it('envelopes an object payload with a carrier carrying the traceparent', () => {
    const enveloped = withActiveSpan(() => injectTraceContext({ message: 'hi' })) as Record<
      string,
      unknown
    >;
    expect(enveloped.message).toBe('hi');
    const carrier = enveloped[CARRIER_KEY] as Record<string, string> | undefined;
    expect(carrier?.traceparent).toContain(TRACE_ID);
  });

  it('returns the payload unchanged when no span is active', () => {
    const payload = { message: 'hi' };
    expect(injectTraceContext(payload)).toBe(payload);
  });

  it('returns a primitive payload untouched', () => {
    expect(injectTraceContext(42)).toBe(42);
  });
});

describe('runWithExtractedContext', () => {
  it('restores a context whose active span traceId equals the injected one', async () => {
    const enveloped = withActiveSpan(() => injectTraceContext({ message: 'hi' }));

    const observedTraceId = await runWithExtractedContext(enveloped, () =>
      Promise.resolve(trace.getActiveSpan()?.spanContext().traceId),
    );

    expect(observedTraceId).toBe(TRACE_ID);
  });

  it('runs the callback directly when the payload has no carrier', async () => {
    const result = await runWithExtractedContext({ message: 'hi' }, () => Promise.resolve('ran'));
    expect(result).toBe('ran');
  });
});

describe('stripTraceContext', () => {
  it('removes the carrier envelope', () => {
    const stripped = stripTraceContext({ message: 'hi', [CARRIER_KEY]: { traceparent: '00-x' } });
    expect(stripped).toEqual({ message: 'hi' });
    expect(CARRIER_KEY in stripped).toBe(false);
  });

  it('leaves a payload without a carrier untouched', () => {
    const payload = { message: 'hi' };
    expect(stripTraceContext(payload)).toBe(payload);
  });

  it('does not throw on a null carrier and leaves the payload intact', () => {
    const payload = { message: 'hi', [CARRIER_KEY]: null };
    expect(() => stripTraceContext(payload)).not.toThrow();
    expect(stripTraceContext(payload)).toEqual({ message: 'hi', [CARRIER_KEY]: null });
  });

  it('returns a primitive payload untouched', () => {
    expect(stripTraceContext('x')).toBe('x');
  });
});
