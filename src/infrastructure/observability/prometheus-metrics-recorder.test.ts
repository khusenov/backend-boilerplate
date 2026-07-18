import { describe, it, expect } from 'vitest';
import { PrometheusMetricsRecorder } from './prometheus-metrics-recorder';

describe('PrometheusMetricsRecorder', () => {
  it('exposes the Prometheus text content type', () => {
    const recorder = new PrometheusMetricsRecorder();
    expect(recorder.contentType).toContain('text/plain');
  });

  it('collects default process metrics into its own registry', async () => {
    const recorder = new PrometheusMetricsRecorder();
    const output = await recorder.render();
    expect(output).toContain('process_cpu_user_seconds_total');
  });

  it('records an observed HTTP request under the duration histogram', async () => {
    const recorder = new PrometheusMetricsRecorder();
    recorder.observeHttpRequest({
      method: 'GET',
      route: '/users/:id',
      statusCode: 200,
      durationSeconds: 0.123,
    });
    const output = await recorder.render();
    expect(output).toContain('http_request_duration_seconds_count');
    expect(output).toContain('route="/users/:id"');
    expect(output).toContain('status_code="200"');
  });

  it('keeps a separate registry per instance (no global cross-talk)', async () => {
    const first = new PrometheusMetricsRecorder();
    const second = new PrometheusMetricsRecorder();
    first.observeHttpRequest({
      method: 'GET',
      route: '/a',
      statusCode: 200,
      durationSeconds: 0.01,
    });
    const secondOutput = await second.render();
    expect(secondOutput).not.toContain('route="/a"');
  });
});
