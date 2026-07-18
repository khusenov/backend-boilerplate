import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

export const metricsRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRoute', (route) => {
    route.schema = { ...route.schema, tags: ['Metrics'] };
    route.config = { ...route.config, rateLimit: false };
  });

  app.get('/', async (request, reply) => {
    const { metricsExposition } = request.diScope.cradle;
    void reply.header('Content-Type', metricsExposition.contentType);
    return reply.send(await metricsExposition.render());
  });

  done();
};
