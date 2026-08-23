import fp from 'fastify-plugin';
import type { MetricsRecorder } from '@/application/shared/ports/metrics';

export interface MetricsPluginOptions {
  metricsRecorder: MetricsRecorder;
}

const UNMATCHED_ROUTE_LABEL = '__unmatched__' as const;
const MILLISECONDS_PER_SECOND = 1000;

export const metricsPlugin = fp<MetricsPluginOptions>((app, { metricsRecorder }) => {
  app.addHook('onResponse', (request, reply, done) => {
    metricsRecorder.observeHttpRequest({
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE_LABEL,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / MILLISECONDS_PER_SECOND,
    });
    done();
  });
});
