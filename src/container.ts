import { createContainer, type AwilixContainer } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { FastifyBaseLogger } from 'fastify';
import { APP_CONTAINER_OPTIONS } from '@/container-options';
import { createRegistrations } from '@/composition/compose';

export function createAppContainer(baseLogger: FastifyBaseLogger): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>(APP_CONTAINER_OPTIONS);
  container.register(createRegistrations(baseLogger));
  return container;
}
