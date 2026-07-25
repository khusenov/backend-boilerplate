import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { closeWithGrace } = vi.hoisted(() => ({ closeWithGrace: vi.fn() }));
vi.mock('close-with-grace', () => ({ default: closeWithGrace }));

import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';

type ShutdownCallback = (opts: { err?: Error; signal?: string }) => Promise<void>;

function fakeLogger(): Pick<FastifyBaseLogger, 'info' | 'error'> {
  return { info: vi.fn(), error: vi.fn() } as Pick<FastifyBaseLogger, 'info' | 'error'>;
}

function registeredCallback(): ShutdownCallback {
  return closeWithGrace.mock.calls?.[0]?.[1] as ShutdownCallback;
}

describe('registerGracefulShutdown', () => {
  afterEach(() => vi.clearAllMocks());

  it('configures close-with-grace with the shutdown timeout', () => {
    registerGracefulShutdown({ logger: fakeLogger(), dispose: vi.fn(), timeoutMs: 7_000 });
    expect(closeWithGrace).toHaveBeenCalledWith({ delay: 7_000 }, expect.any(Function));
  });

  it('disposes resources and flushes telemetry on a signal', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const flushTelemetry = vi.fn().mockResolvedValue(undefined);
    registerGracefulShutdown({ logger: fakeLogger(), dispose, flushTelemetry });

    await registeredCallback()({ signal: 'SIGTERM' });

    expect(dispose).toHaveBeenCalledOnce();
    expect(flushTelemetry).toHaveBeenCalledOnce();
  });

  it('logs the error and still disposes on a fatal error', async () => {
    const logger = fakeLogger();
    const dispose = vi.fn().mockResolvedValue(undefined);
    registerGracefulShutdown({ logger, dispose });

    await registeredCallback()({ err: new Error('boom') });

    expect(logger.error).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not fail the shutdown when telemetry flush rejects', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const flushTelemetry = vi.fn().mockRejectedValue(new Error('otel down'));
    registerGracefulShutdown({ logger: fakeLogger(), dispose, flushTelemetry });

    await expect(registeredCallback()({ signal: 'SIGTERM' })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('skips the telemetry flush when none is provided', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    registerGracefulShutdown({ logger: fakeLogger(), dispose });

    await expect(registeredCallback()({ signal: 'SIGINT' })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
