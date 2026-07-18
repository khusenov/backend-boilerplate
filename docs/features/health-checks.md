# Health Checks

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `46c4a07`

## Purpose

Container orchestrators (Kubernetes, ECS, Nomad) and load balancers need machine-readable signals to
decide two independent things: _is this process alive?_ and _is this process ready to serve traffic?_
This feature exposes those two signals as separate, unauthenticated HTTP endpoints. **Liveness**
(`/health/live`) reports only that the Node process is running and its event loop can answer; failing
it tells the orchestrator to **restart** the pod. **Readiness** (`/health/ready`) additionally verifies
that a critical downstream dependency — the database — is reachable; failing it tells the orchestrator
to **remove the instance from rotation** without killing it, so it can recover.

## How it works

Both endpoints are registered by the `healthRoutes` Fastify plugin under the `/health` prefix (see
`app.ts`). An `onRoute` hook applied inside the plugin tags every route it registers with the
`Health` OpenAPI tag and sets `rateLimit: false`, so the health probes are never throttled even when
the global rate limiter is active.

- **`GET /health/live`** — the handler is synchronous and returns `{ status: 'ok' }` with HTTP `200`.
  It performs no I/O and never touches the database; a response at all proves the process is up and
  the event loop is servicing requests. The co-located unit test asserts the readiness dependency is
  _not_ invoked on this path.

- **`GET /health/ready`** — the handler resolves the `healthCheck` port from the request's Awilix
  scope (`request.diScope.cradle`) and awaits `healthCheck.check()`.
  - On success it returns `{ status: 'ready' }` with HTTP `200`.
  - On failure (the `check()` promise rejects) it logs the error via `request.log.error(...)` with
    the message `readiness check failed`, then replies `503` with body `{ status: 'unavailable' }`.
    The `503` body is sent directly by the handler via `reply.status(503).send(...)`, so it bypasses
    the application error handler entirely.

The concrete `HealthCheck` bound in the container is `PrismaHealthCheck`, whose `check()` executes the
raw query `SELECT 1` through Prisma. If the database is unreachable the query rejects, which the
route translates into the `503`. The `SELECT 1` round-trip is deliberately trivial: it confirms the
connection pool can acquire a working connection without depending on any table or row.

## Architecture

The application layer owns the abstraction — the `HealthCheck` **port**, a one-method interface that
says nothing about _which_ dependency is probed or _how_. The infrastructure layer supplies the
**adapter**, `PrismaHealthCheck`, which knows about Prisma and SQL. The presentation layer (the route)
depends only on the port; it is unaware that readiness is backed by a database. Concretes bind to the
port in exactly one place — `container.ts` — preserving the inward dependency direction: presentation
and infrastructure both point toward the application-layer abstraction, never at each other.

| Component                                                               | Layer          | Responsibility                                                                                        | File                                                      |
| ----------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `HealthCheck`                                                           | Application    | Port: `check(): Promise<void>` — resolves if a critical dependency is healthy, rejects if not         | `src/application/shared/ports/health-check.ts`            |
| `PrismaHealthCheck`                                                     | Infrastructure | Adapter: probes the database with `` $queryRaw`SELECT 1` ``                                           | `src/infrastructure/persistence/prisma-health-check.ts`   |
| `healthRoutes`                                                          | Presentation   | Registers `GET /health/live` and `GET /health/ready`; disables rate limiting and tags routes `Health` | `src/presentation/http/routes/health-routes.ts`           |
| `livenessResponse`, `readinessResponse`, `readinessUnavailableResponse` | Presentation   | Zod response schemas fixing each body to a single literal status for the OpenAPI contract             | `src/presentation/http/schemas/health-response-schema.ts` |

## Public surface

Both endpoints are **public**: they are not guarded by the `authenticate` preHandler, require no
bearer token or permission, and are exempt from rate limiting (`rateLimit: false`). They are mounted
under the `/health` prefix in `app.ts`.

| Method | Path            | Auth          | Purpose                                                             |
| ------ | --------------- | ------------- | ------------------------------------------------------------------- |
| `GET`  | `/health/live`  | None (public) | Liveness — is the process up?                                       |
| `GET`  | `/health/ready` | None (public) | Readiness — is the process able to serve, i.e. is the DB reachable? |

Responses by state:

| Endpoint            | State                  | Status | Body                          |
| ------------------- | ---------------------- | ------ | ----------------------------- |
| `GET /health/live`  | process running        | `200`  | `{ "status": "ok" }`          |
| `GET /health/ready` | dependency healthy     | `200`  | `{ "status": "ready" }`       |
| `GET /health/ready` | dependency unreachable | `503`  | `{ "status": "unavailable" }` |

The liveness endpoint has no failure body: if the process cannot respond at all, the orchestrator's
own connection timeout is the failure signal.

The `HealthCheck` port that the readiness route programs against:

```ts
export interface HealthCheck {
  check(): Promise<void>;
}
```

`check()` returns `Promise<void>`; readiness is communicated by _resolution vs. rejection_, not by a
return value. A resolved promise means healthy; any rejection means unhealthy and is mapped to `503`.

## Configuration

