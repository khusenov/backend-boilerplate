import { inject } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.REDIS_URL = inject('redisUrl');
process.env.JWT_ACCESS_SECRET ??= 'integration-test-access-secret-0123456789';
process.env.TRUST_PROXY = '1';
