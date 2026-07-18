import fp from 'fastify-plugin';
import { diContainer } from '@fastify/awilix';

const UNMATCHED_ROUTE_LABEL = '__unmatched__' as const;
const MILLISECONDS_PER_SECOND = 1000;

export const metricsPlugin = fp((app) => {
  app.addHook('onResponse', (request, reply, done) => {
    diContainer.cradle.metricsRecorder.observeHttpRequest({
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE_LABEL,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / MILLISECONDS_PER_SECOND,
    });
    done();
  });
});
