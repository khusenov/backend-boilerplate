# Backend Boilerplate — Documentation

A TypeScript clean-architecture backend boilerplate built on **Fastify** (HTTP), **Awilix** (dependency injection), **Prisma** (persistence), and **BullMQ** (background jobs). This directory is the documentation index; every feature is explained in its own document under [`features/`](./features/).

> **Verified against:** `v1.0.0`

## API reference

The interactive API reference (Swagger UI) is served at **`/docs`**. It is mounted in `buildApp` (`src/presentation/http/app.ts`) behind an `if (!env.isProduction)` guard, so it exists in **non-production environments only** — note that the compose stack runs `NODE_ENV=production`, so `/docs` returns 404 there. `@fastify/swagger` builds the OpenAPI document (title `<APP_NAME> API`, bearer-JWT security scheme) from the routes' Zod schemas via `jsonSchemaTransform`, and `@fastify/swagger-ui` registers the UI with `routePrefix: '/docs'`. Because the spec is generated from the route schemas rather than maintained by hand, it tracks the code. Go there for endpoint-level request and response detail; the per-feature docs below explain the _why_ and _how_.

## Application identity

Names throughout the system derive from a single environment variable, **`APP_NAME`** (default `app`). `src/config/app-identity.ts` reads it once and exports the derived identity; `src/config/env.ts` uses those values as the defaults for the individual variables. Every default below is still overridable by setting its own variable explicitly.

