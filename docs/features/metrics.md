# Metrics

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `9044a23`

## Purpose

Operators need to see how the service behaves under load — request throughput, the latency
distribution, error rates, and process health (CPU, memory, event-loop lag, garbage collection) —
and they need it as time-series data a monitoring system can scrape on a schedule, not as log noise
or a bespoke dashboard. This feature publishes those signals in the **Prometheus text exposition
format** — a line-oriented plain-text encoding with one metric sample per line (`name{label="v"}
value`) — at a single endpoint, `GET /metrics`, so any Prometheus-compatible collector can poll them.
It records a latency histogram for **every** HTTP response automatically, adds the standard Node/
process metrics, and does so behind a port — so application and presentation code never import the
metrics library directly.

## How it works

The runtime has two halves that meet at one shared recorder instance.

**Recording (on every HTTP response).** `metricsPlugin` is wrapped in `fastify-plugin` (`fp(...)`),
which deliberately breaks Fastify's plugin encapsulation so the hook it registers is installed on the
**root** instance and therefore fires for every request the app serves — not just for routes declared
inside the plugin. The hook is an `onResponse` hook; when a response finishes it resolves the
app-level `metricsRecorder` from `diContainer.cradle` and calls `observeHttpRequest(...)` with:

- `method` — `request.method`;
- `route` — `request.routeOptions.url`, the **matched route template** (e.g. `/users/:id`, not the
  concrete `/users/42`), falling back to the sentinel `'__unmatched__'` when no route matched (a 404);
