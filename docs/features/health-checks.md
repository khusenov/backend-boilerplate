# Health Checks

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `33ad1b0`

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
consumer with no business HTTP surface of its own — runs a dedicated minimal probe app on
`WORKER_PORT` so it can be probed at all.

## How it works

**One plugin, two hosts.** `healthRoutes` is a Fastify plugin
(`FastifyPluginCallbackZod<HealthRoutesOptions>`) that receives its single dependency — a
`HealthCheck` — through its registration options, not by resolving a DI scope itself. That makes the
plugin host-agnostic, and it is mounted on two separate probe surfaces:

- **API process** (`src/main.ts` → `buildApp` in `src/presentation/http/app.ts`). Registered on the
  root app with `app.register(healthRoutes, { prefix: '/health', healthCheck: diContainer.cradle.healthCheck })`;
  the app listens on `HOST`:`PORT` (default `8000`). The prefix sits at the **root**, outside
  `API_V1_PREFIX` (`'/v1'`, `src/presentation/http/api-version.ts`), so the probe paths are
  **unversioned**: `/health/live`, not `/v1/health/live`.
- **Worker process** (`src/worker.ts`). The worker builds its own Awilix container
  (`createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true })`), runs the same
  `registerDependencies`, and passes `container.cradle.healthCheck` into `buildHealthApp`
  (`src/presentation/http/health-app.ts`) — so worker readiness verifies **exactly the same
  dependencies** as API readiness. `buildHealthApp` constructs a bare Fastify instance
  (`disableRequestLogging: true`, so frequent probe polling does not spam logs), applies the
  transport limits from its required `hardening` parameter via `httpHardeningOptions`, installs the
  Zod validator/serializer compilers, registers `healthRoutes` under `/health`, and — only when
  `metricsEnabled` — `workerMetricsRoutes` under `/metrics` (that endpoint belongs to
  [Metrics](./metrics.md)). The `hardening` field is **required**, not optional: this server listens
  on `env.HOST` (`0.0.0.0` by default, and set explicitly by compose), so a health app that silently
  defaulted to Fastify's unbounded `requestTimeout: 0` would accept a trickled body on every
  interface forever. It takes the consumer-vocabulary `HttpHardeningInput` rather than the projected
  Fastify options, so callers cannot smuggle in a raw `trustProxy` string. `worker.ts` supplies
  `{ ...httpLimits, trustProxy: false }` — the four numeric limits come from shared configuration,
  but `trustProxy` is pinned to the literal `false` rather than read from `TRUST_PROXY`, because
  this server exposes only `/health/*` and `/metrics`, applies no rate limiting, and so has no
  reason to believe a forwarding header. See
  [HTTP Infrastructure](./http-infrastructure.md) for the grammar and its hazards. `worker.ts` starts listening on `HOST`:`WORKER_PORT` (default `8001`)
  only **after** `startWorker(container)` has resolved, so a responding probe implies the queue
  consumer and its repeatable-job schedules actually started. On shutdown, `createWorkerShutdown`
  (`src/worker-shutdown.ts`) closes the health app first and disposes the container in a `finally` —
  probes stop being served before the connections they depend on are torn down.

Inside the plugin, an `onRoute` hook tags every route with the `Health` OpenAPI tag and sets
`rateLimit: false`. In the API app — where [HTTP Infrastructure](./http-infrastructure.md) registers
a global rate limiter — that flag exempts the probes from throttling; the worker's probe app
registers no rate limiter, so the flag is inert there.

The two endpoints behave differently by design:

- **`GET /health/live`** — the handler is synchronous and returns `{ status: 'ok' }` with HTTP
  `200`. It performs no I/O and never touches the `HealthCheck`; a response at all proves the
  process is up and the event loop is servicing requests. The co-located unit test asserts the
  readiness dependency is _not_ invoked on this path.
- **`GET /health/ready`** — the handler awaits `healthCheck.check()`. On success it returns
  `{ status: 'ready' }` with `200`. On failure (the promise rejects) it logs the error via
  `request.log.error({ err }, 'readiness check failed')`, then replies `503` with
  `{ status: 'unavailable' }` — sent directly via `reply.status(503).send(...)`, bypassing the
  application error handler entirely.

The `healthCheck` bound in the container is a **`CompositeHealthCheck`**, not a single probe. Its
constructor takes a read-only array of `HealthCheck` members (and throws
`CompositeHealthCheck requires at least one health check` when given none); its `check()` fans the
members out concurrently:

