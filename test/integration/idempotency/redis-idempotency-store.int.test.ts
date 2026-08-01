import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisIdempotencyStore } from '@/infrastructure/idempotency/redis-idempotency-store';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SECOND_MS = 1000;

describe('RedisIdempotencyStore', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis.quit();
  });

  function storeWith(lockTtlSeconds: number): RedisIdempotencyStore {
    return new RedisIdempotencyStore({ redis, lockTtlSeconds, resultTtlSeconds: 60 });
  }

  it('claims a fresh key, blocks the second claim, then replays after completion', async () => {
    const store = storeWith(30);
    const key = 'test:lifecycle';

    expect(await store.claim(key)).toEqual({ outcome: 'claimed' });
    expect(await store.claim(key)).toEqual({ outcome: 'in_flight' });

    await store.complete(key, { status: 201, body: '{"id":1}', fingerprint: 'fp-1' });

    const replayed = await store.claim(key);
    expect(replayed).toEqual({
      outcome: 'replayed',
      response: { status: 201, body: '{"id":1}', fingerprint: 'fp-1' },
    });
  });

  it('release lets the key be claimed again', async () => {
    const store = storeWith(30);
    const key = 'test:release';
    await store.claim(key);
    await store.release(key);
    expect(await store.claim(key)).toEqual({ outcome: 'claimed' });
  });

  it('lets an in-flight claim expire after the lock TTL', async () => {
    const store = storeWith(1);
    const key = 'test:expiry';
    await store.claim(key);
    await new Promise((resolve) => setTimeout(resolve, SECOND_MS + 200));
    expect(await store.claim(key)).toEqual({ outcome: 'claimed' });
  });
});
