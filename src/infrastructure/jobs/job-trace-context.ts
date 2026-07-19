import { context, propagation } from '@opentelemetry/api';

const CARRIER_KEY = '__otelCarrier';

export function injectTraceContext<TPayload>(payload: TPayload): TPayload {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (Object.keys(carrier).length === 0) {
    return payload;
  }
  return { ...payload, [CARRIER_KEY]: carrier };
}

export function runWithExtractedContext<TResult>(
  data: unknown,
  run: () => Promise<TResult>,
): Promise<TResult> {
  const carrier = readCarrier(data);
  if (carrier === undefined) {
    return run();
  }
  return context.with(propagation.extract(context.active(), carrier), run);
}

export function stripTraceContext<TPayload>(data: TPayload): TPayload {
  if (!isCarrierEnvelope(data)) {
    return data;
  }
  const clone: Record<string, unknown> = { ...data };
  delete clone[CARRIER_KEY];
  return clone as TPayload;
}

function readCarrier(data: unknown): Record<string, string> | undefined {
  return isCarrierEnvelope(data) ? data[CARRIER_KEY] : undefined;
}

function isCarrierEnvelope(
  data: unknown,
): data is Record<string, unknown> & { [CARRIER_KEY]: Record<string, string> } {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const carrier = (data as Record<string, unknown>)[CARRIER_KEY];
  return typeof carrier === 'object' && carrier !== null;
}
