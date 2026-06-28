import 'dotenv/config';
import { bool, cleanEnv, email, host, num, port, str } from 'envalid';

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  HOST: host({ default: '0.0.0.0' }),
  PORT: port({ default: 8000 }),
  LOG_LEVEL: str({
    choices: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    default: 'info',
  }),
  DATABASE_URL: str(),
  JWT_ACCESS_SECRET: str(),
  JWT_ISSUER: str({ default: 'finflow' }),
  JWT_AUDIENCE: str({ default: 'finflow-api' }),
  ACCESS_TOKEN_TTL: num({ default: 900 }), // 15 minutes
  REFRESH_TOKEN_TTL: num({ default: 60 * 60 * 24 * 14 }), // 14 days
  COOKIE_SECRET: str({ default: '' }),
  WEB_ORIGIN: str({ devDefault: 'http://127.0.0.1:3000' }),
  COOKIE_SECURE: bool({ default: true, devDefault: false }),
  BOOTSTRAP_ADMIN_EMAIL: email({ default: '' }),
});

export type Env = typeof env;
