import type { FastifyServerOptions } from 'fastify';
import type { TrustProxySetting } from '@/config/trust-proxy';

type FastifyHardeningOptions = Readonly<
  Required<
    Pick<
      FastifyServerOptions,
      'trustProxy' | 'bodyLimit' | 'requestTimeout' | 'keepAliveTimeout' | 'routerOptions'
    >
  >
>;

export interface HttpHardeningInput {
  readonly trustProxy: TrustProxySetting;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxParamLength: number;
}

export function httpHardeningOptions(input: HttpHardeningInput): FastifyHardeningOptions {
  return {
    trustProxy: input.trustProxy,
    bodyLimit: input.bodyLimitBytes,
    requestTimeout: input.requestTimeoutMs,
    keepAliveTimeout: input.keepAliveTimeoutMs,
    routerOptions: { maxParamLength: input.maxParamLength },
  };
}
