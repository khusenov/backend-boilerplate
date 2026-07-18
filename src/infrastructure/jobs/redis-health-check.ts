import type { Redis } from 'ioredis';
import type { HealthCheck } from '@/application/shared/ports/health-check';

const HEALTHY_PING_REPLY = 'PONG';

interface RedisHealthCheckDeps {
  healthCheckRedisConnection: Redis;
  healthCheckTimeoutMs: number;
}

export class RedisHealthCheck implements HealthCheck {
  private readonly redis: Redis;
  private readonly timeoutMs: number;

  constructor({ healthCheckRedisConnection, healthCheckTimeoutMs }: RedisHealthCheckDeps) {
    this.redis = healthCheckRedisConnection;
    this.timeoutMs = healthCheckTimeoutMs;
  }

  async check(): Promise<void> {
    const reply = await this.withTimeout(this.redis.ping());
    if (reply !== HEALTHY_PING_REPLY) {
      throw new Error(`unexpected Redis PING reply: ${reply}`);
    }
  }

  private withTimeout(operation: Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis health check timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
  }
}
