import { asFunction } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { Redis } from 'ioredis';
import { env } from '@/config/env';
import type { IdempotencyStore } from '@/application/shared/ports/idempotency-store';
import { RedisIdempotencyStore } from '@/infrastructure/idempotency/redis-idempotency-store';
import { createRedisConnection } from '@/infrastructure/jobs/redis-connection';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    idempotencyRedis: Redis;
    idempotencyStore: IdempotencyStore;
  }
}

export const idempotencyRegistrations = {
  idempotencyRedis: asFunction(() => createRedisConnection({ redisUrl: env.REDIS_URL }))
    .singleton()
    .disposer((connection) => connection.disconnect()),
  idempotencyStore: asFunction(
    ({ idempotencyRedis }: Pick<Cradle, 'idempotencyRedis'>) =>
      new RedisIdempotencyStore({
        redis: idempotencyRedis,
        lockTtlSeconds: env.IDEMPOTENCY_LOCK_TTL,
        resultTtlSeconds: env.IDEMPOTENCY_RESULT_TTL,
      }),
  ).singleton(),
} satisfies RegistrationMap;
