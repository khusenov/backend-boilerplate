# Finflow Backend Documentation

Finflow backend is a clean-architecture TypeScript service — built on Fastify, Awilix, Prisma, and BullMQ — that provides user management, authentication, role-based authorization, domain events, background jobs, structured logging, and health checks.

## API reference

The live, auto-generated OpenAPI/Swagger UI is served at [`/docs`](/docs), registered via `@fastify/swagger` and `@fastify/swagger-ui` in `src/presentation/http/app.ts`. It is available in non-production environments only.

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

| Feature                  | Doc                                                                | Summary                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User CRUD                | [user-crud](./features/user-crud.md)                               | Owns the user-account lifecycle (list, read, create, edit, delete) over HTTP and is the reference vertical slice — wired through all four layers — that every other feature copies.                             |
| Authentication           | [authentication](./features/authentication.md)                     | Answers "who is this caller?" by exchanging email and password for a session built on a short-lived access token and a long-lived refresh token.                                                                |
| Role-based authorization | [role-based-authorization](./features/role-based-authorization.md) | Answers "is this caller allowed to do this?" by modelling access as a fixed in-code permission catalogue bundled into operator-managed roles assigned to users.                                                 |
| Domain events            | [domain-events](./features/domain-events.md)                       | Lets an aggregate announce a business fact that has already happened, delivered to independent handlers at least once via a transactional outbox relayed on the job queue.                                      |
| Background jobs          | [background-jobs](./features/background-jobs.md)                   | Moves slow, retryable, or scheduled work off the request path onto a durable Redis-backed BullMQ queue, exposing a generic producer/consumer transport (`JobQueue`, `JobScheduler`, `JobHandler`) behind ports. |
| HTTP infrastructure      | [http-infrastructure](./features/http-infrastructure.md)           | Assembles the shared Fastify app (`buildApp`) — plugin order, Zod request validation, response shaping, security headers, and the uniform JSON error envelope — that every HTTP feature sits on.                |
| Structured logging       | [structured-logging](./features/structured-logging.md)             | Provides a framework-agnostic `Logger` port with a Pino-backed adapter and a per-request correlation id, so inner layers log without depending on a concrete library.                                           |
| Health checks            | [health-checks](./features/health-checks.md)                       | Exposes separate unauthenticated liveness (`/health/live`) and readiness (`/health/ready`) endpoints so orchestrators and load balancers can decide whether to restart or reroute.                              |

## Coverage notes

No features were skipped as in-progress — all eight above passed the completeness check and are fully documented. Two follow-ups are worth a reader's awareness:

- **The background-jobs example handler is a template, not live traffic.** `EXAMPLE_JOB` / `ExampleJobHandler` (job name `example.ping`) is a dormant demonstration template kept as a copy-paste starting point for adding new jobs; no production code enqueues it. The real recurring job traffic is the domain-events outbox relay.
- **Two job-infrastructure classes have no dedicated unit tests yet.** `BullMqJobScheduler` and `createRedisConnection` are exercised only indirectly (through the queue round-trip and outbox integration tests), not by unit tests of their own.
