import { describe, expect, it } from 'vitest';
import { InjectionMode, asValue } from 'awilix';
import { mock } from 'vitest-mock-extended';
import type { FastifyBaseLogger } from 'fastify';
import { createAppContainer } from '@/container';
import type { MetricsRecorder } from '@/application/shared/ports/metrics';

describe('createAppContainer', () => {
  it('returns a new container on every call', () => {
    const first = createAppContainer(mock<FastifyBaseLogger>());
    const second = createAppContainer(mock<FastifyBaseLogger>());

    expect(first).not.toBe(second);
  });

  it('keeps a registration override local to the container it was applied to', () => {
    const first = createAppContainer(mock<FastifyBaseLogger>());
    const second = createAppContainer(mock<FastifyBaseLogger>());
    const stubRecorder = mock<MetricsRecorder>();

    first.register({ metricsRecorder: asValue(stubRecorder) });

    expect(first.cradle.metricsRecorder).toBe(stubRecorder);
    expect(second.cradle.metricsRecorder).not.toBe(stubRecorder);
  });

  it('builds a strict PROXY container', () => {
    expect(createAppContainer(mock<FastifyBaseLogger>()).options).toEqual({
      injectionMode: InjectionMode.PROXY,
      strict: true,
    });
  });

  it('exposes the base logger it was built from', () => {
    const baseLogger = mock<FastifyBaseLogger>();

    expect(createAppContainer(baseLogger).cradle.baseLogger).toBe(baseLogger);
  });
});
