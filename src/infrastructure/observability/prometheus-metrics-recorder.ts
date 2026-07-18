import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import type {
  HttpRequestMetric,
  MetricsExposition,
  MetricsRecorder,
} from '@/application/shared/ports/metrics';

const HTTP_REQUEST_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export class PrometheusMetricsRecorder implements MetricsRecorder, MetricsExposition {
  private readonly registry: Registry;
  private readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of inbound HTTP requests in seconds.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [...HTTP_REQUEST_DURATION_BUCKETS_SECONDS],
      registers: [this.registry],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  observeHttpRequest({ method, route, statusCode, durationSeconds }: HttpRequestMetric): void {
    this.httpRequestDuration.observe({ method, route, status_code: statusCode }, durationSeconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
