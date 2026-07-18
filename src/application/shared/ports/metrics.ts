export interface HttpRequestMetric {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}

export interface MetricsRecorder {
  observeHttpRequest(metrics: HttpRequestMetric): void;
}

export interface MetricsExposition {
  render(): Promise<string>;

  readonly contentType: string;
}
