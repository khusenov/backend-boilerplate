import './instrumentation';
import { createContainer, InjectionMode } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import { registerDependencies } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { env } from '@/config/env';
import { toServiceIdentity } from '@/config/service-identity';
import { shutdownTracing } from '@/infrastructure/observability/tracing';
import { startWorker } from '@/start-worker';
import { buildHealthApp } from '@/presentation/http/health-app';
import { createWorkerShutdown } from '@/worker-shutdown';
import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';

const logger = createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env));

async function bootstrap(): Promise<void> {
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
  registerDependencies(container, logger);

  const healthApp = await buildHealthApp({
    healthCheck: container.cradle.healthCheck,
    metricsExposition: container.cradle.metricsExposition,
    metricsEnabled: env.METRICS_ENABLED,
    logger,
  });

  registerGracefulShutdown({
    logger,
    dispose: createWorkerShutdown({ healthApp, container }),
    flushTelemetry: shutdownTracing,
  });

  await startWorker(container);
  await healthApp.listen({ host: env.HOST, port: env.WORKER_PORT });
  logger.info({ port: env.WORKER_PORT }, 'worker started');
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'worker bootstrap failed');
  process.exit(1);
});
