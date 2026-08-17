import 'dotenv/config';

const DEFAULT_APP_NAME = 'app';

const configuredAppName = process.env.APP_NAME?.trim();

export const APP_NAME =
  configuredAppName === undefined || configuredAppName === ''
    ? DEFAULT_APP_NAME
    : configuredAppName;

export const appIdentity = {
  name: APP_NAME,
  apiServiceName: `${APP_NAME}-api`,
  workerServiceName: `${APP_NAME}-worker`,
  swaggerTitle: `${APP_NAME} API`,
  bullBoardRealm: `${APP_NAME} Queues`,
  rateLimitNamespace: `${APP_NAME}-rate-limit-`,
  tracingRegistryKey: `${APP_NAME}.observability.tracing`,
} as const;