This feature defines **no environment variables of its own**. It relies transitively on the
persistence-layer configuration parsed in `src/config/env.ts` (and mirrored in `.env.example`): the
readiness probe's `PrismaHealthCheck` runs through the shared Prisma client, which reads
`DATABASE_URL`.

| Variable       | Default                | Meaning                                                                                                         |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | (required, no default) | Connection string for the Prisma client that `PrismaHealthCheck` probes with `SELECT 1` on `GET /health/ready`. |

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
`/health/ready` reliably pulls the pod out of the Service's endpoints until the database recovers.

**Adding another dependency to the readiness check.** The readiness route depends only on the
`HealthCheck` port, so you extend readiness by changing which adapter the container binds — the route
never changes. To also require Redis to be reachable, write a composite adapter and bind it in place
of `PrismaHealthCheck`:

```ts
// src/infrastructure/persistence/composite-health-check.ts
import type { HealthCheck } from '@/application/shared/ports/health-check';

interface CompositeHealthCheckDeps {
  checks: HealthCheck[];
}

export class CompositeHealthCheck implements HealthCheck {
  private readonly checks: HealthCheck[];

  constructor({ checks }: CompositeHealthCheckDeps) {
    this.checks = checks;
  }

  async check(): Promise<void> {
    await Promise.all(this.checks.map((c) => c.check()));
  }
}
```

Then, in `src/container.ts`, replace the single-adapter registration:

```ts
healthCheck: asFunction(
  ({ prisma, redisConnection }: Pick<Cradle, 'prisma' | 'redisConnection'>) =>
    new CompositeHealthCheck({
      checks: [
        new PrismaHealthCheck({ prisma }),
        new RedisHealthCheck({ redis: redisConnection }),
      ],
    }),
).singleton(),
```

`Promise.all` rejects on the first failing dependency, so the route still returns `503` the moment any
probe fails — no route or schema change required.

## Design decisions & trade-offs

- **Separate liveness and readiness endpoints, not one `/health`.** They answer different questions
  and drive different orchestrator actions: a failed liveness probe means _restart the pod_, a failed
  readiness probe means _stop routing traffic here but leave it running_. Collapsing them into one
  endpoint would force a transient database blip to restart an otherwise-healthy process, causing
  needless churn. Two endpoints keep the two remediation paths independent.

- **Readiness probes the database; liveness does not.** Liveness must stay cheap and dependency-free —
  it should fail only when _this process_ is broken, so its handler does no I/O. Readiness is where a
  dependency check belongs, because "ready to serve" is meaningless if the primary datastore is down.
  Coupling the DB check into liveness would let a database outage trigger a restart storm across every
  replica, which cannot fix an external dependency and only amplifies the outage.

- **`SELECT 1` rather than a table/row query.** The readiness probe needs to confirm the connection
  pool can reach the server and get a connection, not to validate schema or data. `SELECT 1` is the
  cheapest query that exercises the full connection path, and it stays valid across migrations because
  it references nothing schema-specific.

- **The `503` body is sent directly by the handler, not routed through the error handler.** Readiness
  failure is an _expected_, well-defined outcome (dependency down), not an application error. Returning
  a fixed `{ status: 'unavailable' }` payload keeps the probe response stable and independent of the
  global error-response shape, which is why `readinessUnavailableResponse` exists as its own schema
  rather than reusing the shared `errorResponse`. The failure is still logged (`request.log.error`) so
  operators retain visibility.

- **Both probes are public and rate-limit-exempt.** Orchestrator health probes are unauthenticated by
  necessity — the kubelet has no credentials — and they poll frequently (often every few seconds per
  replica). Setting `rateLimit: false` in the plugin's `onRoute` hook prevents the global rate limiter
  from ever returning `429` to a probe, which would otherwise be misread as an outage. The bodies leak
  nothing sensitive: a single fixed status literal, no version, no dependency detail.

- **Fixed single-literal Zod schemas.** Each response body is pinned with `z.literal(...)`
  (`ok` / `ready` / `unavailable`). This documents the exact contract in the generated OpenAPI spec and
  makes the probe output a stable, testable constant rather than a free-form object.

## Testing

Two test files cover this feature; run both with `npm test` (Vitest), or the whole gate with
`npm run audit`.

- **Unit — `src/presentation/http/routes/health-routes.test.ts`.** Builds a minimal Fastify app with
  the Zod serializer and a mocked `HealthCheck` registered into the Awilix container, then drives the
  routes via `app.inject`. It asserts:
  - `GET /health/live` returns `200` / `{ status: 'ok' }` **and** never calls `healthCheck.check()`
    (proving liveness is dependency-free).
  - `GET /health/ready` returns `200` / `{ status: 'ready' }` when `check()` resolves, and that
    `check()` is invoked exactly once.
  - `GET /health/ready` returns `503` / `{ status: 'unavailable' }` when `check()` rejects.

- **Integration — `test/integration/app-bootstrap.int.test.ts`.** Boots the real application via
  `buildApp(...)` and asserts that both `GET /health/live` and `GET /health/ready` are actually wired
  and served (`200` with the expected bodies) through the fully assembled app. Run the integration
  suite on its own with `npm run test:integration`.
