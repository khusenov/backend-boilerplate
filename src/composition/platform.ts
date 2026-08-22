import { asClass, asValue } from 'awilix';
import type { FastifyBaseLogger } from 'fastify';
import { env, type Env } from '@/config/env';
import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Logger } from '@/application/shared/ports/logger';
import { PinoLogger } from '@/infrastructure/logging/pino-logger';
import { RequestContextProvider } from '@/infrastructure/logging/request-context-provider';
import { SystemClock } from '@/infrastructure/time/system-clock';
import { UuidIdGenerator } from '@/infrastructure/identity/uuid-id-generator';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    logger: Logger;
    clock: Clock;
    idGenerator: IdGenerator;
  }
}

export function createPlatformRegistrations(baseLogger: FastifyBaseLogger) {
  return {
    env: asValue(env),
    logger: asValue(new PinoLogger(baseLogger, new RequestContextProvider())),
    clock: asClass(SystemClock).singleton(),
    idGenerator: asClass(UuidIdGenerator).singleton(),
  } satisfies RegistrationMap;
}
