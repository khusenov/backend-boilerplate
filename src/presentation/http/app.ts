import { fastify, type FastifyInstance } from 'fastify';
import { fastifySensible } from '@fastify/sensible';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { registerDependencies } from '@/container';
import { registerErrorHandler } from '@/presentation/http/error-handler';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { userRoutes } from '@/presentation/http/routes/user-routes';
import { fastifyCors } from '@fastify/cors';
import { env } from '@/config/env';
import { fastifyCookie } from '@fastify/cookie';
import { authPlugin } from '@/presentation/http/plugins/authenticate';
import { authRoutes } from '@/presentation/http/routes/auth-routes';

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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySensible);
  await app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
    injectionMode: 'PROXY',
  });
  await app.register(fastifyCors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(fastifyCookie, env.COOKIE_SECRET ? { secret: env.COOKIE_SECRET } : {});
  await app.register(authPlugin);

  registerDependencies(diContainer);
  registerErrorHandler(app);

  app.get('/health', () => ({ status: 'ok' }));

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });

  return app;
}