```ts
async check(): Promise<void> {
  await Promise.all(this.checks.map((healthCheck) => healthCheck.check()));
}
```

The container composes it from two members — `databaseHealthCheck` (`PrismaHealthCheck`) and
`redisHealthCheck` (`RedisHealthCheck`). The **aggregation rule is all-or-nothing**: `Promise.all`
resolves only if _every_ member resolves and rejects with the _first_ member that rejects, so
readiness is healthy only when all component checks pass. The composite does **not** expose
per-member status in the response body — the caller always sees the fixed
`{ status: 'unavailable' }` literal; _which_ dependency failed appears only in the
`readiness check failed` log line. The two members:

- **`PrismaHealthCheck`** runs the raw query `SELECT 1` through the shared Prisma client
  (`this.prisma.$queryRaw`). It confirms the pool can acquire a working connection without
  depending on any table or row; if the database is unreachable, the query rejects.
- **`RedisHealthCheck`** issues `PING` on a dedicated Redis connection and expects the reply
  `PONG` (the `HEALTHY_PING_REPLY` constant); any other reply throws
  `unexpected Redis PING reply: <reply>`. The call is raced against a `healthCheckTimeoutMs` timer,
  so a hung Redis rejects with `Redis health check timed out after <ms>ms` instead of stalling the
  request; the timer is always cleared in a `finally`.

## Architecture

The application layer owns the abstraction — the `HealthCheck` **port**, a one-method interface that
says nothing about _which_ dependency is probed or _how_. The infrastructure layer supplies the
**adapters**: `PrismaHealthCheck` and `RedisHealthCheck` each probe one dependency, and
`CompositeHealthCheck` is itself a `HealthCheck` that composes other `HealthCheck`s (the Composite
pattern). The presentation layer — `healthRoutes` and the worker's `buildHealthApp` — depends only
on the port; it is unaware that readiness is backed by a database _and_ Redis, or that there is more
than one probe at all. Concretes bind to the port in exactly one place — `src/composition/health.ts` —
preserving the inward dependency direction, and because both processes wire themselves through the
same `registerDependencies`, adding or removing a dependency from readiness is a single
`src/composition/health.ts` edit that updates **both** probe surfaces; the routes and schemas never change.

| Component                                                               | Layer            | Responsibility                                                                                                                                                 | File                                                      |
| ----------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HealthCheck`                                                           | Application      | Port: `check(): Promise<void>` — resolves if a critical dependency is healthy, rejects if not                                                                  | `src/application/shared/ports/health-check.ts`            |
| `CompositeHealthCheck`                                                  | Infrastructure   | Adapter: fans out to its member checks with `Promise.all`; resolves only if all resolve, rejects on the first failure; throws if constructed with zero members | `src/infrastructure/health/composite-health-check.ts`     |
| `PrismaHealthCheck`                                                     | Infrastructure   | Adapter: probes the database with `` $queryRaw`SELECT 1` ``                                                                                                    | `src/infrastructure/persistence/prisma-health-check.ts`   |
| `RedisHealthCheck`                                                      | Infrastructure   | Adapter: probes the BullMQ Redis with `PING`/`PONG`, bounded by the `healthCheckTimeoutMs` timeout                                                             | `src/infrastructure/jobs/redis-health-check.ts`           |
| `createRedisConnection`                                                 | Infrastructure   | Generic Redis connection factory (`maxRetriesPerRequest: null`); used here to create the dedicated `healthCheckRedisConnection`                                | `src/infrastructure/jobs/redis-connection.ts`             |
| `healthRoutes`                                                          | Presentation     | Registers `GET /live` and `GET /ready` under its mount prefix; disables rate limiting and tags routes `Health`; takes the `HealthCheck` via options            | `src/presentation/http/routes/health-routes.ts`           |
| `livenessResponse`, `readinessResponse`, `readinessUnavailableResponse` | Presentation     | Zod response schemas fixing each body to a single literal status for the OpenAPI contract                                                                      | `src/presentation/http/schemas/health-response-schema.ts` |
| `buildHealthApp`                                                        | Presentation     | Builds the worker's minimal probe app: `healthRoutes` at `/health`, plus `workerMetricsRoutes` at `/metrics` when metrics are enabled                          | `src/presentation/http/health-app.ts`                     |
| `createWorkerShutdown`                                                  | Composition root | Shutdown ordering for the worker: close the probe app first, then dispose the container                                                                        | `src/worker-shutdown.ts`                                  |

The container registrations (`src/composition/health.ts`): `databaseHealthCheck` is
`asClass(PrismaHealthCheck).singleton()`; `healthCheckRedisConnection` is a singleton
`createRedisConnection({ redisUrl: env.REDIS_URL })` with a disposer that disconnects it;
`redisHealthCheck` is `asClass(RedisHealthCheck).singleton()`; `healthCheckTimeoutMs` is
`asValue(env.HEALTHCHECK_TIMEOUT_MS)`; and `healthCheck` is an `asFunction` singleton building
`new CompositeHealthCheck([databaseHealthCheck, redisHealthCheck])`.

## Public surface

All probe endpoints are **public**: no `authenticate` preHandler, no bearer token or permission, and
rate-limit-exempt (`rateLimit: false`).

**API process** — listens on `HOST`:`PORT` (default `8000`); routes mounted at the root, outside
`/v1`:

| Method | Path            | Auth          | Purpose                                                                              |
| ------ | --------------- | ------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/health/live`  | None (public) | Liveness — is the API process up?                                                    |
| `GET`  | `/health/ready` | None (public) | Readiness — is the process able to serve, i.e. are the database and Redis reachable? |

