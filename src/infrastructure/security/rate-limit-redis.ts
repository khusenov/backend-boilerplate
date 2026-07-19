import { Redis } from 'ioredis';

const CONNECT_TIMEOUT_MS = 500;
const COMMAND_TIMEOUT_MS = 1000;
const MAX_RETRIES_PER_REQUEST = 1;

export interface RateLimitRedisDeps {
  redisUrl: string;
}

export function createRateLimitRedis({ redisUrl }: RateLimitRedisDeps): Redis {
  return new Redis(redisUrl, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    enableOfflineQueue: false,
  });
}
