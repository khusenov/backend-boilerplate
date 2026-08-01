import type { Redis } from 'ioredis';
import type {
  IdempotencyClaim,
  IdempotencyStore,
  IdempotentResponse,
} from '@/application/shared/ports/idempotency-store';

interface RedisIdempotencyStoreDeps {
  redis: Redis;
  lockTtlSeconds: number;
  resultTtlSeconds: number;
}

type StoredRecord =
  | { state: 'in_flight' }
  | { state: 'completed'; status: number; body: string; fingerprint: string };

const KEY_PREFIX = 'idem:';
const MILLISECONDS_PER_SECOND = 1000;

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Redis;
  private readonly lockTtlMs: number;
  private readonly resultTtlMs: number;

  constructor({ redis, lockTtlSeconds, resultTtlSeconds }: RedisIdempotencyStoreDeps) {
    this.redis = redis;
    this.lockTtlMs = lockTtlSeconds * MILLISECONDS_PER_SECOND;
    this.resultTtlMs = resultTtlSeconds * MILLISECONDS_PER_SECOND;
  }

  async claim(key: string): Promise<IdempotencyClaim> {
    const inFlight = JSON.stringify({ state: 'in_flight' } satisfies StoredRecord);
    const previous = await this.redis.set(
      this.namespaced(key),
      inFlight,
      'PX',
      this.lockTtlMs,
      'NX',
      'GET',
    );
    if (previous === null) {
      return { outcome: 'claimed' };
    }
    return this.interpret(previous);
  }

  async complete(key: string, response: IdempotentResponse): Promise<void> {
    const record: StoredRecord = {
      state: 'completed',
      status: response.status,
      body: response.body,
      fingerprint: response.fingerprint,
    };
    await this.redis.set(this.namespaced(key), JSON.stringify(record), 'PX', this.resultTtlMs);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.namespaced(key));
  }

  private interpret(raw: string): IdempotencyClaim {
    const record = JSON.parse(raw) as StoredRecord;
    if (record.state === 'in_flight') {
      return { outcome: 'in_flight' };
    }
    return {
      outcome: 'replayed',
      response: { status: record.status, body: record.body, fingerprint: record.fingerprint },
    };
  }

  private namespaced(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }
}