**Worker process** — the `buildHealthApp` instance listens on `HOST`:`WORKER_PORT` (default `8001`):

| Method | Path            | Auth          | Purpose                                                                                 |
| ------ | --------------- | ------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/health/live`  | None (public) | Liveness — is the worker process up?                                                    |
| `GET`  | `/health/ready` | None (public) | Readiness — same composite check: are the database and Redis reachable from the worker? |

(The same worker app also serves `GET /metrics` when `METRICS_ENABLED` is true — see
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

## Configuration

All variables are parsed by `envalid` in `src/config/env.ts` and mirrored in `.env.example`.

| Variable                 | Default                                                                              | Meaning                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEALTHCHECK_TIMEOUT_MS` | `2000`                                                                               | Milliseconds the Redis `PING` may take before `RedisHealthCheck` rejects with a timeout. Bound into the container as `healthCheckTimeoutMs`.                      |
| `WORKER_PORT`            | `8001`                                                                               | Port the worker's `buildHealthApp` probe app listens on (`healthApp.listen` in `src/worker.ts`).                                                                  |
| `PORT`                   | `8000`                                                                               | Port the API process listens on — and therefore where its `/health/*` endpoints live.                                                                             |
| `HOST`                   | `0.0.0.0`                                                                            | Bind address for both processes' listeners.                                                                                                                       |
| `METRICS_ENABLED`        | `true`                                                                               | Passed to `buildHealthApp` as `metricsEnabled`: gates whether the worker probe app also mounts `/metrics` ([Metrics](./metrics.md)). Health routes are always on. |
| `BODY_LIMIT_BYTES`       | `1048576`                                                                            | Reaches this app through `httpLimits`, spread into the required `hardening` parameter in `src/worker.ts`. Maximum request body in bytes.                          |
| `REQUEST_TIMEOUT_MS`     | `30000`                                                                              | Same route. Bounds how long a request may take to arrive, closing the slow-POST hole on the worker's listener. `TRUST_PROXY` is **not** read here — see above.    |
| `KEEP_ALIVE_TIMEOUT_MS`  | `72000`                                                                              | Same route. Idle keep-alive window for the probe server.                                                                                                          |
| `MAX_PARAM_LENGTH`       | `100`                                                                                | Same route. Maximum route-parameter length; the probe routes declare no parameters, so this is inherited uniformity rather than an active limit.                  |
| `REDIS_URL`              | `redis://127.0.0.1:6379` (dev default; **required in production** — no prod default) | Connection string for the dedicated `healthCheckRedisConnection` that `RedisHealthCheck` pings.                                                                   |
| `DATABASE_URL`           | (required, no default)                                                               | Connection string for the Prisma client that `PrismaHealthCheck` probes with `SELECT 1`. Read transitively via the shared client, not by this feature directly.   |

## Usage & extension

**Calling the probes.** Point liveness at `GET /health/live` and readiness at `GET /health/ready` —
on the API port for the API deployment and on the worker port for the worker deployment. A
Kubernetes example for the API pod:

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

