import { fastify, type FastifyInstance } from 'fastify';
import { fastifySensible } from '@fastify/sensible';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { registerDependencies } from '@/container';
import { registerErrorHandler } from '@/presentation/http/error-handler';

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
  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });

  registerDependencies(diContainer);
  registerErrorHandler(app);

  app.get('/health', () => ({ status: 'ok' }));

  return app;
}
