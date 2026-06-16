import { buildApp } from '@/presentation/http/app';
import { env } from '@/config/env';

async function bootstrap(): Promise<void> {
  const app = await buildApp({
    logLevel: env.LOG_LEVEL,
    disableRequestLogging: env.isDevelopment,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => {
      app.log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void bootstrap();
