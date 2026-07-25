import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import {
  livenessResponse,
  readinessResponse,
  readinessUnavailableResponse,
} from '../schemas/health-response-schema';

export interface HealthRoutesOptions {
  healthCheck: HealthCheck;
}

export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, opts, done) => {
  const { healthCheck } = opts;

  app.addHook('onRoute', (route) => {
    route.schema = { ...route.schema, tags: ['Health'] };
    route.config = { ...route.config, rateLimit: false };
  });

  app.get('/live', { schema: { response: { 200: livenessResponse } } }, () => {
    return { status: 'ok' } as const;
  });

  app.get(
    '/ready',
    { schema: { response: { 200: readinessResponse, 503: readinessUnavailableResponse } } },
    async (request, reply) => {
      try {
        await healthCheck.check();
        return { status: 'ready' } as const;
      } catch (err) {
        request.log.error({ err }, 'readiness check failed');
        return reply.status(503).send({ status: 'unavailable' });
      }
    },
  );

  done();
};
