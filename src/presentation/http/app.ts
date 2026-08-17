import { fastify, LogController, type FastifyInstance } from 'fastify';
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
import { fastifyCors } from '@fastify/cors';
import { appIdentity } from '@/config/app-identity';
import { env } from '@/config/env';
import { fastifyCookie } from '@fastify/cookie';
import { authPlugin } from '@/presentation/http/plugins/authenticate';
import { idempotencyPlugin } from '@/presentation/http/plugins/idempotency';
import { fastifyHelmet } from '@fastify/helmet';
import { fastifyRateLimit } from '@fastify/rate-limit';
import { helmetOptions, rateLimitOptions } from '@/presentation/http/security';
import { healthRoutes } from '@/presentation/http/routes/health-routes';
import {
  CORRELATION_ID_HEADER,
  correlationIdPlugin,
} from '@/presentation/http/plugins/correlation-id';
import { randomUUID } from 'node:crypto';
import { metricsPlugin } from '@/presentation/http/plugins/metrics';
import { metricsRoutes } from '@/presentation/http/routes/metrics-routes';
import type { LoggerOptions } from 'pino';
import { bullBoardPlugin } from '@/presentation/http/plugins/bull-board';
import { API_V1_PREFIX } from '@/presentation/http/api-version';
import { apiV1Routes } from '@/presentation/http/routes/api-v1-routes';

export interface BuildAppOptions {
  loggerOptions: LoggerOptions;
  disableRequestLogging?: boolean;
  rateLimit?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.loggerOptions,
    requestIdHeader: CORRELATION_ID_HEADER,
    genReqId: () => randomUUID(),
    forceCloseConnections: true,
    logController: new LogController({
      disableRequestLogging: opts.disableRequestLogging ?? false,
    }),
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
  await app.register(correlationIdPlugin);
  if (env.METRICS_ENABLED) await app.register(metricsPlugin);
  await app.register(fastifyCors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(fastifyCookie, env.COOKIE_SECRET ? { secret: env.COOKIE_SECRET } : {});
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);

  registerDependencies(diContainer, app.log);
  registerErrorHandler(app);

  if (!env.isProduction) {
    await app.register(fastifySwagger, {
      openapi: {
        info: { title: appIdentity.swaggerTitle, version: '1.0.0' },
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

  if (env.BULL_BOARD_ENABLED) {
    await app.register(bullBoardPlugin);
  }

  if (opts.rateLimit ?? true) {
    await app.register(fastifyRateLimit, {
      ...rateLimitOptions(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW),
      redis: diContainer.cradle.rateLimitRedis,
    });
  }

  await app.register(healthRoutes, {
    prefix: '/health',
    healthCheck: diContainer.cradle.healthCheck,
  });
  if (env.METRICS_ENABLED) await app.register(metricsRoutes, { prefix: '/metrics' });
  await app.register(apiV1Routes, { prefix: API_V1_PREFIX });

  return app;
}
