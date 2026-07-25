import closeWithGrace from 'close-with-grace';
import type { FastifyBaseLogger } from 'fastify';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface GracefulShutdownOptions {
  logger: Pick<FastifyBaseLogger, 'info' | 'error'>;
  dispose: () => Promise<void>;
  flushTelemetry?: () => Promise<void>;
  timeoutMs?: number;
}

export function registerGracefulShutdown({
  logger,
  dispose,
  flushTelemetry,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}: GracefulShutdownOptions): void {
  closeWithGrace({ delay: timeoutMs }, async ({ err, signal }) => {
    if (err !== undefined) {
      logger.error({ err }, 'shutting down after fatal error');
    } else {
      logger.info({ signal }, 'shutting down');
    }

    await dispose();

    if (flushTelemetry) {
      await flushTelemetry().catch((flushError: unknown) =>
        logger.error({ err: flushError }, 'telemetry flush failed'),
      );
    }
  });
}
