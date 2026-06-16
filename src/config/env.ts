import { cleanEnv, host, port, str } from 'envalid';

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  HOST: host({ default: '0.0.0.0' }),
  PORT: port({ default: 8000 }),
  LOG_LEVEL: str({
    choices: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    default: 'info',
  }),
});

export type Env = typeof env;
