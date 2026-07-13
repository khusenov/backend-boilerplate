import { Redis } from 'ioredis';

export interface RedisConnectionDeps {
  redisUrl: string;
}

export function createRedisConnection({ redisUrl }: RedisConnectionDeps): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
