# Health Checks

> **Status:** Complete · **Layers:** application, infrastructure, presentation, composition root · **Verified against:** `7150871`

## Purpose

Container orchestrators (Kubernetes, ECS, Nomad) and load balancers need machine-readable signals to
decide two independent things: _is this process alive?_ and _is this process ready to serve?_ This
feature answers both questions for **both deployable processes**. **Liveness** (`GET /health/live`)
reports only that the Node process is up and its event loop can answer; failing it tells the
orchestrator to **restart** the instance. **Readiness** (`GET /health/ready`) additionally verifies
that every critical downstream dependency — the database _and_ the Redis instance that backs
[BullMQ](./background-jobs.md) — is reachable; failing it tells the orchestrator to **drain the
instance from rotation** without killing it, so it rejoins automatically once the dependency
recovers. The API process serves the probes from its main Fastify app; the worker process — a queue
consumer with no business HTTP surface of its own — runs a dedicated minimal health app on
`WORKER_PORT` so it can be probed at all.

## How it works

**The probe surface.** `healthRoutes` (`src/presentation/http/routes/health-routes.ts`) is a Fastify
plugin (`FastifyPluginCallbackZod<HealthRoutesOptions>`) that registers exactly two `GET` routes
under whichever prefix its host mounts it at — `/health` in both processes. It receives its single
dependency — a `HealthCheck` — through its registration options and never reaches into a DI
container or a request scope itself, which is what lets one plugin serve two very different hosts.
The two routes behave differently by design:

- **`GET /health/live`** — the handler is synchronous and returns `{ status: 'ok' }` with HTTP
  `200`. It performs no I/O and never touches the `HealthCheck`; a response at all proves the
  process is up and the event loop is servicing requests. There is no failure body: if the process
  cannot answer, the prober's own connection timeout is the failure signal.
- **`GET /health/ready`** — the handler awaits `healthCheck.check()`. On success it returns
  `{ status: 'ready' }` with `200`. On rejection it logs
  `request.log.error({ err }, 'readiness check failed')` and replies `503` with
  `{ status: 'unavailable' }` — sent directly via `reply.status(503).send(...)`, bypassing the
  application error handler entirely.

An `onRoute` hook inside the plugin tags both routes with the `Health` OpenAPI tag and sets
`rateLimit: false`. In the API app — where [HTTP Infrastructure](./http-infrastructure.md) registers
a global rate limiter — that flag exempts the probes from throttling; the worker's health app
registers no rate limiter, so the flag is inert there.

**What readiness actually checks.** The `HealthCheck` the plugin is handed is never a single probe:
the container binds `healthCheck` to a **`CompositeHealthCheck`**
(`src/infrastructure/health/composite-health-check.ts`), which is itself a `HealthCheck` wrapping
other `HealthCheck`s. Its constructor takes a read-only array of members (and throws
`CompositeHealthCheck requires at least one health check` when given none); `check()` fans those
members out concurrently:

```ts
async check(): Promise<void> {
  await Promise.all(this.checks.map((healthCheck) => healthCheck.check()));
}
```

The **aggregation rule is all-or-nothing**: `Promise.all` resolves only if _every_ member resolves,
and rejects with the _first_ member that rejects, so readiness is healthy only when all member
checks pass. The composite does **not** expose per-member status in the response body — the caller
always sees the fixed `{ status: 'unavailable' }` literal; _which_ dependency failed appears only in
the `readiness check failed` log line. `src/composition/health.ts` composes it from two members:

- **`PrismaHealthCheck`** (`src/infrastructure/persistence/prisma-health-check.ts`) runs the raw
  query `SELECT 1` through the shared Prisma client (`this.prisma.$queryRaw`). It confirms the pool
  can acquire a working connection without depending on any table or row; if the database is
  unreachable, the query rejects.
- **`RedisHealthCheck`** (`src/infrastructure/jobs/redis-health-check.ts`) issues `PING` on a
  dedicated Redis connection and expects the reply `PONG` (the `HEALTHY_PING_REPLY` constant); any
  other reply throws `unexpected Redis PING reply: <reply>`. The call is raced against a
  `healthCheckTimeoutMs` timer, so a hung Redis rejects with
  `Redis health check timed out after <ms>ms` instead of stalling the request; the timer is always
  cleared in a `finally`.

**How each host wires the plugin.**

