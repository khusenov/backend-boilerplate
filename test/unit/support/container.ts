import { fastifyAwilixPlugin, type Cradle } from '@fastify/awilix';
import { createContainer, type NameAndRegistrationPair } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { APP_CONTAINER_OPTIONS } from '@/container-options';

export async function registerTestContainer(
  app: FastifyInstance,
  registrations: NameAndRegistrationPair<Cradle>,
): Promise<void> {
  const container = createContainer<Cradle>(APP_CONTAINER_OPTIONS);
  container.register(registrations);
  await app.register(fastifyAwilixPlugin, {
    container,
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
  });
}
