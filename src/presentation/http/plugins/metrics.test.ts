import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue } from 'awilix';
import { metricsPlugin } from './metrics';
import type { MetricsRecorder } from '@/application/shared/ports/metrics';

function makeMetricsRecorder() {
  return {
    observeHttpRequest: vi.fn<MetricsRecorder['observeHttpRequest']>(),
  } satisfies MetricsRecorder;
}

async function buildApp(recorder: MetricsRecorder): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });
  diContainer.register({ metricsRecorder: asValue(recorder) });
  await app.register(metricsPlugin);
  app.get('/things/:id', () => ({ ok: true }));
  return app;
}

describe('metricsPlugin', () => {
  let app: FastifyInstance;
  let recorder: ReturnType<typeof makeMetricsRecorder>;

  beforeEach(async () => {
    recorder = makeMetricsRecorder();
    app = await buildApp(recorder);
  });

  afterEach(async () => {
    await app.close();
  });

  it('records the matched route template, method and status on response', async () => {
    await app.inject({ method: 'GET', url: '/things/42' });

    expect(recorder.observeHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', route: '/things/:id', statusCode: 200 }),
    );

    const metric = recorder.observeHttpRequest.mock.lastCall?.[0];
    expect(metric?.durationSeconds).toBeTypeOf('number');
  });

  it('labels unmatched routes with a bounded sentinel instead of the raw url', async () => {
    await app.inject({ method: 'GET', url: '/no/such/path' });
    expect(recorder.observeHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ route: '__unmatched__', statusCode: 404 }),
    );
  });
});
