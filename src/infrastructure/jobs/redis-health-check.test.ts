import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisHealthCheck } from './redis-health-check';

const TIMEOUT_MS = 1000;

function makeRedis(ping: () => Promise<string>): Redis {
  return { ping } as unknown as Redis;
}

describe('RedisHealthCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('check', () => {
    it('resolves when PING replies PONG', async () => {
      const redis = makeRedis(() => Promise.resolve('PONG'));
      const sut = new RedisHealthCheck({
        healthCheckRedisConnection: redis,
        healthCheckTimeoutMs: TIMEOUT_MS,
      });

      await expect(sut.check()).resolves.toBeUndefined();
    });

    it('rejects when PING replies anything other than PONG', async () => {
      const redis = makeRedis(() => Promise.resolve('LOADING'));
      const sut = new RedisHealthCheck({
        healthCheckRedisConnection: redis,
        healthCheckTimeoutMs: TIMEOUT_MS,
      });

      await expect(sut.check()).rejects.toThrow('unexpected Redis PING reply');
    });

    it('rejects when the connection fails', async () => {
      const redis = makeRedis(() => Promise.reject(new Error('ECONNREFUSED')));
      const sut = new RedisHealthCheck({
        healthCheckRedisConnection: redis,
        healthCheckTimeoutMs: TIMEOUT_MS,
      });

      await expect(sut.check()).rejects.toThrow('ECONNREFUSED');
    });

    it('rejects when PING does not respond within the timeout', async () => {
      vi.useFakeTimers();
      const redis = makeRedis(() => new Promise<string>(() => undefined));
      const sut = new RedisHealthCheck({
        healthCheckRedisConnection: redis,
        healthCheckTimeoutMs: TIMEOUT_MS,
      });

      const assertion = expect(sut.check()).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await assertion;
    });
  });
});
