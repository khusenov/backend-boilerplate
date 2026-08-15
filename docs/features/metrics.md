# Metrics

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `5156995`

## Purpose

Operators need to see how the service behaves under load — request throughput, the latency
distribution, error rates, and process health (CPU, memory, event-loop lag, garbage collection) —
and they need it as time-series data a monitoring system can scrape on a schedule, not as log noise
or a bespoke dashboard. This feature publishes those signals in the **Prometheus text exposition
format** — a line-oriented plain-text encoding with one metric sample per line
(`name{label="v"} value`) — so any Prometheus-compatible collector can poll them. Because Finflow
runs as **two OS processes** — the HTTP API (`src/main.ts`) and the [background-jobs
worker](./background-jobs.md) (`src/worker.ts`) — there are **two scrape surfaces**: `GET /metrics`
on the API process and `GET /metrics` on the worker process. The API additionally records a latency
histogram for **every** HTTP response automatically. All of it sits behind ports, so application and
presentation code never import the metrics library directly.

## How it works

**Recording (API process, on every HTTP response).** `metricsPlugin` is wrapped in `fastify-plugin`
(`fp(...)`), which deliberately breaks Fastify's plugin encapsulation so the hook it registers is
installed on the **root** instance and therefore fires for every request the app serves — not just
for routes declared inside the plugin. The hook is an `onResponse` hook; when a response finishes it
resolves the app-level `metricsRecorder` from `diContainer.cradle` and calls
`observeHttpRequest(...)` with:

- `method` — `request.method`;
- `route` — `request.routeOptions.url`, the **matched route template** (e.g. `/v1/users/:id`, not
  the concrete `/v1/users/42`), falling back to the sentinel `'__unmatched__'`
  (`UNMATCHED_ROUTE_LABEL`) when no route matched (a 404);
