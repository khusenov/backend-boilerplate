# Health Checks

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `9044a23`

## Purpose

Container orchestrators (Kubernetes, ECS, Nomad) and load balancers need machine-readable signals to
decide two independent things: _is this process alive?_ and _is this process ready to serve traffic?_
This feature exposes those signals as two separate, unauthenticated HTTP endpoints. **Liveness**
(`/health/live`) reports only that the Node process is up and its event loop can answer; failing it
tells the orchestrator to **restart** the pod. **Readiness** (`/health/ready`) additionally verifies
that every critical downstream dependency — the database _and_ the Redis instance that backs
[BullMQ](./background-jobs.md) — is reachable; failing it tells the orchestrator to **drain this
instance from rotation** without
killing it, so it can recover while a restart would only prolong the outage.

## How it works

Both endpoints are registered by the `healthRoutes` Fastify plugin under the `/health` prefix (see
[HTTP Infrastructure](./http-infrastructure.md)'s `app.ts`,
`app.register(healthRoutes, { prefix: '/health' })`). An `onRoute` hook inside the plugin tags every
route it registers with the `Health` OpenAPI tag and sets `rateLimit: false`, so the probes (the
health endpoints an orchestrator polls periodically) are never throttled even while the global rate
limiter is active.

- **`GET /health/live`** — the handler is synchronous and returns `{ status: 'ok' }` with HTTP `200`.
  It performs no I/O and never touches a dependency; a response at all proves the process is up and
  the event loop is servicing requests. The co-located unit test asserts the readiness dependency is
  _not_ invoked on this path.

- **`GET /health/ready`** — the handler resolves the `healthCheck` port from the request's Awilix
  scope (`request.diScope.cradle`) and awaits `healthCheck.check()`.
  - On success it returns `{ status: 'ready' }` with HTTP `200`.
  - On failure (the promise rejects) it logs the error via `request.log.error({ err }, 'readiness
check failed')`, then replies `503` with body `{ status: 'unavailable' }`. That body is sent
    directly by the handler via `reply.status(503).send(...)`, so it bypasses the application error
    handler entirely.

The `healthCheck` bound in the container is a **`CompositeHealthCheck`**, not a single probe. Its
constructor takes a read-only array of `HealthCheck` members and its `check()` fans them out
concurrently with `Promise.all`:

```ts
async check(): Promise<void> {
  await Promise.all(this.checks.map((healthCheck) => healthCheck.check()));
}
```