- **API process** — `src/main.ts` → `buildApp` (`src/presentation/http/app.ts`). `bootstrap()`
  builds the container, then calls
  `buildApp({ container, disableRequestLogging: env.isDevelopment })`. `BuildAppOptions.container`
  is **required**: the app never sources a container of its own. `buildApp` hands that instance to
  `fastifyAwilixPlugin`
  (`{ container, disposeOnClose: true, disposeOnResponse: true, strictBooleanEnforced: true }`),
  which is what gives the rest of the API its per-request resolution through `app.diContainer` and
  `request.diScope.cradle`. The health plugin uses neither; it is registered with the value resolved
  once at boot from the container's **cradle** — Awilix's proxy object that resolves a registration
  by property name:

  ```ts
  await app.register(healthRoutes, {
    prefix: '/health',
    healthCheck: container.cradle.healthCheck,
  });
  ```

  The app listens on `HOST`:`PORT` (default `8000`). The prefix sits at the **root**, outside
  `API_V1_PREFIX` (`'/v1'`, `src/presentation/http/api-version.ts`), so the probe paths are
  **unversioned**: `/health/live`, not `/v1/health/live`.

  Two side effects of hosting the probes inside the full API app are worth knowing before tuning
  poll intervals. **Request logging is asymmetric between the two hosts:** `src/main.ts` passes
  `disableRequestLogging: env.isDevelopment` into the very `buildApp` call that mounts `/health/*`,
  so probe polls are silent only in development — under `NODE_ENV=test` or `production` every poll
  writes a request line and a response line, while the worker's health app hard-codes
  `disableRequestLogging: true` and never logs one. **And probe traffic is measured:** when
  `METRICS_ENABLED` is true, `metricsPlugin`'s app-wide `onResponse` hook records every response, so
  API probe polls appear in `http_request_duration_seconds` with `route="/health/live"` and
  `route="/health/ready"`; the worker's health app registers no `metricsPlugin`, so its polls
  produce no HTTP metrics at all. See [Metrics](./metrics.md).

  **On shutdown, readiness does not pre-fail.** `src/main.ts` registers
  `registerGracefulShutdown({ logger: app.log, dispose: () => app.close(), flushTelemetry: shutdownTracing })`,
  so `SIGTERM` goes straight to `app.close()`: the listener stops accepting, in-flight requests get
  until the 10 s grace window expires, and `forceCloseConnections: true` severs whatever is left.
  There is no phase in which `/health/ready` answers `503` while the process is still serving.
  Draining a planned rollout is therefore the orchestrator's job — its pre-stop hook or endpoint
  removal must stop routing to the instance _before_ it sends `SIGTERM`. Readiness is the signal for
  a **dependency outage**, not for a deliberate shutdown. See
  [Graceful Shutdown](./graceful-shutdown.md).

- **Worker process** — `src/worker.ts` → `buildHealthApp` (`src/presentation/http/health-app.ts`).

  - **What it builds.** The worker calls the same `createAppContainer(logger)` and passes
    `container.cradle.healthCheck` into `buildHealthApp`, so worker readiness verifies **exactly the
    same dependencies** as API readiness. `buildHealthApp` creates a bare Fastify instance with
    `loggerInstance: logger` and `logController: new LogController({ disableRequestLogging: true })`
    — probe polling is frequent and this app has no other traffic worth logging. It installs the Zod
    validator/serializer compilers, registers `healthRoutes` under `/health`, and — only when
    `metricsEnabled` — `workerMetricsRoutes` under `/metrics` (that endpoint belongs to
    [Metrics](./metrics.md)). Nothing else: no auth plugin, no CORS, no cookies, no rate limiter, no
    Swagger, not even `@fastify/awilix`.

  - **Why the transport limits are required.** `hardening` is a **required** field, not optional.
    This server binds `env.HOST` (`0.0.0.0` by default, and set explicitly by compose), so a health
    app that silently inherited Fastify's unbounded `requestTimeout: 0` would accept a trickled
    request body on every interface forever. Its type is `HttpHardeningInput` — the
    consumer-vocabulary shape (`bodyLimitBytes`, `requestTimeoutMs`, `keepAliveTimeoutMs`,
    `maxParamLength`, `trustProxy`) — rather than Fastify's own server options.
    `httpHardeningOptions` **projects** that input onto the Fastify names, i.e. renames each field
    one-for-one (`bodyLimit`, `requestTimeout`, `keepAliveTimeout`, `routerOptions.maxParamLength`,
    `trustProxy`). Accepting the input side rather than the projected result is what stops a caller
    handing the server a raw Fastify `trustProxy` value that never passed the `parseTrustProxy`
    grammar check at boot. `worker.ts` supplies `{ ...httpLimits, trustProxy: false }`: the four
    numeric limits come from shared configuration, while `trustProxy` is pinned to the literal
    `false` rather than read from `TRUST_PROXY`, because this app serves only `/health/*` and
    `/metrics`, applies no rate limiting, and so has no reason to believe a forwarding header.
    [HTTP Infrastructure](./http-infrastructure.md) owns the full grammar and its hazards.

  - **Start and shutdown ordering.** `worker.ts` calls
    `healthApp.listen({ host: env.HOST, port: env.WORKER_PORT })` (default `8001`) only **after**
    `startWorker(container)` has resolved, so a responding probe implies the queue consumer and its
    repeatable-job schedules actually started. The failure path is deliberate:
    `void bootstrap().catch(...)` logs `logger.fatal({ err }, 'worker bootstrap failed')` and calls
    `process.exit(1)`, so a queue consumer that fails to start means the probe port never opens at
    all — the orchestrator sees connection-refused, never a `503`. On shutdown,
    `createWorkerShutdown` (`src/worker-shutdown.ts`) awaits `healthApp.close()` inside a `try` and
    `container.dispose()` in the `finally`: probes stop being served before the connections they
    depend on are torn down, and a health app that fails to close still cannot leak them — see
    [Graceful Shutdown](./graceful-shutdown.md).

