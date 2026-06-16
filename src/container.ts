import { asValue, type AwilixContainer } from 'awilix';
import { env, type Env } from '@/config/env';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
  }
}

export function registerDependencies(container: AwilixContainer): void {
  container.register({
    env: asValue(env),
  });
}
