import { inject } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.JWT_ACCESS_SECRET ??= 'integration-test-access-secret-0123456789';
