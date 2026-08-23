import './instrumentation';
import { buildApp } from '@/presentation/http/app';
import { env } from '@/config/env';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { toServiceIdentity } from '@/config/service-identity';
import { shutdownTracing } from '@/infrastructure/observability/tracing';
import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';

async function bootstrap(): Promise<void> {
  const container = createAppContainer(createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env)));

  const app = await buildApp({
    container,
    disableRequestLogging: env.isDevelopment,
  });

  registerGracefulShutdown({
    logger: app.log,
    dispose: () => app.close(),
    flushTelemetry: shutdownTracing,
  });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void bootstrap();
