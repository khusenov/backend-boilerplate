# Metrics

> **Status:** Complete · **Layers:** application, infrastructure, presentation, composition root · **Verified against:** `7150871`

## Purpose

Operators need to see how the service behaves under load — request throughput, the latency
distribution, error rates, and process health (CPU, memory, event-loop lag, garbage collection) —
and they need it as time-series data a monitoring system can scrape on a schedule, not as log noise
or a bespoke dashboard. This feature publishes those signals in the **Prometheus text exposition
format** — a line-oriented plain-text encoding with one metric sample per line
(`name{label="v"} value`) — so any Prometheus-compatible collector can poll them. Because the app
runs as **two OS processes** — the HTTP API (`src/main.ts`) and the [background-jobs
worker](./background-jobs.md) (`src/worker.ts`) — there are **two scrape surfaces**: `GET /metrics`
on the API process and `GET /metrics` on the worker process. The API additionally records a latency
histogram for **every** HTTP response automatically. All of it sits behind ports, so application and
presentation code never import the metrics library directly.

## How it works

**Bootstrap.** Both entry points build one Awilix container with `createAppContainer(baseLogger)`
(`src/container.ts`), which creates a container from the shared `APP_CONTAINER_OPTIONS`
(`src/container-options.ts` — `injectionMode: InjectionMode.PROXY`, `strict: true`) and registers
everything `createRegistrations(baseLogger)` returns, including `metricsRegistrations`. The API then
passes that container to `buildApp({ container, ... })` — the HTTP application factory owned by
[HTTP Infrastructure](./http-infrastructure.md), which is where this feature's plugin and route get
registered. The worker passes individual **cradle** members to `buildHealthApp({ ... })`; the cradle
is Awilix's proxy object that resolves a registration by property name, so
`container.cradle.metricsRecorder` constructs (or returns) the singleton bound under that key.
Nothing in the feature reaches for a module-global container.

**Recording (API process, on every HTTP response).** When `env.METRICS_ENABLED` is true, `buildApp`
registers the recording hook and hands it its dependency explicitly:

```ts
if (env.METRICS_ENABLED) {
  await app.register(metricsPlugin, { metricsRecorder: container.cradle.metricsRecorder });
}
```

`metricsPlugin` is declared `fp<MetricsPluginOptions>((app, { metricsRecorder }) => { ... })`. The
`fastify-plugin` wrapper (`fp`) deliberately breaks Fastify's plugin encapsulation so the hook it
adds is installed on the **root** instance and therefore fires for every request the app serves —
not just for routes declared inside the plugin. ([HTTP Infrastructure](./http-infrastructure.md)
explains encapsulation and the `fp` escape hatch in full.) The recorder is destructured **once, at
registration time**, and captured by the closure; the `onResponse` hook then calls
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
metrics (CPU, memory, event-loop lag, GC, active handles) to the same private `Registry`.

