import 'dotenv/config';
import { bool, cleanEnv, email, host, num, port, str } from 'envalid';
import { APP_NAME, appIdentity } from './app-identity';
import { assertProductionSecrets } from './assert-production-secrets';

export const env = cleanEnv(process.env, {
  APP_NAME: str({
    default: APP_NAME,
    desc: 'Identity prefix for service, queue, token and dashboard naming',
  }),
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
  JWT_ISSUER: str({ default: APP_NAME }),
  JWT_AUDIENCE: str({ default: appIdentity.apiServiceName }),
  ACCESS_TOKEN_TTL: num({ default: 900 }), // 15 minutes
  REFRESH_TOKEN_TTL: num({ default: 60 * 60 * 24 * 14 }), // 14 days
  COOKIE_SECRET: str({
    default: '',
    desc: 'Signs the refresh cookie; >= 32 chars in production (empty disables signing in dev)',
  }),
  WEB_ORIGIN: str({ devDefault: 'http://localhost:5173' }),
  COOKIE_SECURE: bool({ default: true, devDefault: false }),
  BOOTSTRAP_ADMIN_EMAIL: email({ default: '' }),
  RATE_LIMIT_MAX: num({ default: 100 }),
  RATE_LIMIT_WINDOW: str({ default: '1 minute' }),
  RATE_LIMIT_AUTH_MAX: num({ default: 5 }),
  REDIS_URL: str({ devDefault: 'redis://127.0.0.1:6379' }),
  QUEUE_PREFIX: str({ default: APP_NAME }),
  QUEUE_CONCURRENCY: num({ default: 5 }),
  DATA_RETENTION_TTL: num({ default: 60 * 60 * 24 * 30 }), // 30 days
  IDEMPOTENCY_RESULT_TTL: num({ default: 60 * 60 * 24 }), // completed-response replay window: 24h
  IDEMPOTENCY_LOCK_TTL: num({ default: 30 }), // in-flight claim guard: 30s
  METRICS_ENABLED: bool({ default: true }),
  HEALTHCHECK_TIMEOUT_MS: num({ default: 2000 }),
  OTEL_ENABLED: bool({ default: false }),
  OTEL_SERVICE_NAME: str({ default: appIdentity.apiServiceName }),
  OTEL_SERVICE_VERSION: str({ default: '0.0.0' }),
  OTEL_EXPORTER_OTLP_ENDPOINT: str({ default: 'http://localhost:4318' }),
  BULL_BOARD_ENABLED: bool({ default: false }),
  BULL_BOARD_PATH: str({ default: '/admin/queues' }),
  BULL_BOARD_USERNAME: str({ default: 'admin' }),
  BULL_BOARD_PASSWORD: str({ default: '' }),
  BULL_BOARD_READONLY: bool({ default: true }),
  SMTP_HOST: host({ devDefault: 'localhost' }),
  SMTP_PORT: port({ default: 587, devDefault: 1025 }),
  SMTP_SECURE: bool({
    default: false,
    desc: 'true for port 465 (implicit TLS); false uses STARTTLS',
  }),
  SMTP_REQUIRE_TLS: bool({
    default: true,
    devDefault: false,
    desc: 'Refuse to send if STARTTLS cannot be negotiated; keep on in prod, off for a plaintext dev catcher',
  }),
  SMTP_USER: str({ default: '', desc: 'SMTP auth user; empty means no auth (e.g. local catcher)' }),
  SMTP_PASSWORD: str({ default: '', desc: 'SMTP auth password; unused when SMTP_USER is empty' }),
  EMAIL_FROM: email({
    devDefault: `no-reply@${APP_NAME}.local`,
    desc: 'Default From address for outbound mail',
  }),
  VERIFICATION_CODE_TTL: num({ default: 60 * 15 }), // 15 minutes
  VERIFICATION_MAX_ATTEMPTS: num({ default: 5 }),
  VERIFICATION_CODE_SECRET: str({
    devDefault: 'dev-verification-code-secret-change-me',
    desc: 'HMAC pepper for verification codes; >= 32 chars in production',
  }),
  PASSWORD_RESET_TOKEN_TTL: num({ default: 60 * 30 }), // 30 minutes
  PASSWORD_RESET_URL_BASE: str({
    devDefault: 'http://localhost:5173/reset-password',
    desc: 'Frontend URL the reset email links to; the raw token is appended as ?token=',
  }),
});

export type Env = typeof env;

assertProductionSecrets(env);
