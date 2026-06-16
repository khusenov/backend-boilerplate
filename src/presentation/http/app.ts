import { fastify, type FastifyInstance } from 'fastify';
import { fastifySensible } from '@fastify/sensible';

export interface BuildAppOptions {
  logLevel: string;
  disableRequestLogging?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: { level: opts.logLevel },
    forceCloseConnections: true,
    disableRequestLogging: opts.disableRequestLogging ?? false,
  });

  await app.register(fastifySensible);

  app.get('/health', () => ({ status: 'ok' }));

  return app;
}