- `statusCode` — `reply.statusCode`;
- `durationSeconds` — `reply.elapsedTime / 1000` (Fastify reports elapsed time in milliseconds; the
  plugin's `MILLISECONDS_PER_SECOND` constant converts it to the seconds Prometheus expects).

The bound recorder, `PrometheusMetricsRecorder`, observes that sample into a `prom-client`
`Histogram` named `http_request_duration_seconds`, labelled `method`, `route`, and `status_code`
(note the `statusCode` field maps to the `status_code` label), using the explicit second-valued
buckets in `HTTP_REQUEST_DURATION_BUCKETS_SECONDS`. The recorder's constructor also calls
`collectDefaultMetrics({ register: this.registry })`, adding prom-client's standard Node/process
metrics (CPU, memory, event-loop lag, GC, open handles) to the same private `Registry`.

**Exposing from the API process.** `buildApp` (`src/presentation/http/app.ts`) registers
`metricsRoutes` with `{ prefix: '/metrics' }`, so the endpoint is `GET /metrics` at the **root** of
the API — a sibling of `/health`, **not** versioned under `/v1` (the `API_V1_PREFIX` from
`src/presentation/http/api-version.ts` applies only to `apiV1Routes`). The handler resolves
`metricsExposition` from the request's Awilix scope (`request.diScope.cradle`), sets the response
`Content-Type` to `metricsExposition.contentType` (prom-client's
`text/plain; version=0.0.4; charset=utf-8`), and sends `await metricsExposition.render()` — the
entire registry serialized as exposition text, carrying both the HTTP histogram and the default
process metrics. Recording and exposing see the same data because `metricsRecorder` and
`metricsExposition` resolve to the **same singleton** (see [Architecture](#architecture)).

**Exposing from the worker process.** `src/worker.ts` builds its own Awilix container
(`createContainer` + `registerDependencies`) and its own minimal Fastify instance via
`buildHealthApp` (`src/presentation/http/health-app.ts`), passing
`metricsExposition: container.cradle.metricsExposition` and
`metricsEnabled: env.METRICS_ENABLED`. When metrics are enabled, `buildHealthApp` registers
`workerMetricsRoutes` with `{ prefix: '/metrics', metricsExposition }` alongside the
[health probes](./health-checks.md) at `/health`, and the app listens on
`env.HOST:env.WORKER_PORT`. The health app does **not** register `@fastify/awilix`, so
`workerMetricsRoutes` receives the `MetricsExposition` through its plugin options
(`WorkerMetricsRoutesOptions`) instead of a request scope; its handler is otherwise identical —
echo `contentType`, send `render()`. The worker installs no `metricsPlugin` and nothing there calls
`observeHttpRequest`, so the worker's exposition is, in practice, the **default Node process
metrics** for the worker process: the `http_request_duration_seconds` histogram is registered (the
adapter always creates it) but renders only its `# HELP`/`# TYPE` metadata with no series until
something observes into it.

**One instance per process, not per deployment.** The API and the worker each build their own
container, so each holds its own `PrometheusMetricsRecorder` with its own `Registry`. The two
`/metrics` endpoints therefore report **independent processes** — a sample recorded in one can never
appear in the other's output — and a collector must scrape both.

**Gating.** A single flag, `env.METRICS_ENABLED` (default `true`), gates everything: in `app.ts` it
guards both `metricsPlugin` and `metricsRoutes`; in the worker it flows into `buildHealthApp` as
`metricsEnabled` and guards `workerMetricsRoutes`. With it off, no hook is installed and both
`/metrics` endpoints return 404 — the feature contributes zero overhead.

## Architecture

The application layer owns two **ports**: `MetricsRecorder` (the write side — record one
observation) and `MetricsExposition` (the read side — render the current snapshot). Splitting them
honours the Interface Segregation Principle: the response hook depends only on the recorder, the two
scrape routes depend only on the exposition, and none of them knows Prometheus exists. The
infrastructure **adapter**, `PrometheusMetricsRecorder`, implements both ports over `prom-client`.
Concretes bind to ports in exactly one place — `src/container.ts` — where `metricsRecorder` is bound
`asClass(PrometheusMetricsRecorder).singleton()` and `metricsExposition` is
`aliasTo('metricsRecorder')`. The alias is what makes both ports resolve to one shared instance per
container, so data written through the recorder is visible through the exposition. Dependencies
point inward: the presentation-layer plugin and routes depend on the application-layer ports, never
on `prom-client`.

| Component                   | Layer          | Responsibility                                                                                                                           | File                                                              |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `HttpRequestMetric`         | Application    | The recorded sample shape: `method`, `route`, `statusCode`, `durationSeconds`                                                            | `src/application/shared/ports/metrics.ts`                         |
| `MetricsRecorder`           | Application    | Port: `observeHttpRequest(metrics)` — record one HTTP response sample                                                                    | `src/application/shared/ports/metrics.ts`                         |
| `MetricsExposition`         | Application    | Port: `render()` + `contentType` — snapshot the registry as exposition text and name its media type                                      | `src/application/shared/ports/metrics.ts`                         |
| `PrometheusMetricsRecorder` | Infrastructure | Adapter implementing both ports over `prom-client`; owns a private `Registry`, the duration `Histogram`, and the default process metrics | `src/infrastructure/observability/prometheus-metrics-recorder.ts` |
| `metricsPlugin`             | Presentation   | `fastify-plugin` that adds the app-wide `onResponse` hook recording every API response                                                   | `src/presentation/http/plugins/metrics.ts`                        |
| `metricsRoutes`             | Presentation   | API-process `GET /metrics`; resolves the exposition from `request.diScope`, tags it `Metrics`, exempts it from rate limiting             | `src/presentation/http/routes/metrics-routes.ts`                  |
| `workerMetricsRoutes`       | Presentation   | Worker-process `GET /metrics`; receives the exposition via `WorkerMetricsRoutesOptions` plugin options                                   | `src/presentation/http/routes/worker-metrics-routes.ts`           |
| `buildHealthApp`            | Presentation   | Worker's minimal Fastify app; mounts `workerMetricsRoutes` at `/metrics` when `metricsEnabled`                                           | `src/presentation/http/health-app.ts`                             |

> Metrics is one of two observability pillars in `src/infrastructure/observability/`; distributed
> tracing ([tracing.md](./tracing.md), OpenTelemetry) is a separate feature with its own
> configuration. The worker's `/health/live` and `/health/ready` probes served by the same
> `buildHealthApp` belong to [health-checks.md](./health-checks.md).

## Public surface

The feature exposes one HTTP endpoint per process and two ports.

**Endpoints.**

| Method | Path       | Process (listen address)                     | Auth          | Purpose                                                                                        |
| ------ | ---------- | -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `GET`  | `/metrics` | API — `HOST:PORT` (default `8000`)           | None (public) | Render the API process's exposition: default process metrics + `http_request_duration_seconds` |
| `GET`  | `/metrics` | Worker — `HOST:WORKER_PORT` (default `8001`) | None (public) | Render the worker process's exposition: default process metrics (no HTTP samples)              |

Both endpoints are mounted at the root, **not** under `/v1`, and exist only while `METRICS_ENABLED`
is true (otherwise `404`). Both are **unauthenticated** — no `authenticate` preHandler. The API
route is additionally **rate-limit-exempt**: its `onRoute` hook sets `rateLimit: false` (so a
collector polling every few seconds is never throttled by the API's global limiter) and tags the
route `Metrics` for the OpenAPI document. The worker route needs neither, because `buildHealthApp`
registers no rate limiter and no Swagger. A successful scrape returns `200` with
`Content-Type: text/plain; version=0.0.4; charset=utf-8` and the exposition text as the body.

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

All parsed by `envalid` in `src/config/env.ts` and mirrored in `.env.example`.

| Variable          | Default   | Meaning                                                                                                                                                                                  |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED` | `true`    | When true, the API registers `metricsPlugin` + `metricsRoutes` and the worker's health app mounts `workerMetricsRoutes`. When false, nothing is recorded and both `/metrics` return 404. |
| `PORT`            | `8000`    | Port the API process listens on — where the API's `/metrics` is scraped.                                                                                                                 |
| `WORKER_PORT`     | `8001`    | Port the worker's health app listens on — where the worker's `/metrics` is scraped.                                                                                                      |
| `HOST`            | `0.0.0.0` | Bind address for both processes.                                                                                                                                                         |

The metric name, label set, and histogram buckets are code constants in
`PrometheusMetricsRecorder`, not configuration.

## Usage & extension

**Scrape it.** Point a Prometheus collector at both processes. A minimal `scrape_config`:

```yaml
scrape_configs:
  - job_name: finflow-api
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['finflow-api:8000'] # host:PORT of the API process
  - job_name: finflow-worker
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['finflow-worker:8001'] # host:WORKER_PORT of the worker process
```

Because both endpoints are unauthenticated, keep them reachable only from the monitoring network
(bind the services privately, or firewall the path) rather than exposing them publicly.

**Add a new metric.** The registry lives inside the adapter, so a new metric is a change to the port
plus the adapter — the container wiring does not move, because the singleton already backs both
ports. To count how many users are created, for example:

1. Widen the `MetricsRecorder` port in `src/application/shared/ports/metrics.ts`:

   ```ts
   export interface MetricsRecorder {
     observeHttpRequest(metrics: HttpRequestMetric): void;
     incrementUsersCreated(): void;
   }
   ```

2. Implement it in `PrometheusMetricsRecorder`
   (`src/infrastructure/observability/prometheus-metrics-recorder.ts`), registering the new metric
   on the same private registry so the existing endpoints render it:

   ```ts
   import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
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
     private readonly usersCreated: Counter;

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

       this.usersCreated = new Counter({
         name: 'users_created_total',
         help: 'Total number of users created.',
         registers: [this.registry],
       });
     }

     get contentType(): string {
       return this.registry.contentType;
     }

     observeHttpRequest({ method, route, statusCode, durationSeconds }: HttpRequestMetric): void {
       this.httpRequestDuration.observe(
         { method, route, status_code: statusCode },
         durationSeconds,
       );
     }

     incrementUsersCreated(): void {
       this.usersCreated.inc();
     }

     render(): Promise<string> {
       return this.registry.metrics();
     }
   }
   ```

3. Call it where the event happens. In a use case, declare `metricsRecorder` in the deps interface
   and destructure it in the constructor, the same pattern `CreateUser` uses for its ports
   (`src/application/user/create-user.ts`); Awilix's `PROXY` injection supplies it with no
   `container.ts` change. In a Fastify plugin, resolve `diContainer.cradle.metricsRecorder` directly,
   as `metricsPlugin` does. Then:

   ```ts
   this.metricsRecorder.incrementUsersCreated();
   ```

The new counter appears on the next scrape automatically. Remember visibility is **per process**: a
metric incremented by a [background-job handler](./background-jobs.md) shows up on the worker's
`/metrics`, one incremented in a request path on the API's.

## Design decisions & trade-offs

- **Two ports (recorder vs. exposition), one adapter.** Recording and rendering are unrelated
  capabilities used by unrelated callers, so they are separate interfaces (ISP): the `onResponse`
  hook needs only `observeHttpRequest`; the routes need only `render`/`contentType`. This keeps each
  consumer's dependency minimal and each independently mockable — the plugin test stubs only
  `observeHttpRequest`, the route tests only `render`/`contentType`. A single adapter implements
  both because writes and reads must share one registry; `aliasTo('metricsRecorder')` binds the two
  ports to a single singleton so they do.

- **A scrape endpoint per process, not push or aggregation.** Registries are in-process objects: the
  worker's samples physically cannot appear in the API's exposition. Rather than adding a Prometheus
  Pushgateway or an aggregation layer, each process exposes its own pull endpoint — the worker
  piggybacks on the health app it already runs on `WORKER_PORT` — matching Prometheus's native
  pull model and keeping per-process metrics (memory, event-loop lag) attributable. The cost is one
  scrape target per process, and that fleet-wide views must be aggregated in PromQL.

- **Two route plugins instead of one reused route.** `metricsRoutes` resolves the exposition from
  `request.diScope.cradle`, which requires `@fastify/awilix` — a plugin the worker's health app
  deliberately does not register (it must stay minimal and boot even while worker wiring evolves).
  So `workerMetricsRoutes` takes the `MetricsExposition` as an explicit plugin option instead. The
  cost is two near-identical handlers; the benefit is that the health app carries no DI machinery.

- **Route _template_ as the label, sentinel for unmatched paths.** `request.routeOptions.url` yields
  `/v1/users/:id`, never `/v1/users/42`. Labelling with the concrete path would explode Prometheus
  label cardinality — one time series per distinct id — and exhaust the collector's memory. For the
  same reason 404s that match no route collapse to the bounded `'__unmatched__'` sentinel, so an
  attacker probing random URLs cannot mint unbounded series. Both behaviours are pinned by tests.

- **A private `Registry` per instance, not prom-client's global default.** `PrometheusMetricsRecorder`
  constructs `new Registry()` and registers everything on it. prom-client's default registry is
  process-wide singleton state that throws on duplicate metric registration; a second `buildApp()`
  (integration tests, or running two apps in one process) would then crash. A per-instance registry
  isolates each recorder — guarded by the "keeps a separate registry per instance" test.

- **`fastify-plugin` to escape encapsulation.** Wrapping the plugin in `fp(...)` installs the
  `onResponse` hook on the root app so it observes _every_ route. A plain (encapsulated) plugin
  would only see requests to routes registered within its own scope, silently missing the rest of
  the API.

- **Recording reads the root container; the API route reads the request scope.** The hook resolves
  `diContainer.cradle.metricsRecorder` while the route resolves
  `request.diScope.cradle.metricsExposition`. Because both are the same aliased singleton, this does
  not change _what_ is observed; resolving from the app-level container in the response hook keeps
  recording independent of any request-scope lifecycle.

- **Web-latency-tuned histogram buckets.** The explicit buckets — `0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10` seconds — bracket typical API response times, so the histogram yields
  meaningful p50/p95/p99 quantiles for this workload rather than the coarser prom-client defaults.
  The cost is that these bucket boundaries are fixed in code and would need editing for a very
  different latency profile.

- **One flag gates both processes, default on.** `METRICS_ENABLED` toggles recording and both
  endpoints together, so there is never a half-on state (recording with nothing to scrape, or a
  scrapable worker but a dark API). It defaults to true because the metrics are cheap and
  operationally essential; turning it off removes the hook and both endpoints entirely — the
  worker's health probes stay up regardless.

- **The endpoints are public and (on the API) rate-limit-exempt — network is the boundary.**
  Scrapers poll frequently and carry no application credentials, so like the health probes,
  `/metrics` is unauthenticated, and the API route sets `rateLimit: false` to avoid `429`s a
  collector would misread as an outage. The trade-off is that `/metrics` is world-readable wherever
  it is reachable and leaks operational detail (route templates, latencies, process internals); it
  must be protected at the network layer rather than exposed on the public internet.

## Testing

Five co-located unit-test files plus one integration test cover the feature. Run the unit suites
with `npm test` (Vitest), the integration suite with `npm run test:integration` (needs Docker; see
`test/integration/`), or the full gate with `npm run audit`.

- **`src/infrastructure/observability/prometheus-metrics-recorder.test.ts`** — the adapter in
  isolation. Asserts that `contentType` contains `text/plain`; that a rendered snapshot includes the
  default process metrics (`process_cpu_user_seconds_total`); that an observed request appears under
  `http_request_duration_seconds_count` with `route="/users/:id"` and `status_code="200"`; and that
  two instances keep separate registries (samples recorded on one do not leak into the other's
  output).

- **`src/presentation/http/plugins/metrics.test.ts`** — the recording hook. Builds a minimal Fastify
  app with a mocked `MetricsRecorder` and injects requests. Asserts that a hit on `GET /things/42`
  records `{ method: 'GET', route: '/things/:id', statusCode: 200 }` with a numeric
  `durationSeconds` (the matched _template_, not the raw URL), and that an unmatched path records
  `route: '__unmatched__'` with `statusCode: 404`.

- **`src/presentation/http/routes/metrics-routes.test.ts`** — the API scrape endpoint. With a stub
  `MetricsExposition` registered in the DI container, asserts `GET /metrics` returns `200`, a
  `Content-Type` containing `text/plain`, and a body containing `http_request_duration_seconds`.

- **`src/presentation/http/routes/worker-metrics-routes.test.ts`** — the worker scrape endpoint.
  With a stub `MetricsExposition` passed as plugin options, asserts the route echoes the stub's
  exact `contentType` and body.

- **`src/presentation/http/health-app.test.ts`** — the worker app's mounting rules. Asserts
  `GET /metrics` serves the exposition when `metricsEnabled: true`, and returns `404` — while
  `/health/live` keeps working — when `metricsEnabled: false`.

- **`test/integration/metrics.int.test.ts`** — end to end through the real container: builds the
  full app with `buildApp`, hits `GET /health/live`, then scrapes `GET /metrics` and asserts the
  exposition includes `http_request_duration_seconds` with a `route="/health/live"` sample —
  proving hook, adapter, alias wiring, and route work together.

Run only this feature's unit suites:

```bash
npx vitest run \
  src/infrastructure/observability/prometheus-metrics-recorder.test.ts \
  src/presentation/http/plugins/metrics.test.ts \
  src/presentation/http/routes/metrics-routes.test.ts \
  src/presentation/http/routes/worker-metrics-routes.test.ts \
  src/presentation/http/health-app.test.ts
```
