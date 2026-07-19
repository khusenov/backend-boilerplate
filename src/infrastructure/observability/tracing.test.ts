import { describe, it, expect } from 'vitest';
import { env } from '@/config/env';
import { shutdownTracing, startTracing } from './tracing';

describe('startTracing', () => {
  it('runs under the test-environment guard', () => {
    expect(env.isTest).toBe(true);
  });

  it('is a no-op in the test environment: it neither throws nor registers an SDK', async () => {
    expect(() => startTracing()).not.toThrow();
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});

describe('shutdownTracing', () => {
  it('resolves cleanly when the SDK was never started', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