**Adding a new component health check.** Because the routes depend only on the `HealthCheck` port
and the container composes readiness from a `CompositeHealthCheck`, you extend readiness by writing
one more adapter and adding it to the composite — the change reaches both probe surfaces
automatically, and the routes and schemas never change. To also require, say, an external HTTP
dependency to be reachable:

1. **Write the adapter** in the infrastructure layer, implementing `HealthCheck`. Constructor
   parameters are destructured from the Awilix cradle by name (both processes use
   `injectionMode: 'PROXY'`), so each parameter name must match a registered cradle key. Reuse the
   existing `healthCheckTimeoutMs` cradle value to keep every probe on the same timeout budget:

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

## Design decisions & trade-offs

- **Readiness aggregates dependencies; liveness does not.** The two probes drive different
  orchestrator actions. A failed **liveness** probe means _restart the process_, so liveness stays
  cheap and dependency-free — its handler does no I/O and fails only when _this process_ is broken.
  A failed **readiness** probe means _stop routing traffic here but leave the process running_ —
  exactly right for a dependency outage, since a restart cannot fix an external dependency. Folding
  dependency checks into liveness would let a transient database or Redis blip trigger a restart
  storm across every replica.

- **A dedicated probe app for the worker instead of reusing `buildApp`.** The worker's only job is
  consuming BullMQ queues; without an HTTP listener it would be unprobeable — an orchestrator could
  never restart a wedged worker or gate rollouts on its readiness. `buildHealthApp` gives it the
  smallest possible surface: `healthRoutes` (plus optionally `/metrics`) and nothing else — no auth,
  no CORS, no cookies, no rate limiter, no Swagger. Reusing `buildApp` would drag the entire API
  surface (and its middleware and secrets requirements) into a process that must never serve it.

- **The plugin takes its `HealthCheck` via registration options.** `healthRoutes` declares
  `HealthRoutesOptions` rather than resolving from a request DI scope, which is what lets the same
  plugin serve two very different hosts: the DI-integrated API app passes
  `diContainer.cradle.healthCheck`, the worker passes its own container's cradle value. The route
  code stays identical, so probe semantics cannot drift between processes.

- **The worker runs the same composite — database included.** Worker job handlers write to the
  database and BullMQ runs on Redis, so the worker is not "ready" unless both are reachable, same
  as the API. Reusing one `registerDependencies` guarantees the two readiness definitions never
  diverge silently.

- **Health endpoints live outside `/v1`.** Probe URLs are wired into orchestrator manifests and
  load-balancer configs, which should not need editing when the API version bumps; `healthRoutes`
  is registered at the root while business routes mount under `API_V1_PREFIX`.

- **`CompositeHealthCheck` with `Promise.all` (fail-fast, all-or-nothing, concurrent).** Readiness
  is binary for a load balancer, so aggregation is a boolean AND: any critical dependency down
  means not ready. Running members concurrently makes probe latency the _slowest single_ check
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
coverage, architecture boundaries, integration).

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

- **Unit — `src/presentation/http/health-app.test.ts`.** The worker probe surface via
  `buildHealthApp`: serves `GET /health/live` (`200`); maps a failing dependency to `503` on
  `GET /health/ready`; mounts `GET /metrics` when `metricsEnabled` is true (correct content type
  and body); and omits it — `404` — when metrics are disabled while `/health/live` keeps serving.
  All four cases pass a shared `testHardening` fixture whose values are deliberately arbitrary, so
  no reader mistakes them for a record of the production defaults; the limits themselves are covered
  by `src/presentation/http/server-options.test.ts`.

- **Integration — `test/integration/health.int.test.ts`.** Starts a real Redis via Testcontainers
  (`redis:7.4-alpine`), wraps a `RedisHealthCheck` in a `CompositeHealthCheck`, and asserts the
  probe resolves while Redis is reachable and rejects once the container is stopped — the real
  `PING`/`PONG` path against a live server.

- **Integration — `test/integration/app-bootstrap.int.test.ts`.** Boots the real application via
  `buildApp(...)` and asserts both `GET /health/live` and `GET /health/ready` return `200` with the
  expected bodies through the fully assembled app.

Run only this feature's unit suites:

```bash
npx vitest run \
  src/infrastructure/health/composite-health-check.test.ts \
  src/infrastructure/jobs/redis-health-check.test.ts \
  src/presentation/http/routes/health-routes.test.ts \
  src/presentation/http/health-app.test.ts
```