- `statusCode` — `reply.statusCode`;
- `durationSeconds` — `reply.elapsedTime / 1000` (Fastify reports elapsed time in milliseconds; the
  plugin's `MILLISECONDS_PER_SECOND` constant converts it to the seconds Prometheus expects).

The bound recorder, `PrometheusMetricsRecorder`, observes that sample into a `prom-client` `Histogram`
named `http_request_duration_seconds`, labelled `method`, `route`, and `status_code` (note the
`statusCode` field maps to the `status_code` label), using explicit second-valued buckets (the
latency thresholds observations are counted into).

**Exposing (on scrape).** `GET /metrics` is served by `metricsRoutes`. The handler resolves
`metricsExposition` from the request scope (`request.diScope.cradle`), sets the response
`Content-Type` to `metricsExposition.contentType` (prom-client's `text/plain; version=0.0.4;
charset=utf-8`), and sends `await metricsExposition.render()` — the entire registry serialized as
Prometheus exposition text, carrying both the HTTP histogram and the default process metrics.

The two halves see the same data because `metricsRecorder` and `metricsExposition` resolve to the
**same singleton object** (see [Architecture](#architecture)): the histogram the response hook fills
is the histogram `/metrics` renders.

**Gating.** Both the plugin and the route are registered in `app.ts` — where the [HTTP
Infrastructure](./http-infrastructure.md) layer assembles the Fastify app — only when
`env.METRICS_ENABLED` is true (the default). With it off, no hook is installed and `/metrics` returns
404 — the feature contributes zero overhead.

## Architecture

The application layer owns two **ports**: `MetricsRecorder` (the write side — record one observation)
and `MetricsExposition` (the read side — render the current snapshot). Splitting them honours the
Interface Segregation Principle: the response hook depends only on the recorder, the route depends
only on the exposition, and neither knows Prometheus exists. The infrastructure **adapter**,
`PrometheusMetricsRecorder`, implements both ports over `prom-client`. Concretes bind to ports in
exactly one place — `src/container.ts` — where `metricsRecorder` is bound
`asClass(PrometheusMetricsRecorder).singleton()` and `metricsExposition` is `aliasTo('metricsRecorder')`.
The alias is what makes both ports resolve to one shared instance, so data written through the recorder
is visible through the exposition. Dependencies point inward: the presentation-layer plugin and route
depend on the application-layer ports, never on `prom-client`.

| Component                   | Layer          | Responsibility                                                                                                                           | File                                                              |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `MetricsRecorder`           | Application    | Port: `observeHttpRequest(metrics)` — record one HTTP response sample                                                                    | `src/application/shared/ports/metrics.ts`                         |
| `MetricsExposition`         | Application    | Port: `render()` + `contentType` — snapshot the registry as exposition text and name its media type                                      | `src/application/shared/ports/metrics.ts`                         |
| `HttpRequestMetric`         | Application    | The recorded sample shape: `method`, `route`, `statusCode`, `durationSeconds`                                                            | `src/application/shared/ports/metrics.ts`                         |
| `PrometheusMetricsRecorder` | Infrastructure | Adapter implementing both ports over `prom-client`; owns a private `Registry`, the duration `Histogram`, and the default process metrics | `src/infrastructure/observability/prometheus-metrics-recorder.ts` |
| `metricsPlugin`             | Presentation   | `fastify-plugin` that adds the app-wide `onResponse` hook recording every response                                                       | `src/presentation/http/plugins/metrics.ts`                        |
| `metricsRoutes`             | Presentation   | Registers `GET /metrics`; tags it `Metrics` and exempts it from rate limiting                                                            | `src/presentation/http/routes/metrics-routes.ts`                  |

> Metrics is one of two observability pillars in `src/infrastructure/observability/`; distributed
> tracing ([tracing.md](./tracing.md), OpenTelemetry) is a separate feature with its own configuration.

## Public surface

The feature exposes one HTTP endpoint and two ports.

**Endpoint.**

| Method | Path       | Auth          | Purpose                                                                                   |
| ------ | ---------- | ------------- | ----------------------------------------------------------------------------------------- |
| `GET`  | `/metrics` | None (public) | Render the current Prometheus exposition (HTTP histogram + process metrics) for a scraper |

`/metrics` is **unauthenticated** — it uses no `authenticate` preHandler — and **rate-limit-exempt**:
the route's `onRoute` hook sets `rateLimit: false`, so a collector polling every few seconds is never
throttled. It is mounted under the `/metrics` prefix in `app.ts`, and only when `METRICS_ENABLED` is
true. A successful scrape returns `200` with `Content-Type: text/plain; version=0.0.4; charset=utf-8`
and the exposition text as the body.

**Ports.** Inner code programs against these; both are resolved from the Awilix container.

```ts
interface HttpRequestMetric {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}

interface MetricsRecorder {
  observeHttpRequest(metrics: HttpRequestMetric): void;
}

interface MetricsExposition {
  render(): Promise<string>;
  readonly contentType: string;
}
```

`observeHttpRequest` is fire-and-forget (`void`). `render()` is async because prom-client serializes
its registry asynchronously. `contentType` is the exact media type a handler must echo so Prometheus
parses the body correctly.

## Configuration

| Variable          | Default | Meaning                                                                                                                                                                                                                                                                                        |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED` | `true`  | When true, `app.ts` registers both `metricsPlugin` (the response-recording hook) and `metricsRoutes` (`GET /metrics`). When false, neither is registered: nothing is recorded and `/metrics` returns 404. Parsed as a boolean by `envalid` in `src/config/env.ts`; mirrored in `.env.example`. |

This is the only environment variable the feature reads. The metric name, label set, and histogram
buckets are code constants in `PrometheusMetricsRecorder`, not configuration.

## Usage & extension

**Scrape it.** Point a Prometheus collector at the endpoint. A minimal `scrape_config`:

```yaml
scrape_configs:
  - job_name: finflow-api
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['finflow-api:8000'] # host:PORT of the service (PORT defaults to 8000)
```

Because `/metrics` is unauthenticated, keep it reachable only from the monitoring network (bind the
service privately, or firewall the path) rather than exposing it publicly.

**Add a new metric.** The registry lives inside the adapter, so a new metric is a change to the port
plus the adapter — the container wiring does not move, because the singleton already backs both ports.
To count how many users are created, for example:

1. Widen the `MetricsRecorder` port in `src/application/shared/ports/metrics.ts`:

   ```ts
   export interface MetricsRecorder {
     observeHttpRequest(metrics: HttpRequestMetric): void;
     incrementUsersCreated(): void;
   }
   ```

2. Implement it in `PrometheusMetricsRecorder`
   (`src/infrastructure/observability/prometheus-metrics-recorder.ts`), registering the new metric on
   the same private registry so it is rendered by the existing `/metrics` endpoint:

   ```ts
   import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

   // add a field:
   private readonly usersCreated: Counter;

   // in the constructor, after the histogram:
   this.usersCreated = new Counter({
     name: 'users_created_total',
     help: 'Total number of users created.',
     registers: [this.registry],
   });

   // add the method:
   incrementUsersCreated(): void {
     this.usersCreated.inc();
   }
   ```

3. Call it from wherever the event happens, resolving `metricsRecorder` from the cradle
   (constructor-injected in a use case, or `diContainer.cradle.metricsRecorder` in a plugin):

   ```ts
   metricsRecorder.incrementUsersCreated();
   ```

No change to `container.ts` is needed: `metricsRecorder`/`metricsExposition` already resolve to the
one `PrometheusMetricsRecorder` singleton, which now satisfies the widened port, and the new counter
appears in the next scrape automatically.

## Design decisions & trade-offs

- **Two ports (recorder vs. exposition), one adapter.** Recording and rendering are unrelated
  capabilities used by unrelated callers, so they are separate interfaces (ISP): the `onResponse`
  hook needs only `observeHttpRequest`, the route needs only `render`/`contentType`. This keeps each
  consumer's dependency minimal and each independently mockable — the plugin test stubs only
  `observeHttpRequest`, the route test only `render`/`contentType`. A single adapter implements both
  because writes and reads must share one registry; `aliasTo('metricsRecorder')` binds the two ports
  to a single singleton so they do.

- **Route _template_ as the label, sentinel for unmatched paths.** `request.routeOptions.url` yields
  `/users/:id`, never `/users/42`. Labelling with the concrete path would explode Prometheus label
  cardinality — one time series per distinct id — and exhaust the collector's memory. For the same
  reason 404s that match no route collapse to the bounded `'__unmatched__'` sentinel, so an attacker
  probing random URLs cannot mint unbounded series. Both behaviours are pinned by tests.

- **A private `Registry` per instance, not prom-client's global default.** `PrometheusMetricsRecorder`
  constructs `new Registry()` and registers everything on it. prom-client's default registry is
  process-wide singleton state that throws on duplicate metric registration; a second `buildApp()`
  (integration tests, or running two apps in one process) would then crash. A per-instance registry
  isolates each recorder — guarded by the "keeps a separate registry per instance" test.

- **`fastify-plugin` to escape encapsulation.** Wrapping the plugin in `fp(...)` installs the
  `onResponse` hook on the root app so it observes _every_ route. A plain (encapsulated) plugin would
  only see requests to routes registered within its own scope, silently missing the rest of the API.

- **Recording reads the root container; the route reads the request scope.** The hook resolves
  `diContainer.cradle.metricsRecorder` while the route resolves `request.diScope.cradle.metricsExposition`.
  Because both are the same aliased singleton, this does not change _what_ is observed; resolving the
  singleton from the app-level container in the response hook keeps recording independent of any
  request-scope lifecycle.

- **Web-latency-tuned histogram buckets.** The explicit buckets — `0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10` seconds — bracket typical API response times, so the histogram yields
  meaningful p50/p95/p99 quantiles for this workload rather than the coarser prom-client defaults. The
  cost is that these bucket boundaries are fixed in code and would need editing for a very different
  latency profile.

- **The whole feature is gated by one flag, default on.** `METRICS_ENABLED` toggles both recording and
  exposure together, so there is never a half-on state (recording with nothing to scrape, or vice
  versa). It defaults to true because the metrics are cheap and operationally essential; turning it off
  removes the hook and the endpoint entirely.

- **The endpoint is public and rate-limit-exempt — network is the boundary.** Scrapers poll
  frequently and carry no application credentials, so (like the health probes) `/metrics` is
  unauthenticated and sets `rateLimit: false` to avoid `429`s a collector would misread as an outage.
  The trade-off is that `/metrics` is world-readable wherever it is reachable and leaks operational
  detail (route templates, latencies, process internals); it must therefore be protected at the
  network layer rather than exposed on the public internet.

## Testing

Three co-located unit-test files cover the feature; run them with `npm test` (Vitest), or the full
gate with `npm run audit`.

- **`src/infrastructure/observability/prometheus-metrics-recorder.test.ts`** — the adapter in
  isolation. Asserts that `contentType` contains `text/plain`; that a rendered snapshot includes the
  default process metrics (`process_cpu_user_seconds_total`); that an observed request appears under
  `http_request_duration_seconds_count` with `route="/users/:id"` and `status_code="200"`; and that
  two instances keep separate registries (metrics recorded on one do not leak into the other's output).

- **`src/presentation/http/plugins/metrics.test.ts`** — the recording hook. Builds a minimal Fastify
  app with a mocked `MetricsRecorder` and injects requests. Asserts that a hit on `GET /things/42`
  records `{ method: 'GET', route: '/things/:id', statusCode: 200 }` with a numeric `durationSeconds`
  (the matched _template_, not the raw URL), and that an unmatched path records `route: '__unmatched__'`
  with `statusCode: 404`.

- **`src/presentation/http/routes/metrics-routes.test.ts`** — the scrape endpoint. With a stub
  `MetricsExposition`, asserts `GET /metrics` returns `200`, a `Content-Type` containing `text/plain`,
  and a body containing `http_request_duration_seconds`.

Run only this feature's suites:

```bash
npx vitest run \
  src/infrastructure/observability/prometheus-metrics-recorder.test.ts \
  src/presentation/http/plugins/metrics.test.ts \
  src/presentation/http/routes/metrics-routes.test.ts
```