**Exposing from the API process.** `buildApp` (`src/presentation/http/app.ts`) registers
`metricsRoutes` with `{ prefix: '/metrics' }`, so the endpoint is `GET /metrics` at the **root** of
the API — a sibling of `/health`, **not** versioned under `/v1` (the `API_V1_PREFIX` from
`src/presentation/http/api-version.ts` applies only to `apiV1Routes`; see
[HTTP Infrastructure](./http-infrastructure.md) for the URL layout rule). The handler resolves
`metricsExposition` from the request's Awilix scope (`request.diScope.cradle`), sets the response
`Content-Type` to `metricsExposition.contentType` (prom-client's
`text/plain; version=0.0.4; charset=utf-8`), and sends `await metricsExposition.render()` — the
entire registry serialized as exposition text, carrying both the HTTP histogram and the default
process metrics. Recording and exposing see the same data because `metricsRecorder` and
`metricsExposition` resolve to the **same singleton** (see [Architecture](#architecture)).

**Exposing from the worker process.** `src/worker.ts` calls `createAppContainer(logger)` and builds
its own minimal Fastify instance via `buildHealthApp` (`src/presentation/http/health-app.ts`),
passing `metricsExposition: container.cradle.metricsExposition` and
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

**One instance per process, not per deployment.** The API and the worker each call
`createAppContainer`, so each holds its own `PrometheusMetricsRecorder` with its own `Registry`. The
two `/metrics` endpoints therefore report **independent processes** — a sample recorded in one can
never appear in the other's output — and a collector must scrape both.

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
Concretes bind to ports in exactly one place — the composition module `src/composition/metrics.ts`,
one of the per-module registration units that `createRegistrations` (`src/composition/compose.ts`)
merges into the container — where `metricsRecorder` is bound `asClass(PrometheusMetricsRecorder).singleton()`
and `metricsExposition` is `aliasTo<MetricsExposition>('metricsRecorder')`. The alias is what makes
both ports resolve to one shared instance per container, so data written through the recorder is
visible through the exposition. That module also carries the `declare module '@fastify/awilix'`
augmentation that adds both keys to the typed `Cradle`. Dependencies point inward: the
presentation-layer plugin and routes depend on the application-layer ports, never on `prom-client`.

| Component                   | Layer            | Responsibility                                                                                                                           | File                                                              |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `HttpRequestMetric`         | Application      | The recorded sample shape: `method`, `route`, `statusCode`, `durationSeconds`                                                            | `src/application/shared/ports/metrics.ts`                         |
| `MetricsRecorder`           | Application      | Port: `observeHttpRequest(metrics)` — record one HTTP response sample                                                                    | `src/application/shared/ports/metrics.ts`                         |
| `MetricsExposition`         | Application      | Port: `render()` + `contentType` — snapshot the registry as exposition text and name its media type                                      | `src/application/shared/ports/metrics.ts`                         |
| `PrometheusMetricsRecorder` | Infrastructure   | Adapter implementing both ports over `prom-client`; owns a private `Registry`, the duration `Histogram`, and the default process metrics | `src/infrastructure/observability/prometheus-metrics-recorder.ts` |
| `metricsRegistrations`      | Composition root | Binds `metricsRecorder` to the adapter as a singleton and aliases `metricsExposition` onto it                                            | `src/composition/metrics.ts`                                      |
| `metricsPlugin`             | Presentation     | `fastify-plugin` that adds the app-wide `onResponse` hook; takes its `MetricsRecorder` as a `MetricsPluginOptions` plugin option         | `src/presentation/http/plugins/metrics.ts`                        |
| `metricsRoutes`             | Presentation     | API-process `GET /metrics`; resolves the exposition from `request.diScope`, tags it `Metrics`, exempts it from rate limiting             | `src/presentation/http/routes/metrics-routes.ts`                  |
| `workerMetricsRoutes`       | Presentation     | Worker-process `GET /metrics`; receives the exposition via `WorkerMetricsRoutesOptions` plugin options                                   | `src/presentation/http/routes/worker-metrics-routes.ts`           |
| `buildHealthApp`            | Presentation     | Worker's minimal Fastify app; mounts `workerMetricsRoutes` at `/metrics` when `metricsEnabled`                                           | `src/presentation/http/health-app.ts`                             |
| `createAppContainer`        | Composition root | Builds the per-process container both entry points hand to `buildApp` / `buildHealthApp`                                                 | `src/container.ts`                                                |

> Metrics is one of two observability pillars in `src/infrastructure/observability/`;
> [Distributed Tracing](./tracing.md) (OpenTelemetry) is a separate feature with its own
> configuration. The worker's `/health/live` and `/health/ready` probes served by the same
> `buildHealthApp` belong to [Health Checks](./health-checks.md).

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

**Metrics exposed.** Everything below is registered on the recorder's private `Registry`, so both
scrape endpoints render the whole set for their own process.

| Metric                                 | Type                                    | Labels                                                                                                          | Help                                             | Buckets / notes                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_request_duration_seconds`        | Histogram                               | `method`, `route`, `status_code`                                                                                | `Duration of inbound HTTP requests in seconds.`  | `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` seconds, plus prom-client's implicit `+Inf`                                                                                                                                                                                                                                                                                                   |
| `process_*` / `nodejs_*` (default set) | Counters and gauges, plus one histogram | Mostly unlabelled; `nodejs_heap_space_size_*_bytes` carry `space`, `nodejs_version_info` carries version labels | prom-client's own help strings, emitted verbatim | Added by `collectDefaultMetrics`: `process_cpu_*_seconds_total`, `process_resident_memory_bytes`, `process_start_time_seconds`, `nodejs_eventloop_lag_*_seconds`, `nodejs_heap_*_bytes`, `nodejs_active_{handles,requests,resources}*`, `nodejs_gc_duration_seconds`, `nodejs_version_info`. The exact family list is platform-dependent (for example the file-descriptor gauges only appear on Linux). |

A Prometheus histogram is not a single series. `http_request_duration_seconds` renders as
`http_request_duration_seconds_bucket{le="…"}` — one cumulative counter per bucket boundary and one
for `+Inf` — plus `http_request_duration_seconds_sum` and `http_request_duration_seconds_count`, each
carrying the full label set. `_bucket` is what `histogram_quantile()` reads for p50/p95/p99;
`_sum / _count` gives the mean.

**Ports.** Inner code programs against these; both are registered in the Awilix container.

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

**Plugin option contracts.** Two presentation components declare their dependency as an option
object rather than resolving it themselves:

```ts
export interface MetricsPluginOptions {
  metricsRecorder: MetricsRecorder;
}

export interface WorkerMetricsRoutesOptions {
  metricsExposition: MetricsExposition;
}
```

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
  - job_name: app-api
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['app:8000'] # host:PORT of the API process
  - job_name: app-worker
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['worker:8001'] # host:WORKER_PORT of the worker process
```

Because both endpoints are unauthenticated, keep them reachable only from the monitoring network
(bind the services privately, or firewall the path) rather than exposing them publicly.

> **The local compose stack does not collect metrics.** `docker-compose.yml` ships Tempo, Loki,
> Grafana Alloy, and Grafana, and `docker/alloy/config.alloy` contains only `discovery.docker`,
> `loki.source.docker`, `loki.process`, and `loki.write` components — **no `prometheus.scrape`** —
> while `docker/grafana/provisioning/datasources/` provisions only Loki and Tempo. So locally you get
> logs (Alloy → Loki) and traces (Tempo), but nothing polls `/metrics`. Both endpoints are still live
> and can be curled directly (`curl localhost:8000/metrics`, `curl localhost:8001/metrics`); wiring a
> real dashboard means adding a Prometheus (or Grafana Mimir) service, an equivalent
> `prometheus.scrape` component in Alloy, and a matching Grafana datasource.

### Which way to obtain the recorder

The container is the only source of the adapter. This feature makes two different choices, one per
consumer, and the split is about **lifetime**:

| Consumer                            | How it gets the dependency                                  | Why                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `metricsPlugin` (`onResponse` hook) | **Pushed in** as a plugin option by `buildApp`              | The plugin is registered once at boot; the singleton already exists, so resolve it once and close over it |
| `metricsRoutes` (route handler)     | **Pulled** from `request.diScope.cradle` inside the handler | The handler runs per request, in a per-request Awilix scope created by `@fastify/awilix`                  |

This is the house rule for every Fastify plugin and route in the codebase, not a metrics-specific
invention; [HTTP Infrastructure](./http-infrastructure.md) states it once and owns it. Note that
neither form is **service location** — a component reaching into a global registry at call time, so
that its dependencies appear nowhere in its type. Both forms here keep the dependency in the
signature: the plugin's in `MetricsPluginOptions`, the handler's in the request scope Fastify hands
it. A use case in `src/application/**` takes the recorder a third way — as a constructor parameter
on its `…Deps` interface, which Awilix `PROXY` injection fills by name (see
[Add a new metric](#add-a-new-metric)).

**Consume the recorder from a plugin (registration-time).** Declare an options interface, destructure
it in the plugin factory, and let the composition site supply it. Use a **distinct** recorder method,
not `observeHttpRequest`:

```ts
// src/presentation/http/plugins/slow-request-counter.ts
import fp from 'fastify-plugin';
import type { MetricsRecorder } from '@/application/shared/ports/metrics';

export interface SlowRequestCounterOptions {
  metricsRecorder: MetricsRecorder;
}

const SLOW_REQUEST_SECONDS = 1;
const MILLISECONDS_PER_SECOND = 1000;

export const slowRequestCounterPlugin = fp<SlowRequestCounterOptions>(
  (app, { metricsRecorder }) => {
    app.addHook('onResponse', (request, reply, done) => {
      if (reply.elapsedTime / MILLISECONDS_PER_SECOND >= SLOW_REQUEST_SECONDS) {
        metricsRecorder.incrementSlowRequests();
      }
      done();
    });
  },
);
```

> Calling `observeHttpRequest` from a second hook would be a bug, not a variation.
> `metricsRecorder` is a singleton and `metricsPlugin` already observes **every** response into
> `http_request_duration_seconds`; a second observation on the same response adds a second sample to
> the same histogram, inflating `_count` and `_sum` and corrupting the p95/p99 the buckets exist to
> produce. One response, one `observeHttpRequest`. Anything else a hook wants to measure gets its own
> metric and its own port method — `incrementSlowRequests()` above follows the
> [Add a new metric](#add-a-new-metric) recipe.

Then register it in `buildApp` (`src/presentation/http/app.ts`), reading the cradle once:

```ts
await app.register(slowRequestCounterPlugin, {
  metricsRecorder: container.cradle.metricsRecorder,
});
```

**Consume the exposition from a route (per-request).** Take it from the request scope, exactly as
`metricsRoutes` does:

```ts
app.get('/', async (request, reply) => {
  const { metricsExposition } = request.diScope.cradle;
  void reply.header('Content-Type', metricsExposition.contentType);
  return reply.send(await metricsExposition.render());
});
```

### Add a new metric

The registry lives inside the adapter, so a new metric is a change to the port plus the adapter —
the container wiring does not move, because the singleton already backs both ports. To count how
many users are created, for example:

1. Widen the `MetricsRecorder` port in `src/application/shared/ports/metrics.ts`:

   ```ts
   export interface MetricsRecorder {
     observeHttpRequest(metrics: HttpRequestMetric): void;

     incrementUsersCreated(): void;
   }
   ```

2. Add the counter to the existing `PrometheusMetricsRecorder`
   (`src/infrastructure/observability/prometheus-metrics-recorder.ts`). Three edits — a field, a
   `new Counter(...)` in the constructor registering it on the **same private registry** so the
   existing endpoints render it, and the method. Everything already in the class (the `Registry`,
   `collectDefaultMetrics`, the `httpRequestDuration` histogram, `contentType`, `observeHttpRequest`,
   `render`) stays exactly as it is; widen the `prom-client` import to include `Counter`:

   ```ts
   private readonly usersCreated: Counter;
   ```

   ```ts
   this.usersCreated = new Counter({
     name: 'users_created_total',
     help: 'Total number of users created.',
     registers: [this.registry],
   });
   ```

   ```ts
   incrementUsersCreated(): void {
     this.usersCreated.inc();
   }
   ```

3. Call it where the event happens. In a use case, add `metricsRecorder` to the deps interface and
   destructure it in the constructor — the pattern `CreateUser` uses for its ports
   (`src/application/user/create-user.ts`). Awilix `PROXY` injection resolves it by name, so
   `src/composition/user.ts` needs no change. `CreateUser` already takes **five** dependencies; you
   are adding a sixth alongside them, not replacing them, so every existing field, destructured name,
   and assignment stays:

   ```ts
   import type { MetricsRecorder } from '@/application/shared/ports/metrics';

   export interface CreateUserDeps {
     unitOfWork: UnitOfWork;
     userRepository: UserRepository;
     passwordHasher: PasswordHasher;
     idGenerator: IdGenerator;
     clock: Clock;
     metricsRecorder: MetricsRecorder;
   }

   export class CreateUser {
     private readonly uow: UnitOfWork;
     private readonly users: UserRepository;
     private readonly hasher: PasswordHasher;
     private readonly ids: IdGenerator;
     private readonly clock: Clock;
     private readonly metrics: MetricsRecorder;

     constructor({
       unitOfWork,
       userRepository,
       passwordHasher,
       idGenerator,
       clock,
       metricsRecorder,
     }: CreateUserDeps) {
       this.uow = unitOfWork;
       this.users = userRepository;
       this.hasher = passwordHasher;
       this.ids = idGenerator;
       this.clock = clock;
       this.metrics = metricsRecorder;
     }

     // execute(...) unchanged
   }
   ```

   Then call `this.metrics.incrementUsersCreated();` inside `execute` once the user is persisted.
   From a Fastify plugin, use the plugin-option form shown above; from a route handler, use
   `request.diScope.cradle`.

The new counter appears on the next scrape automatically. Remember visibility is **per process**: a
metric incremented by a [background-job handler](./background-jobs.md) shows up on the worker's
`/metrics`, one incremented in a request path on the API's.

## Design decisions & trade-offs

- **Two ports (recorder vs. exposition), one adapter.** Recording and rendering are unrelated
  capabilities used by unrelated callers, so they are separate interfaces (ISP): the `onResponse`
  hook needs only `observeHttpRequest`; the routes need only `render`/`contentType`. This keeps each
  consumer's dependency minimal and each independently mockable — the plugin test stubs only
  `observeHttpRequest`, the route tests only `render`/`contentType`. A single adapter implements
  both because writes and reads must share one registry; `aliasTo<MetricsExposition>('metricsRecorder')`
  binds the two ports to a single singleton so they do.

- **The recording hook takes its recorder as a plugin option; the scrape route still pulls from the
  request scope.** `metricsPlugin` is typed `fp<MetricsPluginOptions>` and destructures
  `{ metricsRecorder }`; `buildApp` supplies `container.cradle.metricsRecorder` at registration.
  The alternative — reading the module-global `diContainer.cradle.metricsRecorder` inside the hook —
  would give the plugin a hidden dependency (invisible in its type), a hard coupling to one
  process-wide container instance, and an Awilix `PROXY` trap plus a registration lookup on **every
  HTTP response**. Pushing the dependency in keeps that resolution out of the hot path — one lookup
  at boot instead of one per response — and lets the plugin's unit test build a bare Fastify app with a
  `vi.fn()` stub and no container at all. `metricsRoutes`, by contrast, keeps reading
  `request.diScope.cradle` inside the handler: a handler that captured a singleton at registration
  time would lose access to anything request-scoped, and stops being correct the moment one of its
  dependencies becomes per-request. The general push-vs-pull rule belongs to
  [HTTP Infrastructure](./http-infrastructure.md); the cost here is one extra line at the composition
  site in `buildApp`, and that line is the point — the wiring is visible where wiring belongs.

- **One container factory, one options object.** `createAppContainer(baseLogger)` is the single way
  a process obtains a wired container, and `APP_CONTAINER_OPTIONS` (`src/container-options.ts`) is
  the single definition of `injectionMode: InjectionMode.PROXY` + `strict: true`, declared
  `as const satisfies ContainerOptions` so the shape is checked at compile time. `main.ts`,
  `worker.ts`, and the integration harness (`test/integration/support/harness.ts`) all go through
  `createAppContainer`, and the unit-test helper `registerTestContainer`
  (`test/unit/support/container.ts`) reuses `APP_CONTAINER_OPTIONS` directly with
  `createContainer<Cradle>(...)` — it deliberately skips `createRegistrations` so a unit test can
  register just the one or two stubs it needs. Either way a test container resolves the way
  production does, and `buildApp` can be handed any container instance rather than mutating a global
  one.

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
  process-wide singleton state that throws on duplicate metric registration; a second container
  (integration tests, or running two apps in one process) would then crash. A per-instance registry
  isolates each recorder — guarded by the "keeps a separate registry per instance" test.

- **`fastify-plugin` to escape encapsulation.** Wrapping the plugin in `fp(...)` installs the
  `onResponse` hook on the root app so it observes _every_ route. A plain (encapsulated) plugin
  would only see requests to routes registered within its own scope, silently missing the rest of
  the API.

- **Web-latency-tuned histogram buckets.** The explicit buckets — `0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10` seconds — bracket typical API response times, so the histogram yields
  meaningful p50/p95/p99 quantiles for this workload rather than the coarser prom-client defaults.
  The cost is that these bucket boundaries are fixed in code and would need editing for a very
  different latency profile, and that eleven boundaries × the label set is eleven-plus series per
  `method`/`route`/`status_code` combination.

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

Seven unit-test files (five co-located with the feature's own code, two guarding the container
wiring it depends on) plus one integration test cover the feature. Run the unit suites with
`npm test` (Vitest), the integration suite with `npm run test:integration` (needs Docker; see
`test/integration/`), or the full gate with `npm run audit`. Note that
`src/presentation/http/plugins/**`, `src/container.ts`, and `src/container-options.ts` are inside the
100%-threshold coverage set in `vitest.config.ts`, so the plugin and the container factory must stay
fully covered.

- **`src/infrastructure/observability/prometheus-metrics-recorder.test.ts`** — the adapter in
  isolation. Asserts that `contentType` contains `text/plain`; that a rendered snapshot includes the
  default process metrics (`process_cpu_user_seconds_total`); that an observed request appears under
  `http_request_duration_seconds_count` with `route="/users/:id"` and `status_code="200"`; and that
  two instances keep separate registries (samples recorded on one do not leak into the other's
  output).

- **`src/presentation/http/plugins/metrics.test.ts`** — the recording hook, with **no container
  involved**. Builds a bare Fastify app, registers
  `metricsPlugin, { metricsRecorder: recorder }` where `recorder` is a `vi.fn()` stub satisfying
  `MetricsRecorder`, and injects requests. Asserts that a hit on `GET /things/42` records
  `{ method: 'GET', route: '/things/:id', statusCode: 200 }` with a numeric `durationSeconds` (the
  matched _template_, not the raw URL), and that an unmatched path records `route: '__unmatched__'`
  with `statusCode: 404`.

- **`src/presentation/http/routes/metrics-routes.test.ts`** — the API scrape endpoint, which _does_
  need a container because the handler reads `request.diScope.cradle`. It builds one with the shared
  helper `registerTestContainer(app, { metricsExposition: asValue(metricsExposition) })` from
  `test/unit/support/container.ts`, then asserts `GET /metrics` returns `200`, a `Content-Type`
  containing `text/plain`, and a body containing `http_request_duration_seconds`.

- **`src/presentation/http/routes/worker-metrics-routes.test.ts`** — the worker scrape endpoint.
  With a stub `MetricsExposition` passed as plugin options, asserts the route echoes the stub's
  exact `contentType` and body.

- **`src/presentation/http/health-app.test.ts`** — the worker app's mounting rules. Asserts
  `GET /metrics` serves the exposition when `metricsEnabled: true`, and returns `404` — while
  `/health/live` keeps working — when `metricsEnabled: false`.

- **`src/composition/compose.test.ts`** — pins the alias this whole doc rests on. Its
  "resolves metricsExposition to the metricsRecorder instance" case asserts
  `container.resolve('metricsExposition')` is the very same object as
  `container.resolve('metricsRecorder')`, which is what makes a sample written through the recorder
  visible through the exposition. Without it, `aliasTo` could silently regress into a second
  instance and the API's `/metrics` would render an empty histogram.

- **`src/container.test.ts`** — pins per-container isolation, using `metricsRecorder` as the subject.
  Its "keeps a registration override local to the container it was applied to" case builds two
  containers, overrides `metricsRecorder` with a stub on the first, and asserts the second is
  untouched — the property that lets a test swap the recorder without leaking into another test, and
  the reason the API and worker each own an independent `Registry`. The same file also asserts
  `createAppContainer` returns a fresh container per call and that its options are
  `{ injectionMode: InjectionMode.PROXY, strict: true }`.

- **`test/integration/metrics.int.test.ts`** — end to end through the real container: builds the
  full app with `buildApp({ container: createAppContainer(createBaseLogger(SILENT_LOG_LEVEL)), ... })`,
  hits `GET /health/live`, then scrapes `GET /metrics` and asserts the exposition includes
  `http_request_duration_seconds` with a `route="/health/live"` sample — proving the pushed-in hook,
  adapter, alias wiring, and route work together.

Run only this feature's unit suites:

```bash
npx vitest run \
  src/infrastructure/observability/prometheus-metrics-recorder.test.ts \
  src/presentation/http/plugins/metrics.test.ts \
  src/presentation/http/routes/metrics-routes.test.ts \
  src/presentation/http/routes/worker-metrics-routes.test.ts \
  src/presentation/http/health-app.test.ts \
  src/composition/compose.test.ts \
  src/container.test.ts
```