The container composes it from two members — `databaseHealthCheck` (`PrismaHealthCheck`) and
`redisHealthCheck` (`RedisHealthCheck`). The **aggregation rule is all-or-nothing**: `Promise.all`
resolves only if _every_ member resolves, and rejects with the _first_ member that rejects. So
overall readiness is healthy only when all component checks pass, and the moment any one fails the
composite rejects and the route returns `503`. The composite does **not** merge or expose per-member
status in the response body — the caller always sees the same fixed `{ status: 'unavailable' }`
literal; _which_ dependency failed is captured only in the `readiness check failed` server log line
(the first rejecting member's `Error`). The two members:

- **`PrismaHealthCheck`** runs the raw query `SELECT 1` through the shared Prisma client. It confirms
  the connection pool can acquire a working connection without depending on any table or row; if the
  database is unreachable the query rejects.
- **`RedisHealthCheck`** issues `PING` on a dedicated Redis connection and expects the reply `PONG`
  (any other reply throws `unexpected Redis PING reply: <reply>`). The call is wrapped in a
  `Promise.race` against a timer, so a hung Redis rejects with `Redis health check timed out after
<ms>ms` rather than stalling the request; the timer is always cleared in a `finally`.

## Architecture

The application layer owns the abstraction — the `HealthCheck` **port**, a one-method interface that
says nothing about _which_ dependency is probed or _how_. The infrastructure layer supplies the
**adapters**: `PrismaHealthCheck` and `RedisHealthCheck` each probe one dependency, and
`CompositeHealthCheck` is itself a `HealthCheck` that composes other `HealthCheck`s (the Composite
pattern). The presentation layer (the route) depends only on the port; it is unaware that readiness
is backed by a database _and_ Redis, or that there is more than one probe at all. Concretes bind to
the port in exactly one place — `container.ts` — preserving the inward dependency direction:
presentation and infrastructure both point toward the application-layer abstraction, never at each
other. Adding or removing a dependency from readiness is a `container.ts` edit; the route and schemas
never change.

| Component                                                               | Layer          | Responsibility                                                                                                                                                 | File                                                      |
| ----------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HealthCheck`                                                           | Application    | Port: `check(): Promise<void>` — resolves if a critical dependency is healthy, rejects if not                                                                  | `src/application/shared/ports/health-check.ts`            |
| `CompositeHealthCheck`                                                  | Infrastructure | Adapter: fans out to its member checks with `Promise.all`; resolves only if all resolve, rejects on the first failure; throws if constructed with zero members | `src/infrastructure/health/composite-health-check.ts`     |
| `PrismaHealthCheck`                                                     | Infrastructure | Adapter: probes the database with `` $queryRaw`SELECT 1` ``                                                                                                    | `src/infrastructure/persistence/prisma-health-check.ts`   |
| `RedisHealthCheck`                                                      | Infrastructure | Adapter: probes the BullMQ Redis with `PING`/`PONG`, bounded by a `HEALTHCHECK_TIMEOUT_MS` timeout                                                             | `src/infrastructure/jobs/redis-health-check.ts`           |
| `createRedisConnection`                                                 | Infrastructure | Generic Redis connection factory; used here to create the dedicated `healthCheckRedisConnection`                                                               | `src/infrastructure/jobs/redis-connection.ts`             |
| `healthRoutes`                                                          | Presentation   | Registers `GET /health/live` and `GET /health/ready`; disables rate limiting and tags routes `Health`                                                          | `src/presentation/http/routes/health-routes.ts`           |
| `livenessResponse`, `readinessResponse`, `readinessUnavailableResponse` | Presentation   | Zod response schemas fixing each body to a single literal status for the OpenAPI contract                                                                      | `src/presentation/http/schemas/health-response-schema.ts` |

## Public surface

Both endpoints are **public**: they are not guarded by the `authenticate` preHandler, require no
bearer token or permission, and are exempt from rate limiting (`rateLimit: false`). They are mounted
under the `/health` prefix in `app.ts`.

| Method | Path            | Auth          | Purpose                                                                              |
| ------ | --------------- | ------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/health/live`  | None (public) | Liveness — is the process up?                                                        |
| `GET`  | `/health/ready` | None (public) | Readiness — is the process able to serve, i.e. are the database and Redis reachable? |

Responses by state:

| Endpoint            | State                      | Status | Body                          |
| ------------------- | -------------------------- | ------ | ----------------------------- |
| `GET /health/live`  | process running            | `200`  | `{ "status": "ok" }`          |
| `GET /health/ready` | all dependencies healthy   | `200`  | `{ "status": "ready" }`       |
| `GET /health/ready` | any dependency unreachable | `503`  | `{ "status": "unavailable" }` |

The liveness endpoint has no failure body: if the process cannot respond at all, the orchestrator's
own connection timeout is the failure signal.

The `HealthCheck` port that the readiness route — and every adapter — programs against:

```ts
export interface HealthCheck {
  check(): Promise<void>;
}
```

`check()` returns `Promise<void>`; health is communicated by _resolution vs. rejection_, not by a
return value. A resolved promise means healthy; any rejection means unhealthy and is mapped to `503`.

## Configuration

The readiness probe reads two variables directly and one transitively (through the shared Prisma
client). All are parsed in `src/config/env.ts` and mirrored in `.env.example`.

| Variable                 | Default                                                                              | Meaning                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEALTHCHECK_TIMEOUT_MS` | `2000`                                                                               | Milliseconds the Redis `PING` may take before `RedisHealthCheck` rejects with a timeout. Bound into the container as `healthCheckTimeoutMs`.                    |
| `REDIS_URL`              | `redis://127.0.0.1:6379` (dev default; **required in production** — no prod default) | Connection string for the dedicated `healthCheckRedisConnection` that `RedisHealthCheck` pings.                                                                 |
| `DATABASE_URL`           | (required, no default)                                                               | Connection string for the Prisma client that `PrismaHealthCheck` probes with `SELECT 1`. Read transitively via the shared client, not by this feature directly. |

## Usage & extension

**Calling the probes.** Point your orchestrator's liveness probe at `GET /health/live` and its
readiness probe at `GET /health/ready`. A Kubernetes example:

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

The `port` above must match the port the service actually listens on (`PORT`, default `8000`) — set
it to whatever `PORT` is configured to in the target environment rather than copying `8000` blindly.
Kubernetes treats any `2xx`/`3xx` as pass and anything else as fail, so the explicit `503` on
`/health/ready` reliably pulls the pod out of the Service's endpoints until the dependencies recover.

**Adding a new component health check.** Because the route depends only on the `HealthCheck` port and
the container composes the readiness probe from a `CompositeHealthCheck`, you extend readiness by
writing one more adapter and adding it to the composite — the route and schemas never change. To also
require, say, an external HTTP dependency to be reachable:

1. **Write the adapter** in the infrastructure layer, implementing `HealthCheck`. Constructor
   parameters are destructured from the Awilix cradle by name (the app uses `injectionMode: 'PROXY'`),
   so each parameter name must match a registered cradle key. Reuse the existing
   `healthCheckTimeoutMs` cradle value to keep every probe on the same timeout budget:

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
   `src/container.ts`:

   ```ts
   dependencyHealthCheck: HealthCheck;
   dependencyHealthUrl: string;
   ```

3. **Register the adapter (and any value it needs)** in `registerDependencies`, alongside the
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

The new dependency is now part of readiness: `Promise.all` rejects on the first failing member, so
`GET /health/ready` returns `503` the moment any probe — including the new one — fails.

## Design decisions & trade-offs

- **Readiness aggregates dependencies; liveness does not.** The two probes answer different questions
  and drive different orchestrator actions. A failed **liveness** probe means _restart the pod_, so
  liveness stays cheap and dependency-free — its handler does no I/O and fails only when _this
  process_ is broken. A failed **readiness** probe means _stop routing traffic here but leave the
  process running_, which is exactly the right response to a dependency outage: the pod is drained
  from the load balancer / Service endpoints and rejoins automatically once the dependency recovers.
  Folding the dependency checks into liveness would let a transient database or Redis blip trigger a
  restart storm across every replica — a restart cannot fix an _external_ dependency and only
  amplifies the outage.

- **Both the database and Redis gate readiness.** The service cannot do useful work if its primary
  datastore is down, and — because BullMQ background processing and the Redis-backed rate limiter run
  on Redis — it also cannot function normally if Redis is unreachable. Aggregating both into
  readiness means an instance is pulled from rotation whenever _either_ is down, rather than serving
  requests it cannot complete.

- **`CompositeHealthCheck` with `Promise.all` (fail-fast, all-or-nothing, concurrent).** Readiness is
  binary for a load balancer, so the aggregation is a boolean AND: any critical dependency down means
  not ready. Running the members concurrently makes the probe's latency the _slowest single_ check
  rather than the sum of all checks. The trade-off is that the composite surfaces only the first
  failing member and does not report a per-dependency breakdown in the response — acceptable because
  the orchestrator only needs pass/fail, and operators get the specific failure from the logs.

- **The response body never names the failing dependency.** On failure the body is a fixed
  `{ status: 'unavailable' }` literal; the underlying `Error` is written to the log line
  `readiness check failed` instead. Health endpoints are unauthenticated and internet-reachable, so
  the body intentionally leaks nothing — no dependency name, version, or error detail — while
  operators retain full visibility through structured logs.

- **The Redis probe has an explicit timeout; the Prisma probe relies on the driver.** `RedisHealthCheck`
  races `redis.ping()` against a `HEALTHCHECK_TIMEOUT_MS` timer because the health connection is
  created with `maxRetriesPerRequest: null`, on which a command against an unreachable server can wait
  indefinitely — the timeout converts a stall into a prompt `503`. `PrismaHealthCheck` leans on the
  database driver's own connection/query timeouts, so `SELECT 1` needs no extra guard.

- **A dedicated `healthCheckRedisConnection`, separate from the queue and worker connections.** The
  probe pings its own Redis connection rather than reusing `redisConnection` or `workerConnection`.
  BullMQ's worker runs blocking commands and ioredis serializes commands over a single socket, so
  sharing a connection risks head-of-line blocking that could delay the `PING` reply past the timeout
  and report a false _unavailable_ under heavy queue load. A dedicated connection keeps probe latency
  independent of job traffic; the cost is one extra Redis connection, disposed on container teardown.

- **`SELECT 1` rather than a table/row query.** The database probe only needs to confirm the pool can
  reach the server and get a working connection, not to validate schema or data. `SELECT 1` is the
  cheapest query that exercises the full connection path and stays valid across migrations because it
  references nothing schema-specific.

- **The `503` is sent directly by the handler, not routed through the error handler.** Readiness
  failure is an _expected_, well-defined outcome (a dependency is down), not an application error.
  Returning a fixed `{ status: 'unavailable' }` payload keeps the probe response stable and
  independent of the global error-response shape — which is why `readinessUnavailableResponse` exists
  as its own schema rather than reusing the shared `errorResponse`.

- **Both probes are public and rate-limit-exempt.** Orchestrator probes are unauthenticated by
  necessity — the kubelet has no credentials — and poll frequently (often every few seconds per
  replica). Setting `rateLimit: false` in the plugin's `onRoute` hook prevents the global rate limiter
  registered by [HTTP Infrastructure](./http-infrastructure.md) from ever returning `429` to a probe,
  which would otherwise be misread as an outage.

- **Fixed single-literal Zod schemas.** Each response body is pinned with `z.literal(...)`
  (`ok` / `ready` / `unavailable`). This documents the exact contract in the generated OpenAPI spec
  and makes the probe output a stable, testable constant rather than a free-form object.

## Testing

Unit tests run with `npm test` (Vitest); the integration tests run with `npm run test:integration`;
`npm run audit` runs the full gate (lockfile check, format, lint, typecheck, coverage, integration).

- **Unit — `src/infrastructure/health/composite-health-check.test.ts`.** Covers the aggregation
  contract: construction throws when given zero checks; `check()` resolves when every member resolves;
  every member is invoked; and `check()` rejects with the failure when _any_ member rejects.

- **Unit — `src/infrastructure/jobs/redis-health-check.test.ts`.** Drives the Redis probe against a
  fake `Redis`: resolves when `PING` replies `PONG`; rejects on any other reply
  (`unexpected Redis PING reply`); rejects when the connection fails (`ECONNREFUSED`); and rejects on
  timeout using Vitest fake timers (`timed out`).

- **Unit — `src/presentation/http/routes/health-routes.test.ts`.** Builds a minimal Fastify app with
  the Zod serializer and a mocked `HealthCheck` registered into the Awilix container, then drives the
  routes via `app.inject`. Asserts that `GET /health/live` returns `200` / `{ status: 'ok' }` and
  **never** calls `healthCheck.check()`; that `GET /health/ready` returns `200` / `{ status: 'ready' }`
  and invokes `check()` exactly once; and that it returns `503` / `{ status: 'unavailable' }` when
  `check()` rejects.

- **Integration — `test/integration/health.int.test.ts`.** Starts a real Redis via Testcontainers
  (`redis:7.4-alpine`), wraps a `RedisHealthCheck` in a `CompositeHealthCheck`, and asserts the probe
  resolves while Redis is reachable and rejects once the container is stopped — exercising the real
  `PING`/`PONG` path against a live server.

- **Integration — `test/integration/app-bootstrap.int.test.ts`.** Boots the real application via
  `buildApp(...)` and asserts both `GET /health/live` and `GET /health/ready` are wired and served
  (`200` with the expected bodies) through the fully assembled app.
