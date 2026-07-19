import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { context, propagation, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_JOB, type ExampleJobPayload } from '@/application/jobs/example-job';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { JobWorker } from '@/infrastructure/jobs/job-worker';

const QUEUE_PREFIX = 'test';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const noopLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function enqueuingSpanContext(): SpanContext {
  return { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
}

function withActiveSpan<T>(run: () => T): T {
  const span = trace.wrapSpanContext(enqueuingSpanContext());
  return context.with(trace.setSpan(context.active(), span), run);
}

describe('BullMQ trace-context propagation', () => {
  let container: StartedRedisContainer;
  let url: string;

  beforeAll(async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    container = await new RedisContainer('redis:7.4-alpine').start();
    url = container.getConnectionUrl();
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('continues the enqueuing trace inside the worker across the Redis queue', async () => {
    const queueConnection = new Redis(url, { maxRetriesPerRequest: null });
    const workerConnection = new Redis(url, { maxRetriesPerRequest: null });

    let resolveObserved: (observed: {
      traceId: string | undefined;
      payload: ExampleJobPayload;
    }) => void;
    const observed = new Promise<{ traceId: string | undefined; payload: ExampleJobPayload }>(
      (resolve) => {
        resolveObserved = resolve;
      },
    );
    const handler: JobHandler<ExampleJobPayload> = {
      jobName: EXAMPLE_JOB,
      handle: (payload) => {
        resolveObserved({ traceId: trace.getActiveSpan()?.spanContext().traceId, payload });
        return Promise.resolve();
      },
    };

    const worker = new JobWorker({
      connection: workerConnection,
      queuePrefix: QUEUE_PREFIX,
      concurrency: 1,
      handlers: [handler],
      logger: noopLogger,
    });
    const queue = new BullMqJobQueue({ connection: queueConnection, queuePrefix: QUEUE_PREFIX });

    await withActiveSpan(() => queue.enqueue(EXAMPLE_JOB, { message: 'hello' }));

    const result = await observed;
    expect(result.traceId).toBe(TRACE_ID);
    expect(result.payload).toEqual({ message: 'hello' });

    await worker.close();
    await queue.close();
  });
});
