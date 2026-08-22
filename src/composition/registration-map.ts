import type { Resolver } from 'awilix';
import type { Cradle } from '@fastify/awilix';

export type CompleteRegistrations = {
  [K in keyof Cradle]: Resolver<Cradle[K]>;
};

export type RegistrationMap = Partial<CompleteRegistrations>;
