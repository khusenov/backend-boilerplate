# Backend Boilerplate

[![CI](https://github.com/khusenov/backend-boilerplate/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/khusenov/backend-boilerplate/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](./.nvmrc)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)

A production-shaped TypeScript backend starter built on **Fastify**, **Awilix**, **Prisma** and
**BullMQ**, organised as strict clean architecture — with the layer boundaries enforced in CI rather
than left to discipline.

Clone it, rename it, and start writing features on top of infrastructure that is already done.

## What you get

|                   |                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP**          | Fastify 5, Zod request/response validation, versioned `/v1` surface, uniform JSON error envelope, Swagger UI at `/docs` outside production     |
| **Auth**          | Argon2 password hashing, short-lived JWT access tokens, rotating server-stored refresh tokens, email verification, self-service password reset |
| **Authorization** | Compile-time permission catalogue, operator-managed roles, permissions enforced inside use cases (not at the HTTP edge)                        |
| **Persistence**   | Prisma + MariaDB, one repository per aggregate, `UnitOfWork` port over interactive transactions                                                |
| **Events & jobs** | Transactional outbox, Redis-backed BullMQ queue, dedicated worker process, guarded Bull Board dashboard                                        |
| **Reliability**   | `Idempotency-Key` replay, scheduled data retention, liveness/readiness probes, graceful shutdown                                               |
| **Observability** | Pino JSON logs with redaction + correlation IDs, Prometheus metrics, OpenTelemetry tracing, Grafana/Loki/Tempo stack                           |
| **Quality gates** | 100% coverage floor on domain + application, dependency-cruiser architecture rules, ESLint + Prettier, Testcontainers integration suite        |

A working users/auth/RBAC slice ships with it. That is deliberate: it is the reference vertical
slice you copy when adding your own feature, and documented as such in
[`docs/features/user-crud.md`](./docs/features/user-crud.md).

## Requirements

- **Node 24+** (see [`.nvmrc`](./.nvmrc))
- **Docker** with Compose v2
- npm

## Quick start

### Option A — the whole stack in Docker

```bash
docker compose up --wait
```

API on <http://localhost:8000>, worker probes on <http://localhost:8001>. Migrations run
automatically via the `migrate` service before the app starts.

The stack runs with `NODE_ENV=production` so that a first boot exercises the same guards a
deployment does — including the boot-time secret-strength checks. One consequence: Swagger UI is
disabled, so `/docs` returns 404 here. Use Option B when you want to browse the API reference.

### Option B — app on the host, dependencies in Docker

```bash
npm ci
cp .env.example .env
npm run db:generate                              # REQUIRED — see note below
docker compose up -d mariadb redis mailpit
npm run db:migrate
npm run dev
```

> **`npm run db:generate` is not optional.** Prisma generates its client into
> `src/generated/prisma`, which is gitignored. A fresh clone will not typecheck, build, or run until
> you generate it. Re-run it whenever `prisma/schema.prisma` changes.

`npm run dev` starts the API and the worker together via `concurrently`.

Verify:

```bash
curl localhost:8000/health/ready
```

## Renaming the project

Naming flows from a single value. Set `APP_NAME` in `.env`:

```bash
APP_NAME=acme
```

Everything derived from it updates at once — service name, queue prefix, JWT issuer/audience,
envelope sender, rate-limit key namespace, Swagger title, Bull Board realm — via
[`src/config/app-identity.ts`](./src/config/app-identity.ts). The derived variables are left
commented out in [`.env.example`](./.env.example) precisely so they follow `APP_NAME`; uncomment one
only when you need it to diverge. The compose stack derives its own copies the same way, including
the worker's `<APP_NAME>-worker` service name. See
[Application identity](./docs/README.md#application-identity) for the full table.

**Two files `APP_NAME` cannot reach, and they must agree with each other:**

| File                        | Value                     |
| --------------------------- | ------------------------- |
| `docker-compose.yml`        | `name: app` (line 1)      |
| `docker/alloy/config.alloy` | `regex = "app"` (line 12) |

Alloy keeps only containers whose compose-project label matches that regex. Change one without the
other and **log shipping stops silently** — no error, just an empty Loki. If you rename the compose
project, rename the regex in the same commit.

## Architecture

Dependencies point **inward**. The domain depends on nothing; the application depends on the domain
plus its own ports; infrastructure and presentation depend inward through those abstractions.
Concrete implementations bind to ports in exactly one tier: `src/composition/**`, the per-module
slices of the composition root.

| Layer            | Path                                     | Contains                                                                                             | May import                                              |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Domain           | `src/domain/**`                          | Entities, value objects, domain errors, repository **interfaces**, domain events                     | Nothing outside `domain`                                |
| Application      | `src/application/**`                     | Use-case classes with constructor DI + `execute()`; **ports** in `application/shared/ports/**`; DTOs | `domain` + its own ports                                |
| Infrastructure   | `src/infrastructure/**`                  | Adapters implementing ports (Prisma repos, argon2, jose, BullMQ, Pino)                               | `domain`, `application` ports, concrete libs            |
| Presentation     | `src/presentation/http/**`               | Fastify app, routes, plugins, guards, error handler, Zod schemas                                     | `application`, Fastify                                  |
| Composition root | `src/composition/**`, `src/container.ts` | Awilix wiring split one file per module, each owning its `Cradle` slice                              | Everything — the **only** place concretes bind to ports |
| Shared / Config  | `src/shared/**`, `src/config/**`         | Pagination, error base types, env parsing                                                            | Framework-free                                          |

This is not a convention you have to remember: `npm run arch` fails the build on violations, and
`scripts/assert-arch-not-vacuous.mjs` guarantees the ruleset cannot silently pass on zero modules.
See [`docs/architecture-graph.md`](./docs/architecture-graph.md) for the generated module graph, and
[`docs/README.md`](./docs/README.md) for per-feature documentation.

Two deployables share one codebase: `src/main.ts` (API) and `src/worker.ts` (BullMQ worker).

## Adding a feature

Copy the shape of the user slice. In order:

1. **Domain** — `src/domain/<feature>/`: entity, errors, repository _interface_.
2. **Application** — `src/application/<feature>/`: use-case class with object-destructured
   constructor DI and `execute(input, actor)`, plus a DTO. Add a port to
   `src/application/shared/ports/` only if you need a genuinely new capability.
3. **Persistence** — `src/infrastructure/persistence/prisma-<feature>-repository.ts` and a matching
   `-mapper.ts`. Inject `PrismaTransactionalClient`, not `PrismaClient`, so the same class works
   inside and outside a transaction.
4. **Schema** — add the model to `prisma/schema.prisma`, then `npm run db:migrate`.
5. **HTTP** — Zod shapes in `src/presentation/http/schemas/`, routes in
   `src/presentation/http/routes/<feature>-routes.ts`.
6. **Wire the route** — one line in `src/presentation/http/routes/api-v1-routes.ts`.
7. **Wire the dependencies** — create `src/composition/<feature>.ts` with the feature's `Cradle`
   slice and its registration map, then add one spread line to `src/composition/compose.ts`. A
   missing registration is a compile error, so the compiler names anything you forget.
8. **Permissions** — add keys to `src/domain/authorization/permission-catalogue.ts` and enforce them
   **inside the use case**, not at the route.
9. **Transactions** — if the repository must join a transaction, register it in
   `src/infrastructure/persistence/prisma-unit-of-work.ts`.
10. **Jobs** — if the feature enqueues work, add it to `src/job-catalogue.ts` and to the `jobWorker`
    factory in `src/composition/jobs.ts`. `example.ping` (`ExampleJobHandler`) exists as a copyable
    template.

Tests are co-located (`*.test.ts`) and the domain + application layers are held at **100% coverage**,
so a new use case without tests fails the build.

## Scripts

| Command                                    | Purpose                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `npm run dev`                              | API + worker with hot reload                                                                |
| `npm run build`                            | Bundle with tsup                                                                            |
| `npm start` / `npm run start:worker`       | Run the built API / worker                                                                  |
| `npm test` / `npm run test:watch`          | Unit suite                                                                                  |
| `npm run test:coverage`                    | Unit suite with the coverage gate                                                           |
| `npm run test:integration`                 | Testcontainers suite (real MariaDB + Redis)                                                 |
| `npm run typecheck`                        | `tsc --noEmit`                                                                              |
| `npm run lint` / `lint:fix`                | ESLint                                                                                      |
| `npm run format` / `format:check`          | Prettier                                                                                    |
| `npm run arch`                             | Architecture boundary rules                                                                 |
| `npm run arch:graph`                       | Regenerate `docs/architecture-graph.md`                                                     |
| `npm run db:generate`                      | Generate the Prisma client                                                                  |
| `npm run db:migrate` / `db:migrate:deploy` | Apply migrations (dev / production)                                                         |
| `npm run db:studio`                        | Prisma Studio                                                                               |
| `npm run db:sync-auth`                     | Sync roles/permissions and bootstrap the admin                                              |
| **`npm run audit`**                        | **The full gate** — lockfile, deps, format, lint, types, arch, build, coverage, integration |

Run `npm run audit` before pushing. It runs every check CI runs except the Docker image build and
smoke test, which needs the compose stack — `docker compose up --wait` covers that locally.

## Ports

| Port | Service                 |
| ---- | ----------------------- |
| 8000 | API                     |
| 8001 | Worker probes / metrics |
| 3306 | MariaDB                 |
| 6379 | Redis                   |
| 1025 | Mailpit SMTP            |
| 8025 | Mailpit web UI          |
| 3000 | Grafana                 |
| 3100 | Loki                    |
| 3200 | Tempo                   |
| 4318 | OTLP HTTP receiver      |

Outbound mail in development goes to Mailpit — open <http://localhost:8025> to read verification and
password-reset messages. Nothing leaves your machine.

## Configuration

Every variable is declared and validated in [`src/config/env.ts`](./src/config/env.ts) using
`envalid`; [`.env.example`](./.env.example) is the annotated template. The parse runs at import
time, so a misconfigured process fails immediately and loudly rather than at first use.

- **Always required:** `DATABASE_URL`, `JWT_ACCESS_SECRET`
- **Required in production only** (they carry dev defaults): `WEB_ORIGIN`, `REDIS_URL`, `SMTP_HOST`,
  `EMAIL_FROM`, `VERIFICATION_CODE_SECRET`, `PASSWORD_RESET_URL_BASE`
- **Length-enforced at boot when `NODE_ENV=production`** (`src/config/assert-production-secrets.ts`):
  `JWT_ACCESS_SECRET`, `COOKIE_SECRET`, `VERIFICATION_CODE_SECRET` at ≥32 chars;
  `BULL_BOARD_PASSWORD` at ≥16 when the dashboard is enabled

Generate real secrets with `openssl rand -base64 48`. The defaults committed to `.env.example` and
`docker-compose.yml` are development-only and must never reach a deployed environment.

## Testing

```bash
npm test                  # unit, hermetic, no external services
npm run test:integration  # spins real MariaDB + Redis via Testcontainers
```

The unit suite is hermetic — `test/unit/setup-env.ts` supplies a fixed environment so tests never
depend on your `.env`.

## Observability

With the compose stack running:

- **Grafana** <http://localhost:3000> (anonymous admin, login form disabled)
- **Logs** — Alloy tails container stdout into Loki; query `{compose_service="app"}`
- **Traces** — set `OTEL_ENABLED=true`; spans export to Tempo over OTLP
- **Metrics** — `/metrics` on both the API (8000) and the worker (8001)
- **Queues** — set `BULL_BOARD_ENABLED=true` and a `BULL_BOARD_PASSWORD`, then visit
  `/admin/queues` (HTTP Basic, read-only by default)

Every log line carries a correlation ID, and `trace_id`/`span_id` when tracing is on.

## Troubleshooting

**`ENOTFOUND redis` / unhealthy app.** A standalone Redis container and the compose stack both bind 6379. Run one or the other, not both.

**`npm run test:integration` hangs forever.** Testcontainers blocks on Docker's
`credential-desktop` helper. Run the suite with a credentials-store-free Docker config:

```bash
DOCKER_CONFIG=$(mktemp -d) npm run test:integration
```

**`Cannot find module '@/generated/prisma/client'`** — you skipped `npm run db:generate`.

**`npm run db:migrate` fails on the shadow database (`P3014`).** `prisma migrate dev` creates a
temporary shadow DB, so the user in `DATABASE_URL` needs rights over that name pattern. The compose
MariaDB grants them to the `app` user on first initialisation via
[`docker/mariadb/init/01-shadow-database.sql`](./docker/mariadb/init/01-shadow-database.sql). That
script only runs against an empty data volume, so a database created before it existed will not have
the grant — apply it once by hand, or reset with `docker compose down --volumes`.

```bash
docker compose exec mariadb mariadb -uroot -proot \
  -e "GRANT ALL PRIVILEGES ON \`prisma_migrate_shadow_db%\`.* TO 'app'@'%'; FLUSH PRIVILEGES;"
```

**Grafana logs are empty.** The compose project name and the Alloy `regex` have drifted apart — see
[Renaming the project](#renaming-the-project).

**Email works on the host but not in the compose stack.** Compose substitutes `${VAR:-default}` in
`docker-compose.yml` using your local `.env`, so a `SMTP_HOST=localhost` tuned for host-based
development also reaches the containers — where `localhost` is the app container itself, not
Mailpit. Either unset `SMTP_HOST` in `.env` (the compose default `mailpit` then applies) or run
`docker compose --env-file /dev/null up`. Check what a service actually receives with:

```bash
docker compose config
```

## Contributing

Pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the setup, the four build
gates, and the commit convention. Run `npm run audit` before opening one.

For anything security related, follow [SECURITY.md](./SECURITY.md) and report privately rather than
opening an issue.

## License

[MIT](./LICENSE)
