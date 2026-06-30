import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRoute', (route) => {
    route.schema = { ...route.schema, tags: ['Health'] };
    route.config = { ...route.config, rateLimit: false };
  });

  app.get('/live', () => {
    return { status: 'ok' };
  });

  app.get('/ready', async (request, reply) => {
    const { healthCheck } = request.diScope.cradle;
    try {
      await healthCheck.check();
      return { status: 'ready' };
    } catch (err) {
      request.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  done();
};
