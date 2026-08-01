import 'dotenv/config';
import { bool, cleanEnv, email, host, num, port, str } from 'envalid';
import { assertProductionSecrets } from './assert-production-secrets';

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  HOST: host({ default: '0.0.0.0' }),
  PORT: port({ default: 8000 }),
  WORKER_PORT: port({ default: 8001 }),
  LOG_LEVEL: str({
    choices: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    default: 'info',
  }),
  DATABASE_URL: str(),
  JWT_ACCESS_SECRET: str({
    desc: 'HMAC signing key for access tokens; required, and >= 32 chars in production',
  }),
  JWT_ISSUER: str({ default: 'finflow' }),
  JWT_AUDIENCE: str({ default: 'finflow-api' }),
  ACCESS_TOKEN_TTL: num({ default: 900 }), // 15 minutes
  REFRESH_TOKEN_TTL: num({ default: 60 * 60 * 24 * 14 }), // 14 days
  COOKIE_SECRET: str({
    default: '',
    desc: 'Signs the refresh cookie; >= 32 chars in production (empty disables signing in dev)',
  }),
  WEB_ORIGIN: str({ devDefault: 'http://127.0.0.1:3000' }),
  COOKIE_SECURE: bool({ default: true, devDefault: false }),
  BOOTSTRAP_ADMIN_EMAIL: email({ default: '' }),
  RATE_LIMIT_MAX: num({ default: 100 }),
  RATE_LIMIT_WINDOW: str({ default: '1 minute' }),
  RATE_LIMIT_AUTH_MAX: num({ default: 5 }),
  REDIS_URL: str({ devDefault: 'redis://127.0.0.1:6379' }),
  QUEUE_PREFIX: str({ default: 'finflow' }),
  QUEUE_CONCURRENCY: num({ default: 5 }),
  DATA_RETENTION_TTL: num({ default: 60 * 60 * 24 * 30 }), // 30 days
  IDEMPOTENCY_RESULT_TTL: num({ default: 60 * 60 * 24 }), // completed-response replay window: 24h
  IDEMPOTENCY_LOCK_TTL: num({ default: 30 }), // in-flight claim guard: 30s
  METRICS_ENABLED: bool({ default: true }),
  HEALTHCHECK_TIMEOUT_MS: num({ default: 2000 }),
  OTEL_ENABLED: bool({ default: false }),
  OTEL_SERVICE_NAME: str({ default: 'finflow-api' }),
  OTEL_SERVICE_VERSION: str({ default: '0.0.0' }),
  OTEL_EXPORTER_OTLP_ENDPOINT: str({ default: 'http://localhost:4318' }),
  BULL_BOARD_ENABLED: bool({ default: false }),
  BULL_BOARD_PATH: str({ default: '/admin/queues' }),
  BULL_BOARD_USERNAME: str({ default: 'admin' }),
  BULL_BOARD_PASSWORD: str({ default: '' }),
  BULL_BOARD_READONLY: bool({ default: true }),
});

export type Env = typeof env;

assertProductionSecrets(env);
