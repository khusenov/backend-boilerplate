import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import { healthRoutes } from './routes/health-routes';

export interface HealthAppOptions {
  healthCheck: HealthCheck;
  logger: FastifyBaseLogger;
}

export async function buildHealthApp({
  healthCheck,
  logger,
}: HealthAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRoutes, { prefix: '/health', healthCheck });
  return app;
}