**Note — one container factory for both hosts.** Neither entry point calls `createContainer`
itself; both call `createAppContainer(baseLogger)` (`src/container.ts`), which builds the container
from `APP_CONTAINER_OPTIONS` (`src/container-options.ts`:
`{ injectionMode: InjectionMode.PROXY, strict: true }`, declared `as const satisfies
ContainerOptions`, so the shape is fixed at compile time) and registers everything in one step. That
is what makes the API and the worker provably construct their health adapters under the same
injection mode and strictness; the reasoning for extracting it is in Design decisions below.

## Architecture

The application layer owns the abstraction — the `HealthCheck` **port**, a one-method interface that
says nothing about _which_ dependency is probed or _how_. The infrastructure layer supplies the
**adapters**: `PrismaHealthCheck` and `RedisHealthCheck` each probe one dependency, and
`CompositeHealthCheck` is itself a `HealthCheck` that composes other `HealthCheck`s (the Composite
pattern). The presentation layer — `healthRoutes` and the worker's `buildHealthApp` — depends only
on the port; it is unaware that readiness is backed by a database _and_ Redis, or that there is more
than one probe at all. Concretes bind to the port in exactly one place — `src/composition/health.ts`,
merged into the container by `createRegistrations` (`src/composition/compose.ts`) — preserving the
inward dependency direction. Because both processes wire themselves through the same
`createAppContainer`, adding or removing a dependency from readiness is a single
`src/composition/health.ts` edit that updates **both** probe surfaces; the routes and schemas never
change.

| Component                                                               | Layer            | Responsibility                                                                                                                                                    | File                                                      |
| ----------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HealthCheck`                                                           | Application      | Port: `check(): Promise<void>` — resolves if a critical dependency is healthy, rejects if not                                                                     | `src/application/shared/ports/health-check.ts`            |
| `CompositeHealthCheck`                                                  | Infrastructure   | Adapter: fans out to its member checks with `Promise.all`; resolves only if all resolve, rejects on the first failure; throws if constructed with zero members    | `src/infrastructure/health/composite-health-check.ts`     |
| `PrismaHealthCheck`                                                     | Infrastructure   | Adapter: probes the database with `` $queryRaw`SELECT 1` ``                                                                                                       | `src/infrastructure/persistence/prisma-health-check.ts`   |
| `RedisHealthCheck`                                                      | Infrastructure   | Adapter: probes the BullMQ Redis with `PING`/`PONG`, bounded by the `healthCheckTimeoutMs` timeout                                                                | `src/infrastructure/jobs/redis-health-check.ts`           |
| `createRedisConnection`                                                 | Infrastructure   | Generic Redis connection factory (`maxRetriesPerRequest: null`); used here to create the dedicated `healthCheckRedisConnection`                                   | `src/infrastructure/jobs/redis-connection.ts`             |
| `healthRoutes`                                                          | Presentation     | Registers `GET /live` and `GET /ready` under its mount prefix; disables rate limiting and tags routes `Health`; takes the `HealthCheck` via `HealthRoutesOptions` | `src/presentation/http/routes/health-routes.ts`           |
| `livenessResponse`, `readinessResponse`, `readinessUnavailableResponse` | Presentation     | Zod response schemas fixing each body to a single literal status for the OpenAPI contract                                                                         | `src/presentation/http/schemas/health-response-schema.ts` |
| `buildHealthApp`                                                        | Presentation     | Builds the worker's minimal health app: `healthRoutes` at `/health`, plus `workerMetricsRoutes` at `/metrics` when metrics are enabled                            | `src/presentation/http/health-app.ts`                     |
| `buildApp`                                                              | Presentation     | Mounts `healthRoutes` at `/health` on the API app, passing `container.cradle.healthCheck` from the container it is given                                          | `src/presentation/http/app.ts`                            |
| `healthRegistrations`                                                   | Composition root | Binds the adapters to the port and declares the feature's `Cradle` slice                                                                                          | `src/composition/health.ts`                               |
| `createAppContainer`                                                    | Composition root | Single factory both entry points use to create **and** register a container                                                                                       | `src/container.ts`                                        |
| `APP_CONTAINER_OPTIONS`                                                 | Composition root | The one `ContainerOptions` value (`InjectionMode.PROXY`, `strict: true`) every container is built from                                                            | `src/container-options.ts`                                |
| `createWorkerShutdown`                                                  | Composition root | Shutdown ordering for the worker: close the health app first, then dispose the container                                                                          | `src/worker-shutdown.ts`                                  |

Every registration in `src/composition/health.ts` is a `.singleton()`, so one container holds exactly
one composite and one dedicated Redis socket however many times readiness is resolved. The one
registration that owns an OS resource, `healthCheckRedisConnection`, carries
`.disposer((connection) => connection.disconnect())`, so that socket is released when the container
is disposed on shutdown.

## Public surface

All probe endpoints are **public**: no `authenticate` preHandler, no bearer token or permission, and
rate-limit-exempt (`rateLimit: false`).

**API process** — listens on `HOST`:`PORT` (default `8000`); routes mounted at the root, outside
`/v1`:

| Method | Path            | Auth          | Purpose                                                                              |
| ------ | --------------- | ------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/health/live`  | None (public) | Liveness — is the API process up?                                                    |
| `GET`  | `/health/ready` | None (public) | Readiness — is the process able to serve, i.e. are the database and Redis reachable? |