| Derived value        | Default                     | Where it surfaces                                                                                                               |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ISSUER`         | `<APP_NAME>`                | `iss` claim on access tokens — [authentication](./features/authentication.md)                                                   |
| `JWT_AUDIENCE`       | `<APP_NAME>-api`            | `aud` claim on access tokens — [authentication](./features/authentication.md)                                                   |
| `QUEUE_PREFIX`       | `<APP_NAME>`                | Redis key namespace for every queue — [background jobs](./features/background-jobs.md)                                          |
| `OTEL_SERVICE_NAME`  | `<APP_NAME>-api`            | `service` on logs, spans and metrics — [tracing](./features/tracing.md), [structured logging](./features/structured-logging.md) |
| `EMAIL_FROM`         | `no-reply@<APP_NAME>.local` | Envelope sender outside production — [email sending](./features/email-sending.md)                                               |
| `swaggerTitle`       | `<APP_NAME> API`            | OpenAPI document title                                                                                                          |
| `bullBoardRealm`     | `<APP_NAME> Queues`         | HTTP Basic realm on the queue dashboard — [background jobs](./features/background-jobs.md)                                      |
| `rateLimitNamespace` | `<APP_NAME>-rate-limit-`    | Rate-limit key prefix — [HTTP infrastructure](./features/http-infrastructure.md)                                                |

The worker process is the one exception to the `-api` suffix: `docker-compose.yml` sets its `OTEL_SERVICE_NAME` to `<APP_NAME>-worker` so the two deployables are distinguishable in Grafana.

**Two places `APP_NAME` cannot reach**, because they are read before any application code runs, and they must agree with each other: the compose project name (`name:` on line 1 of `docker-compose.yml`) and the container-matching `regex` in `docker/alloy/config.alloy`. Alloy keeps only containers whose compose-project label matches that regex, so changing one without the other stops log shipping silently. See [Renaming the project](../README.md#renaming-the-project).

## Architecture at a glance

| Layer            | Path                                     | Contains                                                                                                                                | May import                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Domain           | `src/domain/**`                          | Entities, value objects (e.g. `Email`), domain errors, repository **interfaces**, domain events                                         | Nothing outside `domain` (no framework, no Prisma, no I/O) |
| Application      | `src/application/**`                     | Use-case classes (`CreateUser`…) with constructor DI + `execute()`; **ports** in `application/shared/ports/**`; DTOs + mappers          | `domain` + its own ports only                              |
| Infrastructure   | `src/infrastructure/**`                  | Adapters implementing ports/repos (Prisma repos & mappers, argon2 hasher, jose/crypto token services, BullMQ queue/worker, Pino logger) | `domain`, `application` ports, concrete libs/Prisma        |
| Presentation     | `src/presentation/http/**`               | Fastify app, routes, plugins, guards, error handler, security, cookies, Zod response schemas                                            | `application`, Fastify                                     |
| Composition root | `src/composition/**`, `src/container.ts` | Awilix wiring (`asClass`/`asFunction`/`asValue`) split one file per module, each declaring its own `Cradle` slice                       | Everything — the **only** place concretes bind to ports    |
| Shared / Config  | `src/shared/**`, `src/config/**`         | Pagination, error base types, env parsing (`envalid`)                                                                                   | Keep framework-free where possible                         |

**The Dependency Rule:** dependencies point **inward**. The domain depends on nothing; the application depends on the domain plus its own ports; infrastructure and presentation depend inward through those abstractions. Concrete implementations are bound to ports **only** in `src/composition/**`; `src/container.ts` does nothing but hand the merged registration map to the container.

## Feature documentation

One row per document under [`features/`](./features/), in reading order: the request path first, then cross-cutting infrastructure, then operational concerns. Each summary is drawn from that doc's own Purpose section.

| Feature                    | Doc                                                                   | Summary                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP Infrastructure        | [http-infrastructure.md](./features/http-infrastructure.md)           | The shared Fastify composition root: `buildApp` fixes cross-cutting plugin order, mounts the versioned `/v1` surface, and defines request validation, response shaping, and the uniform JSON error envelope every HTTP feature sits on.    |
| Authentication             | [authentication.md](./features/authentication.md)                     | Answers "who is this caller?" by splitting proof of identity across a short-lived access token and a long-lived, server-stored refresh token — keeping the hot path free of database reads while sessions stay revocable.                  |
| Role-Based Authorization   | [role-based-authorization.md](./features/role-based-authorization.md) | Answers "is this caller allowed to do this?" from a compile-time permission catalogue bundled into operator-managed roles, checked cheaply against the grants carried on the access token.                                                 |
| User CRUD                  | [user-crud.md](./features/user-crud.md)                               | Owns the account lifecycle — list, read, create, edit, soft-delete over HTTP — and doubles as the reference vertical slice wired through every architectural layer that later features copy in shape.                                      |
| Email Verification         | [email-verification.md](./features/email-verification.md)             | Proves a caller controls the address they claimed: a self-registered user starts `pending` and must echo back a short-lived six-digit code, and the same proof is re-demanded whenever an existing address changes.                        |
| Password Reset             | [password-reset.md](./features/password-reset.md)                     | Self-service recovery through an emailed single-use, time-limited link — answering identically whether or not the address exists, storing only a token hash, and revoking every session on success.                                        |
| Idempotency                | [idempotency.md](./features/idempotency.md)                           | Lets a client stamp a mutating request with an `Idempotency-Key` so the server acts **once**, remembers the outcome, and replays the identical response to every retry within a bounded window.                                            |
| Unit of Work & Persistence | [unit-of-work.md](./features/unit-of-work.md)                         | Gives the application layer one way to say "these writes all commit together or none do", expressed as a port so a use case never learns the mechanism underneath is a Prisma interactive transaction.                                     |
| Domain Events              | [domain-events.md](./features/domain-events.md)                       | Lets an aggregate announce a business fact that has already happened without knowing who reacts, delivered through a transactional outbox written in the same transaction and relayed asynchronously on the job queue.                     |
| Background Jobs            | [background-jobs.md](./features/background-jobs.md)                   | The generic transport that moves slow, retryable, or scheduled work onto a durable Redis-backed BullMQ queue behind `JobQueue` / `JobScheduler` / `JobHandler` ports, with a separate worker process and a guarded Bull Board dashboard.   |
| Email Sending              | [email-sending.md](./features/email-sending.md)                       | The delivery mechanism shared by verification and password-reset mail: the `EmailSender` port and its `NodemailerEmailSender` adapter, so sending is a one-line port call while every SMTP concern stays in one infrastructure file.       |
| Data Retention             | [data-retention.md](./features/data-retention.md)                     | A scheduled housekeeping job that prunes stale rows — long-expired tokens and already-relayed outbox messages — through an open set of `RetentionTask` adapters the job and its schedule know nothing about.                               |
| Health Checks              | [health-checks.md](./features/health-checks.md)                       | Separate unauthenticated liveness (`GET /health/live`) and readiness (`GET /health/ready`) endpoints for both deployable processes, so an orchestrator can tell "restart this instance" from "drain it from rotation".                     |
| Metrics                    | [metrics.md](./features/metrics.md)                                   | Publishes request throughput, latency distribution, error rates, and process health in Prometheus text exposition format, with two scrape surfaces because the service runs as two processes (API and worker).                             |
| Distributed Tracing        | [tracing.md](./features/tracing.md)                                   | Boots the OpenTelemetry SDK in both processes to auto-instrument HTTP and Prisma into spans, exports them to an OTLP collector, stamps every log line with `trace_id`/`span_id`, and carries the trace across the BullMQ boundary; opt-in. |
| Structured Logging         | [structured-logging.md](./features/structured-logging.md)             | Emits one JSON record per line behind a framework-agnostic `Logger` port, correlating every line with its request (and trace), redacting sensitive values before they reach the sink, and shipping the result to centralised search.       |
| Graceful Shutdown          | [graceful-shutdown.md](./features/graceful-shutdown.md)               | Gives both entry points one shared reaction to `SIGTERM`: quiesce, release every long-lived resource (Prisma pool, Redis connections, queue, worker, scheduler), flush telemetry, and exit before `SIGKILL` arrives.                       |

## Notes on coverage

Every feature discovered in this codebase was complete enough to document — none was skipped as in-progress.

Two sub-components are wired but dormant, and the relevant docs call each out:

- **`InProcessDomainEventDispatcher`** is registered in `src/composition/events.ts` but resolved nowhere outside its own test; the live dispatch path goes through `DomainEventHandlerRegistry` (see [domain-events.md](./features/domain-events.md)).
- **The `example.ping` job** (`EXAMPLE_JOB` / `ExampleJobHandler`) is fully wired into the worker but enqueued only from the transport integration tests; it serves as a template for new jobs (see [background-jobs.md](./features/background-jobs.md)).
