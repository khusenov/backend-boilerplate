import { asClass, asFunction, asValue } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { Redis } from 'ioredis';
import { env } from '@/config/env';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import { PrismaHealthCheck } from '@/infrastructure/persistence/prisma-health-check';
import { RedisHealthCheck } from '@/infrastructure/jobs/redis-health-check';
import { CompositeHealthCheck } from '@/infrastructure/health/composite-health-check';
import { createRedisConnection } from '@/infrastructure/jobs/redis-connection';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    databaseHealthCheck: HealthCheck;
    healthCheckRedisConnection: Redis;
    redisHealthCheck: HealthCheck;
    healthCheck: HealthCheck;
    healthCheckTimeoutMs: number;
  }
}

export const healthRegistrations = {
  databaseHealthCheck: asClass(PrismaHealthCheck).singleton(),
  healthCheckRedisConnection: asFunction(() => createRedisConnection({ redisUrl: env.REDIS_URL }))
    .singleton()
    .disposer((connection) => connection.disconnect()),
  redisHealthCheck: asClass(RedisHealthCheck).singleton(),
  healthCheck: asFunction(
    ({
      databaseHealthCheck,
      redisHealthCheck,
    }: Pick<Cradle, 'databaseHealthCheck' | 'redisHealthCheck'>) =>
      new CompositeHealthCheck([databaseHealthCheck, redisHealthCheck]),
  ).singleton(),
  healthCheckTimeoutMs: asValue(env.HEALTHCHECK_TIMEOUT_MS),
} satisfies RegistrationMap;
