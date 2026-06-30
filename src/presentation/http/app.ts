import { fastify, type FastifyInstance } from 'fastify';
import { fastifySensible } from '@fastify/sensible';
import { diContainer, fastifyAwilixPlugin } from '@fastify/awilix';
import { registerDependencies } from '@/container';
import { registerErrorHandler } from '@/presentation/http/error-handler';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { userRoutes } from '@/presentation/http/routes/user-routes';
import { fastifyCors } from '@fastify/cors';
import { env } from '@/config/env';
import { fastifyCookie } from '@fastify/cookie';
import { authPlugin } from '@/presentation/http/plugins/authenticate';
import { authRoutes } from '@/presentation/http/routes/auth-routes';
import { roleRoutes } from '@/presentation/http/routes/role-routes';
import { permissionRoutes } from '@/presentation/http/routes/permission-routes';
import { fastifyHelmet } from '@fastify/helmet';
import { fastifyRateLimit } from '@fastify/rate-limit';
import { helmetOptions, rateLimitOptions } from '@/presentation/http/security';
import { healthRoutes } from '@/presentation/http/routes/health-routes';

export interface BuildAppOptions {
  logLevel: string;
  disableRequestLogging?: boolean;
  rateLimit?: boolean;
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
  await app.register(fastifyHelmet, helmetOptions(env.isProduction));
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

  if (!env.isProduction) {
    await app.register(fastifySwagger, {
      openapi: {
        info: { title: 'Finflow API', version: '1.0.0' },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  if (opts.rateLimit ?? true) {
    await app.register(
      fastifyRateLimit,
      rateLimitOptions(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW),
    );
  }

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(roleRoutes, { prefix: '/roles' });
  await app.register(permissionRoutes, { prefix: '/permissions' });

  return app;
}
