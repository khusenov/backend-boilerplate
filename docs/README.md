# Finflow Backend — Documentation

A TypeScript clean-architecture backend built on **Fastify** (HTTP), **Awilix** (dependency injection), **Prisma** (persistence), and **BullMQ** (background jobs). This directory is the documentation index; each feature is explained in its own document under [`features/`](./features/).

> **Verified against:** `329a35a`

## API reference

The interactive API reference (Swagger UI) is served at **`/docs`**, and is available in **non-production environments only** — it is registered behind an `if (!env.isProduction)` guard in `src/presentation/http/app.ts`. The underlying OpenAPI specification is **auto-generated** from the routes' Zod schemas (via `@fastify/swagger` and `@fastify/swagger-ui`), so it tracks the code rather than being maintained by hand. Point readers there for endpoint-level request and response detail; the per-feature docs below explain the "why and how".

## Architecture at a glance

The codebase follows clean architecture. Each layer has a fixed responsibility and a strict set of things it may import.

| Layer            | Path                             | Contains                                                                                                                                | May import                                                 |
| ---------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Domain           | `src/domain/**`                  | Entities, value objects (e.g. `Email`), domain errors, repository **interfaces**, domain events                                         | Nothing outside `domain` (no framework, no Prisma, no I/O) |
| Application      | `src/application/**`             | Use-case classes (`CreateUser`…) with constructor DI + `execute()`; **ports** in `application/shared/ports/**`; DTOs + mappers          | `domain` + its own ports only                              |
| Infrastructure   | `src/infrastructure/**`          | Adapters implementing ports/repos (Prisma repos & mappers, argon2 hasher, jose/crypto token services, BullMQ queue/worker, Pino logger) | `domain`, `application` ports, concrete libs/Prisma        |
| Presentation     | `src/presentation/http/**`       | Fastify app, routes, plugins, identity mapping, error handler, security, cookies, Zod response schemas                                  | `application`, Fastify                                     |
| Composition root | `src/container.ts`               | Awilix wiring (`asClass`/`asFunction`/`asValue`, typed `Cradle`)                                                                        | Everything — the **only** place concretes bind to ports    |
| Shared / Config  | `src/shared/**`, `src/config/**` | Pagination, error base types, env parsing (`envalid`)                                                                                   | Keep framework-free where possible                         |

**The Dependency Rule:** dependencies point **inward** — the domain depends on nothing, the application depends only on the domain plus its own ports, and infrastructure and presentation depend inward through abstractions. Concrete implementations are bound to those ports in **one place only**, `src/container.ts`.

## Feature documentation

One row per document under [`features/`](./features/). Each summary is drawn from that doc's own Purpose section.

| Feature                  | Doc                                                                | Summary                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | [authentication](./features/authentication.md)                     | Exchanges a user's email and password for a session, issuing a short-lived access token and a long-lived refresh token so most requests authenticate statelessly while sessions stay revocable.                                                                 |
| Background Jobs          | [background-jobs](./features/background-jobs.md)                   | Moves slow, retryable, or scheduled work off the request path onto a durable Redis-backed BullMQ queue behind generic producer/consumer ports (`JobQueue`, `JobScheduler`, `JobHandler`), with a guarded Bull Board dashboard.                                  |
| Data Retention           | [data-retention](./features/data-retention.md)                     | A scheduled housekeeping job that prunes stale rows — expired refresh tokens and already-relayed outbox messages — through an open set of `RetentionTask` prune adapters the scheduler knows nothing about.                                                     |
| Domain Events            | [domain-events](./features/domain-events.md)                       | Lets an aggregate announce a business fact that has already happened without knowing who reacts, delivering it to independent handlers at least once via a transactional outbox relayed on the background-job queue.                                            |
| Health Checks            | [health-checks](./features/health-checks.md)                       | Exposes separate unauthenticated liveness (`/health/live`) and readiness (`/health/ready`) endpoints so orchestrators and load balancers can decide whether to restart a process or drain it from rotation.                                                     |
| HTTP Infrastructure      | [http-infrastructure](./features/http-infrastructure.md)           | The shared Fastify composition root: `buildApp` fixes cross-cutting plugin order and defines request validation, response shaping, and the uniform JSON error envelope that every HTTP feature sits on.                                                         |
| Metrics                  | [metrics](./features/metrics.md)                                   | Publishes request throughput, latency distribution, error rates, and Node/process health in Prometheus text format at `GET /metrics`, recording a latency histogram for every HTTP response behind a port.                                                      |
| Role-Based Authorization | [role-based-authorization](./features/role-based-authorization.md) | Decides whether a caller may act by modelling access as a fixed in-code permission catalogue bundled into operator-managed roles, checked cheaply against grants carried on the access token.                                                                   |
| Structured Logging       | [structured-logging](./features/structured-logging.md)             | Emits one JSON record per line behind a framework-agnostic `Logger` port (Pino adapter), adding a per-request correlation id, trace/span-id injection, and sensitive-field redaction, then ships lines to Grafana Loki.                                         |
| Distributed Tracing      | [tracing](./features/tracing.md)                                   | Boots the OpenTelemetry SDK to auto-instrument HTTP and Prisma into spans, exports them to an OTLP collector, stamps every log line with the active `trace_id`/`span_id`, and carries the trace across the BullMQ job boundary; opt-in and not container-wired. |
| User CRUD                | [user-crud](./features/user-crud.md)                               | Owns the user-account lifecycle — list, read, create, edit, and soft-delete over HTTP — as the reference vertical slice wired through every architectural layer that every other feature copies in shape.                                                       |

## Documentation coverage

All currently-complete features are documented; none were skipped as in-progress in the latest documentation run.
