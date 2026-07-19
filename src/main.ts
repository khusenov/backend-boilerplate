import { buildApp } from '@/presentation/http/app';
import { env } from '@/config/env';
import { OUTBOX_RELAY_JOB, OUTBOX_RELAY_INTERVAL_MS } from '@/infrastructure/events/outbox-relay';
import { createLoggerOptions } from '@/infrastructure/logging/logger-options';

async function bootstrap(): Promise<void> {
  const app = await buildApp({
    loggerOptions: createLoggerOptions(env.LOG_LEVEL),
    disableRequestLogging: env.isDevelopment,
  });

  void app.diContainer.resolve('jobWorker');
  await app.diContainer
    .resolve('jobScheduler')
    .schedule(OUTBOX_RELAY_JOB, {}, { everyMs: OUTBOX_RELAY_INTERVAL_MS });

  const shutdown = async (signal: string, code = 0): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      app.log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
    await app.close();
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (error) => {
    app.log.fatal({ err: error }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void bootstrap();
