import type { AwilixContainer } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { FastifyBaseLogger } from 'fastify';
import { createRegistrations } from '@/composition/compose';

export function registerDependencies(
  container: AwilixContainer<Cradle>,
  baseLogger: FastifyBaseLogger,
): void {
  container.register(createRegistrations(baseLogger));
}
