import { describe, expect, it, vi } from 'vitest';
import { createWorkerShutdown } from './worker-shutdown';

describe('createWorkerShutdown', () => {
  it('closes the health server before disposing the container', async () => {
    const order: string[] = [];
    const healthApp = {
      close: vi.fn(() => {
        order.push('close');
        return Promise.resolve();
      }),
    };
    const container = {
      dispose: vi.fn(() => {
        order.push('dispose');
        return Promise.resolve();
      }),
    };

    await createWorkerShutdown({ healthApp, container })();

    expect(order).toEqual(['close', 'dispose']);
    expect(healthApp.close).toHaveBeenCalledOnce();
    expect(container.dispose).toHaveBeenCalledOnce();
  });

  it('still disposes the container when the health server fails to close', async () => {
    const healthApp = { close: vi.fn(() => Promise.reject(new Error('close failed'))) };
    const container = { dispose: vi.fn(() => Promise.resolve()) };

    await expect(createWorkerShutdown({ healthApp, container })()).rejects.toThrow('close failed');

    expect(container.dispose).toHaveBeenCalledOnce();
  });
});
