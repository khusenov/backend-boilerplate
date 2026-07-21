# Finflow Backend — Documentation

Finflow Backend is a TypeScript clean-architecture backend — built on Fastify, Awilix, Prisma, and BullMQ — that implements user management, authentication, and role-based authorization over a domain-event core, with production-grade observability (structured logging, metrics, distributed tracing, health checks) and shared HTTP and background-job infrastructure.

## API reference

The full HTTP API is documented as an OpenAPI/Swagger UI served at [`/docs`](/docs), registered via `@fastify/swagger` and `@fastify/swagger-ui` in `src/presentation/http/app.ts`. It is gated to non-production environments only (`if (!env.isProduction)`). Point readers there for endpoint-level request and response detail; the per-feature docs below explain the "why and how".

## Architecture at a glance

The codebase follows clean architecture. Each layer has a fixed responsibility and a strict set of things it may import:

| Layer            | Path                             | Contains                                                                                                                                | May import                                                 |
| ---------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Domain           | `src/domain/**`                  | Entities, value objects (e.g. `Email`), domain errors, repository **interfaces**, domain events                                         | Nothing outside `domain` (no framework, no Prisma, no I/O) |
| Application      | `src/application/**`             | Use-case classes (`CreateUser`…) with constructor DI + `execute()`; **ports** in `application/shared/ports/**`; DTOs + mappers          | `domain` + its own ports only                              |
| Infrastructure   | `src/infrastructure/**`          | Adapters implementing ports/repos (Prisma repos & mappers, argon2 hasher, jose/crypto token services, BullMQ queue/worker, Pino logger) | `domain`, `application` ports, concrete libs/Prisma        |
| Presentation     | `src/presentation/http/**`       | Fastify app, routes, plugins, guards, error handler, security, cookies, Zod response schemas                                            | `application`, Fastify                                     |
| Composition root | `src/container.ts`               | Awilix wiring (`asClass`/`asFunction`/`asValue`, typed `Cradle`)                                                                        | Everything — the **only** place concretes bind to ports    |
| Shared / Config  | `src/shared/**`, `src/config/**` | Pagination, error base types, env parsing (`envalid`)                                                                                   | Keep framework-free where possible                         |

**The Dependency Rule:** dependencies point **inward**. Domain depends on nothing; application depends on domain plus its own ports; infrastructure and presentation depend inward through abstractions. Concrete implementations are bound to ports **only** in `src/container.ts`.

## Feature documentation

Grouped by theme — the core domain first, then the infrastructure and cross-cutting concerns every feature sits on. Each summary is drawn from that doc's own Purpose.

| Feature                  | Doc                                                                | Summary                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User CRUD                | [user-crud](./features/user-crud.md)                               | Owns the user-account lifecycle — list, read, create, edit, delete over HTTP — as the reference vertical slice wired through every architectural layer that every other feature copies in shape.                                     |
| Authentication           | [authentication](./features/authentication.md)                     | Answers "who is this caller?" by exchanging a user's email and password for a session split across a short-lived access token and a long-lived refresh token.                                                                        |
| Role-based authorization | [role-based-authorization](./features/role-based-authorization.md) | Answers "is this caller allowed to do this?" by modelling access as a fixed in-code permission catalogue bundled into operator-managed roles assigned to users.                                                                      |
| Domain events            | [domain-events](./features/domain-events.md)                       | Lets an aggregate announce a business fact that has already happened, delivered to independent handlers at least once via a transactional outbox relayed on the background-job queue.                                                |
| HTTP infrastructure      | [http-infrastructure](./features/http-infrastructure.md)           | Assembles the shared Fastify app (`buildApp`) — plugin order, request validation, response shaping, security headers, and the uniform JSON error envelope — that every HTTP feature sits on.                                         |
| Background jobs          | [background-jobs](./features/background-jobs.md)                   | Moves slow, retryable, or scheduled work off the request path onto a durable Redis-backed BullMQ queue, behind generic producer/consumer ports (`JobQueue`, `JobScheduler`, `JobHandler`).                                           |
| Structured logging       | [structured-logging](./features/structured-logging.md)             | Provides a framework-agnostic `Logger` port with a Pino-backed adapter, a per-request correlation id, sensitive-field redaction, and trace/span-id injection, so inner layers log without a concrete library.                        |
| Health checks            | [health-checks](./features/health-checks.md)                       | Exposes separate unauthenticated liveness (`/health/live`) and readiness (`/health/ready`) endpoints so orchestrators and load balancers can decide whether to restart or reroute an instance.                                       |
| Metrics                  | [metrics](./features/metrics.md)                                   | Publishes request throughput, latency distribution, error rates, and Node/process health in Prometheus text format at `GET /metrics`, behind a port so application code never imports the metrics library.                           |
| Distributed tracing      | [tracing](./features/tracing.md)                                   | Boots the OpenTelemetry SDK to auto-instrument HTTP and Prisma into spans, export them to an OTLP collector, stamp every log line with the active `trace_id`/`span_id`, and carry the trace across the BullMQ job boundary (opt-in). |

## Documentation coverage

Every COMPLETE feature in the codebase is documented; no features were skipped as in-progress in the latest run. Each per-feature doc carries a `Verified against` git SHA in its header and is regenerated by the `/document-features` skill when its source drifts.
