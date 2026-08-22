import { aliasTo, asClass } from 'awilix';
import type { MetricsExposition, MetricsRecorder } from '@/application/shared/ports/metrics';
import { PrometheusMetricsRecorder } from '@/infrastructure/observability/prometheus-metrics-recorder';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    metricsRecorder: MetricsRecorder;
    metricsExposition: MetricsExposition;
  }
}

export const metricsRegistrations = {
  metricsRecorder: asClass(PrometheusMetricsRecorder).singleton(),
  metricsExposition: aliasTo<MetricsExposition>('metricsRecorder'),
} satisfies RegistrationMap;