**Worker process** — the health app listens on `HOST`:`WORKER_PORT` (default `8001`):

| Method | Path            | Auth          | Purpose                                                                                 |
| ------ | --------------- | ------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/health/live`  | None (public) | Liveness — is the worker process up?                                                    |
| `GET`  | `/health/ready` | None (public) | Readiness — same composite check: are the database and Redis reachable from the worker? |

(The same worker health app also serves `GET /metrics` when `METRICS_ENABLED` is true — see
[Metrics](./metrics.md).)

Responses by state — identical on both surfaces, pinned by the Zod literal schemas:

| Endpoint            | State                      | Status | Body                          |
| ------------------- | -------------------------- | ------ | ----------------------------- |
| `GET /health/live`  | process running            | `200`  | `{ "status": "ok" }`          |
| `GET /health/ready` | all dependencies healthy   | `200`  | `{ "status": "ready" }`       |
| `GET /health/ready` | any dependency unreachable | `503`  | `{ "status": "unavailable" }` |

The liveness endpoint has no failure body: if the process cannot respond at all, the prober's own
connection timeout is the failure signal.

The `HealthCheck` port that the readiness route — and every adapter — programs against:

```ts
export interface HealthCheck {
  check(): Promise<void>;
}
```

`check()` returns `Promise<void>`; health is communicated by _resolution vs. rejection_, not by a
return value. A resolved promise means healthy; any rejection means unhealthy and is mapped to `503`.

**The plugin contract.** Whatever mounts `healthRoutes` supplies exactly one option:

```ts
export interface HealthRoutesOptions {
  healthCheck: HealthCheck;
}
```

**API host — `buildApp`** (`src/presentation/http/app.ts`):

```ts
export interface BuildAppOptions {
  container: AwilixContainer<Cradle>;
  disableRequestLogging?: boolean;
  rateLimit?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance>;
```

Only `container` is required. `disableRequestLogging` defaults to `false` — `src/main.ts` passes
`env.isDevelopment`, which is why probe polls are logged outside development. `rateLimit` defaults
to `true`; passing `false` skips the `@fastify/rate-limit` registration entirely, which is how
`createHarness` (`test/integration/support/harness.ts`) keeps an integration suite's own request
volume from throttling itself. Neither flag changes the probe routes: `healthRoutes` already sets
`rateLimit: false` per route.

**Worker host — `buildHealthApp`** (`src/presentation/http/health-app.ts`):

```ts
export interface HealthAppOptions {
  healthCheck: HealthCheck;
  metricsExposition: MetricsExposition;
  metricsEnabled: boolean;
  logger: FastifyBaseLogger;
  hardening: HttpHardeningInput;
}

export async function buildHealthApp(options: HealthAppOptions): Promise<FastifyInstance>;
```

Every field is required. The real call site, `src/worker.ts`, resolves where each one comes from at
a glance:

```ts
const healthApp = await buildHealthApp({
  healthCheck: container.cradle.healthCheck,
  metricsExposition: container.cradle.metricsExposition,
  metricsEnabled: env.METRICS_ENABLED,
  logger,
  hardening: { ...httpLimits, trustProxy: false },
});
```

`metricsExposition` is the `MetricsExposition` port (`render(): Promise<string>` plus a read-only
`contentType`) owned by [Metrics](./metrics.md); it is registered in `src/composition/metrics.ts` as
`aliasTo('metricsRecorder')` and resolved off the cradle. It plays no part in the probes —
`buildHealthApp` only forwards it to `workerMetricsRoutes` — and because the field is not optional
it is resolved and passed even when `metricsEnabled` is `false`, in which case `/metrics` is never
mounted and the value simply goes unused.

## Configuration

All variables are parsed by `envalid` in `src/config/env.ts` and mirrored in `.env.example`.

| Variable                 | Default                                                                              | Meaning                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEALTHCHECK_TIMEOUT_MS` | `2000`                                                                               | Milliseconds the Redis `PING` may take before `RedisHealthCheck` rejects with a timeout. Bound into the container as `healthCheckTimeoutMs`.                                                                                                                                                                                                  |
| `WORKER_PORT`            | `8001`                                                                               | Port the worker's health app listens on (`healthApp.listen` in `src/worker.ts`).                                                                                                                                                                                                                                                              |
| `PORT`                   | `8000`                                                                               | Port the API process listens on — and therefore where its `/health/*` endpoints live.                                                                                                                                                                                                                                                         |
| `HOST`                   | `0.0.0.0`                                                                            | Bind address for both processes' listeners.                                                                                                                                                                                                                                                                                                   |
| `NODE_ENV`               | `development` (choices: `development`, `test`, `production`)                         | Only `development` silences probe polls on the API: `src/main.ts` passes `disableRequestLogging: env.isDevelopment` into the same `buildApp` call that mounts `/health/*`, so under `test` or `production` each poll logs a request and a response line. The worker's health app is unaffected — it hard-codes `disableRequestLogging: true`. |
| `METRICS_ENABLED`        | `true`                                                                               | Passed to `buildHealthApp` as `metricsEnabled`: gates whether the worker health app also mounts `/metrics` ([Metrics](./metrics.md)). On the API it also decides whether probe polls are recorded as `route="/health/*"` samples. Health routes are always on.                                                                                |
| `BODY_LIMIT_BYTES`       | `1048576`                                                                            | Reaches the worker health app via `httpLimits` → `hardening` (`src/worker.ts`), and the API app via `httpHardeningOptions({ ...httpLimits, trustProxy })` (`src/presentation/http/app.ts`). Maximum request body in bytes. Owned by [HTTP Infrastructure](./http-infrastructure.md).                                                          |
| `REQUEST_TIMEOUT_MS`     | `30000`                                                                              | Reaches the worker health app via `httpLimits` → `hardening` (`src/worker.ts`), and the API app the same way. Bounds how long a request may take to arrive, closing the slow-POST hole on the worker's listener. Owned by [HTTP Infrastructure](./http-infrastructure.md).                                                                    |
| `KEEP_ALIVE_TIMEOUT_MS`  | `72000`                                                                              | Reaches the worker health app via `httpLimits` → `hardening` (`src/worker.ts`), and the API app the same way. Idle keep-alive window for the probe server. Owned by [HTTP Infrastructure](./http-infrastructure.md).                                                                                                                          |
| `MAX_PARAM_LENGTH`       | `100`                                                                                | Reaches the worker health app via `httpLimits` → `hardening` (`src/worker.ts`), nested under `routerOptions`. The probe routes declare no parameters, so this is inherited uniformity rather than an active limit. Owned by [HTTP Infrastructure](./http-infrastructure.md).                                                                  |
| `TRUST_PROXY`            | `false`                                                                              | Applied to the **API** app, which spreads `httpHardeningOptions({ ...httpLimits, trustProxy })` — so it affects every route on that app, probes included. The worker health app ignores it and pins `trustProxy: false`. Owned by [HTTP Infrastructure](./http-infrastructure.md).                                                            |
| `REDIS_URL`              | `redis://127.0.0.1:6379` (dev default; **required in production** — no prod default) | Connection string for the dedicated `healthCheckRedisConnection` that `RedisHealthCheck` pings. Owned by [Background Jobs](./background-jobs.md).                                                                                                                                                                                             |
| `DATABASE_URL`           | (required, no default)                                                               | Connection string for the Prisma client that `PrismaHealthCheck` probes with `SELECT 1`. Read transitively via the shared client, not by this feature directly.                                                                                                                                                                               |
| `LOG_LEVEL`              | `info`                                                                               | Level of the base logger both entry points pass to `createAppContainer` and (in the worker) to `buildHealthApp`; the `readiness check failed` line is logged at `error`. Owned by [Structured Logging](./structured-logging.md).                                                                                                              |

## Usage & extension

**Calling the probes.** Point liveness at `GET /health/live` and readiness at `GET /health/ready` —
on the API port for the API deployment and on the worker port for the worker deployment. Both
surfaces answer identically:

```bash
# API process (PORT, default 8000)
curl -i http://127.0.0.1:8000/health/live
# HTTP/1.1 200 OK
# {"status":"ok"}

curl -i http://127.0.0.1:8000/health/ready
# HTTP/1.1 200 OK
# {"status":"ready"}

# Worker process (WORKER_PORT, default 8001) — same paths, same bodies
curl -i http://127.0.0.1:8001/health/ready
# HTTP/1.1 200 OK
# {"status":"ready"}

# Once the database or Redis is unreachable, readiness on either port answers:
# HTTP/1.1 503 Service Unavailable
# {"status":"unavailable"}
```

A Kubernetes example for the API pod:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8000
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8000
  initialDelaySeconds: 5
  periodSeconds: 5
```

For the worker pod, use the same paths with `port: 8001` (or whatever `WORKER_PORT` is set to in
that environment; likewise substitute the configured `PORT` above rather than copying `8000`
blindly). Kubernetes treats any `2xx`/`3xx` as pass and anything else as fail, so the explicit
`503` on `/health/ready` reliably pulls the instance out of rotation until the dependencies recover.
The repo's own `docker-compose.yml` already wires the worker container's `healthcheck` to
`http://127.0.0.1:8001/health/live` via a `node -e "fetch(...)"` one-liner.

**Adding a new member health check.** Because the routes depend only on the `HealthCheck` port and
the container composes readiness from a `CompositeHealthCheck`, you extend readiness by writing one
more adapter and adding it to the composite — the change reaches both probe surfaces automatically,
and the routes and schemas never change. To also require, say, an external HTTP dependency to be
reachable:

1. **Write the adapter** in the infrastructure layer, implementing `HealthCheck`. Constructor
   parameters are destructured from the Awilix cradle by name (`APP_CONTAINER_OPTIONS` sets
   `injectionMode: InjectionMode.PROXY`), so each parameter name must match a registered cradle key.
   Reuse the existing `healthCheckTimeoutMs` cradle value to keep every probe on the same timeout
   budget:

