import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import type { MetricsExposition } from '@/application/shared/ports/metrics';
import { healthRoutes } from './routes/health-routes';
import { workerMetricsRoutes } from './routes/worker-metrics-routes';
import { httpHardeningOptions, type HttpHardeningInput } from './server-options';

export interface HealthAppOptions {
  healthCheck: HealthCheck;
  metricsExposition: MetricsExposition;
  metricsEnabled: boolean;
  logger: FastifyBaseLogger;
  hardening: HttpHardeningInput;
}

export async function buildHealthApp({
  healthCheck,
  metricsExposition,
  metricsEnabled,
  logger,
  hardening,
}: HealthAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    ...httpHardeningOptions(hardening),
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRoutes, { prefix: '/health', healthCheck });
  if (metricsEnabled) {
    await app.register(workerMetricsRoutes, { prefix: '/metrics', metricsExposition });
  }
  return app;
}
