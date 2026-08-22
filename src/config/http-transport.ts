import { env } from './env';
import { parseTrustProxy } from './trust-proxy';

export const trustProxy = parseTrustProxy(env.TRUST_PROXY);

export const httpLimits = {
  bodyLimitBytes: env.BODY_LIMIT_BYTES,
  requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
  keepAliveTimeoutMs: env.KEEP_ALIVE_TIMEOUT_MS,
  maxParamLength: env.MAX_PARAM_LENGTH,
} as const;