   ```ts
   // src/infrastructure/health/http-dependency-health-check.ts
   import type { HealthCheck } from '@/application/shared/ports/health-check';

   interface HttpDependencyHealthCheckDeps {
     dependencyHealthUrl: string;
     healthCheckTimeoutMs: number;
   }

   export class HttpDependencyHealthCheck implements HealthCheck {
     private readonly url: string;
     private readonly timeoutMs: number;

     constructor({ dependencyHealthUrl, healthCheckTimeoutMs }: HttpDependencyHealthCheckDeps) {
       this.url = dependencyHealthUrl;
       this.timeoutMs = healthCheckTimeoutMs;
     }

     async check(): Promise<void> {
       const response = await fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
       if (!response.ok) {
         throw new Error(`dependency health check failed with status ${response.status}`);
       }
     }
   }
   ```

2. **Declare the new cradle keys** in the `declare module '@fastify/awilix'` block in
   `src/composition/health.ts`:

   ```ts
   dependencyHealthCheck: HealthCheck;
   dependencyHealthUrl: string;
   ```

3. **Register the adapter (and any value it needs)** in `healthRegistrations`, alongside the
   existing `databaseHealthCheck` / `redisHealthCheck` registrations:

   ```ts
   dependencyHealthUrl: asValue(env.DEPENDENCY_HEALTH_URL),
   dependencyHealthCheck: asClass(HttpDependencyHealthCheck).singleton(),
   ```

