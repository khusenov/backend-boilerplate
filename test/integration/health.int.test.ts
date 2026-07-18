import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisHealthCheck } from '@/infrastructure/jobs/redis-health-check';
import { CompositeHealthCheck } from '@/infrastructure/health/composite-health-check';

const HEALTHCHECK_TIMEOUT_MS = 500;

describe('Redis readiness probe (integration)', () => {
  let container: StartedRedisContainer;
  let connection: Redis;
  let stopped = false;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7.4-alpine').start();
    connection = new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    connection?.disconnect();
    if (!stopped) {
      await container?.stop();
    }
  });

  it('resolves while Redis is reachable and rejects once it is stopped', async () => {
    const probe = new CompositeHealthCheck([
      new RedisHealthCheck({
        healthCheckRedisConnection: connection,
        healthCheckTimeoutMs: HEALTHCHECK_TIMEOUT_MS,
      }),
    ]);

    await expect(probe.check()).resolves.toBeUndefined();

    await container.stop();
    stopped = true;

    await expect(probe.check()).rejects.toThrow();
  });
});
