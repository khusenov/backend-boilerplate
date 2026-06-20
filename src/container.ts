import { asFunction, asValue, type AwilixContainer } from 'awilix';
import { env, type Env } from '@/config/env';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/infrastructure/persistence/prisma-client';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    prisma: PrismaClient;
  }
}

export function registerDependencies(container: AwilixContainer): void {
  container.register({
    env: asValue(env),
    prisma: asFunction(createPrismaClient)
      .singleton()
      .disposer((client) => client.$disconnect()),
  });
}
