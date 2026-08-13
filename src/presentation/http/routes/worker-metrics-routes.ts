import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { MetricsExposition } from '@/application/shared/ports/metrics';

export interface WorkerMetricsRoutesOptions {
  metricsExposition: MetricsExposition;
}

export const workerMetricsRoutes: FastifyPluginCallbackZod<WorkerMetricsRoutesOptions> = (
  app,
  { metricsExposition },
  done,
) => {
  app.get('/', async (_request, reply) => {
    void reply.header('Content-Type', metricsExposition.contentType);
    return reply.send(await metricsExposition.render());
  });

  done();
};