   (If the check reads new configuration, add `DEPENDENCY_HEALTH_URL` to `src/config/env.ts` and
   `.env.example` too.)

4. **Add it to the composite.** Extend the `healthCheck` registration's destructured deps and the
   array passed to `CompositeHealthCheck`:

   ```ts
   healthCheck: asFunction(
     ({
       databaseHealthCheck,
       redisHealthCheck,
       dependencyHealthCheck,
     }: Pick<Cradle, 'databaseHealthCheck' | 'redisHealthCheck' | 'dependencyHealthCheck'>) =>
       new CompositeHealthCheck([databaseHealthCheck, redisHealthCheck, dependencyHealthCheck]),
   ).singleton(),
   ```

The new dependency is now part of readiness on both the API and the worker: `Promise.all` rejects on
the first failing member, so `GET /health/ready` returns `503` the moment any probe — including the
new one — fails.

**Faking readiness in a test.** Because `buildApp` receives the container as a parameter, an
integration test can register a stub on that container _before_ the app is built and the endpoint
will use it. `createHarness` (`test/integration/support/harness.ts`) does exactly this — it applies
each override as `asValue` on the container returned by `createAppContainer`, then calls `buildApp`:

```ts
const harness = await createHarness({
  healthCheck: { check: () => Promise.reject(new Error('dependency down')) },
});

const response = await harness.app.inject({ method: 'GET', url: '/health/ready' });
// 503, { status: 'unavailable' }
```

The ordering matters: `buildApp` resolves `container.cradle.healthCheck` once, while registering the
plugin, so an override applied after `buildApp` returns would have no effect.

## Design decisions & trade-offs

- **Readiness aggregates dependencies; liveness does not.** The two probes drive different
  orchestrator actions. A failed **liveness** probe means _restart the process_, so liveness stays
  cheap and dependency-free — its handler does no I/O and fails only when _this process_ is broken.
  A failed **readiness** probe means _stop routing traffic here but leave the process running_ —
  exactly right for a dependency outage, since a restart cannot fix an external dependency. Folding
  dependency checks into liveness would let a transient database or Redis blip trigger a restart
  storm across every replica.

- **Readiness signals dependency health, not shutdown intent.** Neither entry point flips readiness
  to `503` on `SIGTERM` before closing: the API's `dispose` is `() => app.close()` and the worker's
  is `createWorkerShutdown(...)`, both of which stop the listener outright. Adding a "draining"
  state would mean holding the server open through a configurable lame-duck window purely so
  probers notice, which duplicates a guarantee orchestrators already provide through pre-stop hooks
  and endpoint removal. The cost is that a rollout must be drained by the platform, not by the app —
  see [Graceful Shutdown](./graceful-shutdown.md).

- **`buildApp` takes the container as a required parameter instead of reading a module-global.**
  The `diContainer` export from `@fastify/awilix` is a process-wide singleton; resolving
  `healthCheck` from it would make the probe's dependency ambient rather than passed in. Threading
  the container through `BuildAppOptions` keeps the composition root explicit, allows more than one
  independently-configured app in a single process (which the test suite needs), and makes the
  registration site read as ordinary data flow: `container.cradle.healthCheck` in, plugin options
  out. The cost is one more required option on every `buildApp` caller. Per-request resolution is
  unaffected — `fastifyAwilixPlugin` still exposes `app.diContainer` and `request.diScope.cradle`
  for the features that need a scoped cradle.

- **That parameter is what makes readiness overridable in a test.** `buildApp` resolves
  `healthCheck` eagerly at registration time. When the value came from a module-global container,
  a test could not get a stub in before that resolution happened, so the readiness endpoint always
  ran the real database and Redis probes. Now `createHarness({ healthCheck: failingStub })`
  registers onto the very container `buildApp` will read, and
  `test/integration/harness-overrides.int.test.ts` asserts the endpoint answers `503` — the
  failure path of a production route is now exercisable without breaking real infrastructure.

- **One `APP_CONTAINER_OPTIONS` object rather than per-entry-point container construction.** The
  worker previously constructed its own container; the API's and the worker's options were then two
  literals that had to be kept in sync by hand, and a divergence in `injectionMode` or `strict`
  would surface as a resolution failure in only one process — the kind of bug that reaches
  production because local runs exercise one deployable at a time. Extracting the options to
  `src/container-options.ts` and routing both entry points through `createAppContainer` makes
  sharing structural instead of conventional. `test/unit/support/container.ts` reuses the same
  constant, so test containers are built under the same rules as production ones.

- **A dedicated health app for the worker instead of reusing `buildApp`.** The worker's only job is
  consuming BullMQ queues; without an HTTP listener it would be unprobeable — an orchestrator could
  never restart a wedged worker or gate rollouts on its readiness. `buildHealthApp` gives it the
  smallest possible surface: `healthRoutes` (plus optionally `/metrics`) and nothing else — no auth,
  no CORS, no cookies, no rate limiter, no Swagger. Reusing `buildApp` would drag the entire API
  surface (and its middleware and secrets requirements) into a process that must never serve it.

- **The plugin takes its `HealthCheck` via registration options.** `healthRoutes` declares
  `HealthRoutesOptions` rather than resolving from a request DI scope, which is what lets the same
  plugin serve two very different hosts: the API app passes `container.cradle.healthCheck` from the
  container it was handed, the worker's `buildHealthApp` passes the value from its own container.
  The route code stays identical, so probe semantics cannot drift between processes.

- **The worker runs the same composite — database included.** Worker job handlers write to the
  database and BullMQ runs on Redis, so the worker is not "ready" unless both are reachable, same
  as the API. Reusing one `createAppContainer` guarantees the two readiness definitions never
  diverge silently.

- **Health endpoints live outside `/v1`.** Probe URLs are wired into orchestrator manifests and
  load-balancer configs, which should not need editing when the API version bumps; `healthRoutes`
  is registered at the root while business routes mount under `API_V1_PREFIX`.

- **`CompositeHealthCheck` with `Promise.all` (fail-fast, all-or-nothing, concurrent).** Readiness
  is binary for a load balancer, so aggregation is a boolean AND: any critical dependency down
  means not ready. Running members concurrently makes probe latency the _slowest single_ member
  rather than the sum. The trade-off is that the composite surfaces only the first failing member
  and no per-dependency breakdown — acceptable because the orchestrator only needs pass/fail, and
  operators get the specific failure from the logs.

- **The response body never names the failing dependency.** On failure the body is the fixed
  `{ status: 'unavailable' }` literal; the underlying `Error` goes to the
  `readiness check failed` log line. Health endpoints are unauthenticated, so the body
  intentionally leaks nothing — no dependency name, version, or error detail — while operators
  retain full visibility through structured logs.

- **The Redis probe has an explicit timeout; the Prisma probe relies on the driver.**
  `RedisHealthCheck` races `redis.ping()` against a `healthCheckTimeoutMs` timer because the health
  connection is created with `maxRetriesPerRequest: null`, on which a command against an
  unreachable server can wait indefinitely — the timeout converts a stall into a prompt `503`.
  `PrismaHealthCheck` leans on the database driver's own connection/query timeouts, so `SELECT 1`
  needs no extra guard.

- **A dedicated `healthCheckRedisConnection`, separate from the queue and worker connections.**
  BullMQ's worker runs blocking commands and ioredis serializes commands over a single socket, so
  sharing a connection risks head-of-line blocking that could delay the `PING` reply past the
  timeout and report a false _unavailable_ under heavy queue load. A dedicated connection keeps
  probe latency independent of job traffic; the cost is one extra Redis connection, disposed on
  container teardown.

- **`SELECT 1` rather than a table/row query.** The database probe only needs to confirm the pool
  can reach the server and get a working connection, not to validate schema or data. `SELECT 1` is
  the cheapest query that exercises the full connection path and stays valid across migrations.

- **The `503` is sent directly by the handler, not routed through the error handler.** Readiness
  failure is an _expected_, well-defined outcome (a dependency is down), not an application error.
  Returning a fixed `{ status: 'unavailable' }` payload keeps the probe response stable and
  independent of the global error-response shape — which is why `readinessUnavailableResponse`
  exists as its own schema rather than reusing the shared `errorResponse`.

- **Both probes are public and rate-limit-exempt.** Orchestrator probes are unauthenticated by
  necessity — the kubelet has no credentials — and poll frequently. Setting `rateLimit: false` in
  the plugin's `onRoute` hook prevents the API app's global rate limiter from ever returning `429`
  to a probe, which would be misread as an outage.

- **Fixed single-literal Zod schemas.** Each response body is pinned with `z.literal(...)`
  (`ok` / `ready` / `unavailable`). This documents the exact contract in the generated OpenAPI spec
  and makes the probe output a stable, testable constant rather than a free-form object.

## Testing

Unit tests run with `npm test` (Vitest); integration tests with `npm run test:integration`;
`npm run audit` runs the full gate (lockfile check, dependency audit, format, lint, typecheck,
architecture boundaries, build, coverage, integration).

- **Unit — `src/infrastructure/health/composite-health-check.test.ts`.** The aggregation contract:
  construction throws when given zero checks; `check()` resolves when every member resolves; every
  member is invoked; and `check()` rejects with the failure when _any_ member rejects.

- **Unit — `src/infrastructure/jobs/redis-health-check.test.ts`.** The Redis probe against a fake
  `Redis`: resolves when `PING` replies `PONG`; rejects on any other reply
  (`unexpected Redis PING reply`); rejects when the connection fails (`ECONNREFUSED`); and rejects
  on timeout using Vitest fake timers (`timed out`).

- **Unit — `src/presentation/http/routes/health-routes.test.ts`.** Builds a minimal Fastify app
  with the Zod compilers, registers `healthRoutes` with a mocked `HealthCheck` passed through the
  plugin options, and drives it via `app.inject`. Asserts `GET /health/live` returns `200` /
  `{ status: 'ok' }` and **never** calls `healthCheck.check()`; `GET /health/ready` returns `200` /
  `{ status: 'ready' }` when the check resolves; and `503` / `{ status: 'unavailable' }` when it
  rejects.

- **Unit — `src/presentation/http/health-app.test.ts`.** The worker health app via
  `buildHealthApp`: serves `GET /health/live` (`200`); maps a failing dependency to `503` on
  `GET /health/ready`; mounts `GET /metrics` when `metricsEnabled` is true (correct content type
  and body); and returns `404` for `/metrics` while still serving `/health/live` when it is false.
  The transport limits `buildHealthApp` projects are covered separately by
  `src/presentation/http/server-options.test.ts`.

- **Unit — `src/container.test.ts`.** Guards the wiring both probe surfaces depend on:
  `createAppContainer` returns a fresh container per call, a registration override stays local to
  the container it was applied to, the container's `options` equal
  `{ injectionMode: InjectionMode.PROXY, strict: true }`, and the base logger passed in is the one
  on the cradle.

- **Unit — `src/composition/compose.test.ts`.** Asserts every module's key set is claimed exactly
  once and matches the container's registrations, and that `healthCheckRedisConnection` is among
  the registrations carrying a disposer — so the probe's Redis socket is released on shutdown.

- **Unit — `src/worker-shutdown.test.ts`.** Pins the teardown guarantee this doc relies on: it
  records call order to prove `healthApp.close()` runs before `container.dispose()`, and asserts
  that when `healthApp.close()` rejects the container is **still** disposed (while the rejection
  propagates) — so a health app that fails to close cannot strand the probe's Redis socket or the
  Prisma pool.

- **Integration — `test/integration/health.int.test.ts`.** Starts a real Redis via Testcontainers
  (`redis:7.4-alpine`), wraps a `RedisHealthCheck` in a `CompositeHealthCheck`, and asserts the
  probe resolves while Redis is reachable and rejects once the container is stopped — the real
  `PING`/`PONG` path against a live server.

- **Integration — `test/integration/app-bootstrap.int.test.ts`.** Boots the real application with
  `buildApp({ container: createAppContainer(createBaseLogger(SILENT_LOG_LEVEL)), disableRequestLogging: true })`
  and asserts both `GET /health/live` and `GET /health/ready` return `200` with the expected bodies
  through the fully assembled app.

- **Integration — `test/integration/harness-overrides.int.test.ts`.** The readiness failure path
  end-to-end: `createHarness({ healthCheck: { check: () => Promise.reject(new Error('dependency down')) } })`
  and `GET /health/ready` must answer `503` with `{ status: 'unavailable' }`. This is the test that
  pins the container-as-parameter contract — it passes only because the override is registered on
  the container before `buildApp` resolves `healthCheck` from it.

Run only this feature's unit suites:

```bash
npx vitest run \
  src/infrastructure/health/composite-health-check.test.ts \
  src/infrastructure/jobs/redis-health-check.test.ts \
  src/presentation/http/routes/health-routes.test.ts \
  src/presentation/http/health-app.test.ts \
  src/container.test.ts \
  src/composition/compose.test.ts \
  src/worker-shutdown.test.ts
```

Run only this feature's integration suites:

```bash
npx vitest run -c vitest.integration.config.ts \
  test/integration/health.int.test.ts \
  test/integration/app-bootstrap.int.test.ts \
  test/integration/harness-overrides.int.test.ts
```
