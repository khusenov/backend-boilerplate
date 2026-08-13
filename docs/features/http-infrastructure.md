# HTTP Infrastructure

> **Status:** Complete · **Layers:** presentation, shared, config · **Verified against:** `329a35a`

## Purpose

Every feature that speaks HTTP — user CRUD, authentication, authorization, health checks, metrics —
sits on one shared composition root and one shared set of request/response conventions. This feature
is that foundation: `buildApp` assembles the Fastify application, fixes the order in which
cross-cutting plugins run, and defines how requests are validated, how successful responses are
shaped, and how **every** error becomes a uniform JSON envelope with the right HTTP status. Its reason
to exist is the Dependency Rule: HTTP concerns — status codes, headers, response shapes, security
policy — must live at the presentation boundary and nowhere else, so the domain and application layers
can throw meaningful errors and return plain objects without ever importing Fastify or knowing what a
`409` is.

## How it works

`buildApp(opts)` in `src/presentation/http/app.ts` constructs and returns a configured Fastify
instance. It does **not** call `listen` — `src/main.ts` owns the network lifecycle and calls
`buildApp` at bootstrap. Construction has two phases: wiring the cross-cutting plugins in a deliberate
order, then registering feature routes.

**Boot-time configuration guard.** Before `buildApp` ever runs, importing `src/config/env.ts` parses
the whole process environment once through **`envalid`** (`cleanEnv`) into a typed, frozen `env`, then
immediately calls `assertProductionSecrets(env)`. That guard is a no-op outside production; in
production it refuses to boot (throws) if `COOKIE_SECRET` or `JWT_ACCESS_SECRET` is shorter than
`MIN_SECRET_LENGTH` (32) characters, and — only when `BULL_BOARD_ENABLED` is true — if
`BULL_BOARD_PASSWORD` is shorter than 16 characters. It collects **all** offending keys and throws a
single error naming them with a remediation hint (`openssl rand -base64 48`), so a misconfigured
deploy fails fast and loudly rather than starting with a weak secret.

**Instance configuration.** The Fastify factory is given `logger: opts.loggerOptions` (a Pino
`LoggerOptions` object built by `main.ts` from `createLoggerOptions(env.LOG_LEVEL,
toServiceIdentity(env))`, so every log line carries both the level and the service identity — name,
environment, version), `requestIdHeader: CORRELATION_ID_HEADER` (`'x-request-id'`) and `genReqId: ()
=> randomUUID()`, so every request carries an id taken from the client's `x-request-id` header or
freshly minted. That id becomes the correlation id in logs and the `requestId` in every error body.
`forceCloseConnections: true` supports clean shutdown; `disableRequestLogging` defaults to `false` and
is set to `env.isDevelopment` by `main.ts`.

**Plugin registration order.** Fastify runs lifecycle **hooks** (request-lifecycle callbacks) in the
order the plugins that add them were registered, and because these plugins are all registered at the
root — sharing one Fastify _encapsulation context_ — each plugin's **decorators** (properties or
methods attached to the Fastify instance or request, **not** the TypeScript `@decorator` class
syntax) and hooks are visible to everything registered after it. That is what makes registration
order load-bearing. Each entry below is a real setter or `app.register` call, in source order;
conditional registrations note their gate:

1. `app.setValidatorCompiler(validatorCompiler)` and `app.setSerializerCompiler(serializerCompiler)`
   from **`fastify-type-provider-zod`** — makes Zod the schema language for both request validation
   and response serialization.
2. **`@fastify/sensible`** (`fastifySensible`) — HTTP utility decorators.
3. **`@fastify/helmet`** (`fastifyHelmet`) with `helmetOptions(env.isProduction)` — security headers.
4. **`@fastify/awilix`** (`fastifyAwilixPlugin`) with `disposeOnClose: true`, `disposeOnResponse:
true`, `strictBooleanEnforced: true`, `injectionMode: 'PROXY'` — creates a per-request DI scope
   and disposes it on response; must precede anything that resolves from `request.diScope.cradle`
   (the **cradle** is Awilix's resolved-dependency proxy).
5. `correlationIdPlugin` — registers `@fastify/request-context` and, on every `onRequest`, stamps the
   correlation id into the request context and echoes it back as the `x-request-id` response header.
   Documented by [Structured Logging](./structured-logging.md).
6. `metricsPlugin` — **only when `env.METRICS_ENABLED`** — an `onResponse` hook that records
   per-request HTTP metrics. Documented by [Metrics](./metrics.md).
7. **`@fastify/cors`** (`fastifyCors`) — Cross-Origin Resource Sharing (CORS) — with `{ origin:
env.WEB_ORIGIN, credentials: true }`.
8. **`@fastify/cookie`** (`fastifyCookie`), passed `{ secret: env.COOKIE_SECRET }` when
   `COOKIE_SECRET` is set (enabling signed cookies) and `{}` otherwise.
9. `authPlugin` — decorates the instance with `authenticate`. Documented by
   [Authentication](./authentication.md).
10. `registerDependencies(diContainer, app.log)` — Awilix wiring (the composition root, `src/container.ts`).
11. `registerErrorHandler(app)` — installs the app-wide error handler **and** the not-found handler.
    Registered before routes so it catches everything they throw.
12. **`@fastify/swagger`** + **`@fastify/swagger-ui`** at `/docs` — **only when `!env.isProduction`** —
    with the Zod `jsonSchemaTransform` so route schemas become OpenAPI, plus a `bearerAuth` JWT
    security scheme.
13. `bullBoardPlugin` — **only when `env.BULL_BOARD_ENABLED`** — mounts the Bull Board queue dashboard
    at `env.BULL_BOARD_PATH` (default `/admin/queues`) behind HTTP Basic Auth. Its gating and guard are
    detailed under Design decisions; the queues it inspects are documented by
    [Background Jobs](./background-jobs.md).
14. **`@fastify/rate-limit`** (`fastifyRateLimit`) with `rateLimitOptions(env.RATE_LIMIT_MAX,
env.RATE_LIMIT_WINDOW)` and `redis: diContainer.cradle.rateLimitRedis` — **only when
    `opts.rateLimit ?? true`**, so tests can disable it. The `redis` handle makes the limiter's
    counters live in Redis (see Design decisions).
15. Feature routes, each under a prefix: `healthRoutes` (`/health`), `metricsRoutes` (`/metrics`,
    **only when `env.METRICS_ENABLED`**), `authRoutes` (`/auth`), `userRoutes` (`/users`),
    `roleRoutes` (`/roles`), `permissionRoutes` (`/permissions`).

**A request's happy path.** Fastify assigns `request.id` → `onRequest` hooks run (correlation id set
and `x-request-id` header echoed; for protected route groups the `authenticate` decorator verifies the
bearer token) → the Zod **validator compiler** checks `querystring` / `params` / `body` against the
route's schema → the handler resolves its use case from `request.diScope.cradle` and calls `execute()`
→ `reply.send(payload)` runs the payload through the Zod **serializer compiler**, which validates it
against the route's declared `response` schema and strips any field the schema does not declare → the
`onResponse` hook (when metrics are enabled) records the method, matched route template, status, and
duration.

**The failure paths that matter**, all funnelled through `registerErrorHandler`'s single
`setErrorHandler` (`src/presentation/http/error-handler.ts`):

- A thrown **`AppError`** (from any inner layer) → its `kind` is mapped through `KIND_TO_STATUS` to an
  HTTP status; the body is `{ error: { ...error.toJSON(), requestId } }`. Operational errors log at
  `info`, non-operational at `error`.
- A **Fastify schema-validation** failure (`error.validation` present) → `400` with code `VALIDATION`
  and the validator's message.
- Any other error carrying a **4xx `statusCode`** → that status, code `error.code ?? 'BAD_REQUEST'`.
  This is how the rate limiter's `429` surfaces (its `errorResponseBuilder` sets `statusCode` and
  `code = 'RATE_LIMITED'`).
- Anything else → `500` with code `INTERNAL` and the generic message `Internal Server Error`, so
  internal failure detail never leaks to the client.

An unmatched route is caught by `setNotFoundHandler` → `404` with code `ROUTE_NOT_FOUND` and the
message `Route <METHOD> <URL> not found`.

## Architecture

This feature is not port/adapter-shaped like the others; it is the **presentation composition root**
plus the framework-free **shared** vocabulary (`src/shared/errors`, `src/shared/pagination`) that both
the boundary and the inner layers speak. The direction of dependency is what matters: inner layers
throw semantic `AppError`s and return plain DTOs / `Page` objects with no HTTP knowledge; the
presentation layer is the **only** place that translates that vocabulary into HTTP — status codes in
`error-handler.ts`, wire shapes in the Zod schemas, security policy in `security.ts`. The shared error
and pagination types carry no framework imports, which is precisely why an application use case may
construct them without breaching the Dependency Rule. The concrete dependencies the HTTP layer pulls
from `src/container.ts` come from the global Awilix cradle, but at different moments: `rateLimitRedis`
and (when enabled) `dashboardQueue` are resolved once at composition time, when `buildApp` registers
the rate limiter and the Bull Board plugin (`app.ts`); `metricsRecorder`, when metrics are on, is read
from the cradle **per response** inside the `onResponse` metrics hook (`plugins/metrics.ts`), not at
composition time.

| Component                                      | Layer        | Responsibility                                                                                                                          | File                                                         |
| ---------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `buildApp`                                     | Presentation | Composition root: configures Fastify, registers plugins in order, mounts routes                                                         | `src/presentation/http/app.ts`                               |
| `registerErrorHandler`                         | Presentation | Single `setErrorHandler` + `setNotFoundHandler`; maps every error to the JSON envelope                                                  | `src/presentation/http/error-handler.ts`                     |
| `KIND_TO_STATUS`                               | Presentation | Maps each `ErrorKindType` to its HTTP status code                                                                                       | `src/presentation/http/error-handler.ts`                     |
| `helmetOptions` / `rateLimitOptions`           | Presentation | Security defaults: helmet Content-Security-Policy (CSP) toggle and the Redis-backed rate-limit envelope                                 | `src/presentation/http/security.ts`                          |
| `errorResponse`                                | Presentation | Zod response contract for the error envelope                                                                                            | `src/presentation/http/schemas/error-schema.ts`              |
| `paginated`                                    | Presentation | Zod response-contract factory wrapping a page of items                                                                                  | `src/presentation/http/schemas/pagination-schema.ts`         |
| `timestamp`                                    | Presentation | Zod response contract for date fields (`z.date()`)                                                                                      | `src/presentation/http/schemas/timestamp-schema.ts`          |
| `correlationIdPlugin`                          | Presentation | Per-request correlation id (see [Structured Logging](./structured-logging.md))                                                          | `src/presentation/http/plugins/correlation-id.ts`            |
| `metricsPlugin`                                | Presentation | `onResponse` hook recording HTTP metrics (see [Metrics](./metrics.md))                                                                  | `src/presentation/http/plugins/metrics.ts`                   |
| `authPlugin`                                   | Presentation | `authenticate` decorator for bearer auth (see [Authentication](./authentication.md))                                                    | `src/presentation/http/plugins/authenticate.ts`              |
| `bullBoardPlugin` / `createBasicAuthValidator` | Presentation | Basic-auth-guarded Bull Board dashboard mount (see [Background Jobs](./background-jobs.md))                                             | `src/presentation/http/plugins/bull-board.ts`                |
| `toRequestActor`                               | Presentation | Maps `request.user` to the domain `Actor` a use case authorizes against (see [Role-Based Authorization](./role-based-authorization.md)) | `src/presentation/http/identity/actor-from-token-payload.ts` |
| cookie helpers                                 | Presentation | Read/write the signed refresh-token cookie (see [Authentication](./authentication.md))                                                  | `src/presentation/http/cookies.ts`                           |
| `AppError`                                     | Shared       | Abstract base error carrying `kind`, `code`, `details`, `isOperational`, `timestamp`, `toJSON()`                                        | `src/shared/errors/app-error.ts`                             |
| `ErrorKind`                                    | Shared       | The closed set of error kinds (`VALIDATION`…`INTERNAL`)                                                                                 | `src/shared/errors/app-error.ts`                             |
| `ValidationError` … `InternalError`            | Shared       | Semantic `AppError` subclasses inner layers throw                                                                                       | `src/shared/errors/semantic-errors.ts`                       |
| `normalizePageQuery` / `createPage`            | Shared       | Framework-free pagination: clamp request input, compute page metadata                                                                   | `src/shared/pagination.ts`                                   |
| `Page` / `PageQuery` / `PageSlice`             | Shared       | Pagination types shared by use cases, repositories, and response schemas                                                                | `src/shared/pagination.ts`                                   |
| `env`                                          | Config       | Parse + validate the whole environment once at boot (`envalid`), exported frozen                                                        | `src/config/env.ts`                                          |
| `assertProductionSecrets`                      | Config       | Boot-time guard: refuse to start when a production secret is weak                                                                       | `src/config/assert-production-secrets.ts`                    |
| `toServiceIdentity`                            | Config       | Derive `{ service, environment, version }` for logs/traces from env                                                                     | `src/config/service-identity.ts`                             |

## Public surface

Two things clients program against (the wire contracts) and three things engineers program against
(the shared building blocks and the route decorators/identity helpers).

**Error-response envelope.** Every failure — validation, auth, rate limit, unknown crash, unknown
route — produces exactly this shape, validated by `errorResponse` in `error-schema.ts`:

```json
{
  "error": {
    "code": "EMAIL_TAKEN",
    "message": "Email already registered",
    "details": { "email": "taken@example.com" },
    "requestId": "a1b2c3d4-…"
  }
}
```

`code`, `message`, and `requestId` are always present; `details` is optional. `requestId` equals the
request's correlation id (`x-request-id`), so a client error report is traceable straight to the log
lines for that request. The status→code correspondence:

| HTTP status | `code`                          | Source                                                    |
| ----------- | ------------------------------- | --------------------------------------------------------- |
| 400         | `VALIDATION` (or a custom code) | `ValidationError`, or a Fastify schema-validation failure |
| 401         | `UNAUTHORIZED`                  | `UnauthorizedError`                                       |
| 403         | `FORBIDDEN`                     | `ForbiddenError`                                          |
| 404         | `NOT_FOUND` / `ROUTE_NOT_FOUND` | `NotFoundError` / unmatched route                         |
| 409         | `CONFLICT`                      | `ConflictError`                                           |
| 429         | `RATE_LIMITED`                  | rate limiter's `errorResponseBuilder`                     |
| 4xx         | `error.code ?? 'BAD_REQUEST'`   | any non-`AppError` with a 4xx `statusCode`                |
| 500         | `INTERNAL`                      | `InternalError` or any unhandled error (generic message)  |

The HTTP status is governed by the error's `kind`; the `code` defaults to the kind string but a
semantic error accepts a **custom** `code` (e.g. `new ConflictError('…', { code: 'EMAIL_TAKEN' })`)
that overrides the default while the status stays fixed.

**Pagination envelope.** List endpoints accept `page` and `pageSize` query parameters and return the
page envelope defined by `paginated(itemSchema)`:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 10,
  "total": 42,
  "hasNext": true,
  "hasPrev": false
}
```

**Shared building blocks other features call:**

```ts
// src/shared/errors  — throw meaning, not HTTP
new ValidationError(message, { code?, details?, cause? });    // → 400
new NotFoundError(message, { code?, details?, cause? });      // → 404
new ConflictError(message, { code?, details?, cause? });      // → 409
new UnauthorizedError(message?, { code?, details?, cause? }); // → 401, default message 'Unauthorized'
new ForbiddenError(message?, { code?, details?, cause? });    // → 403, default message 'Forbidden'
new InternalError(message?, { code?, details?, cause? });     // → 500, default message 'Internal error', isOperational = false

// src/shared/pagination  — framework-free page math
function normalizePageQuery(input: PageQueryInput): PageQuery; // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
function createPage<T>(items: T[], total: number, query: PageQuery): Page<T>; // computes hasNext/hasPrev

// src/presentation/http/schemas  — Zod response contracts feature routes $ref
function paginated<Item extends z.ZodType>(item: Item); // page envelope
const timestamp;      // z.date() for date fields
const errorResponse;  // the error envelope
```

**Route decorators and identity helpers** the HTTP layer exposes for feature routes to program against
(their behaviour is documented in depth in the linked feature docs):

```ts
app.authenticate;                  // FastifyInstance decorator — verifies the bearer token,
                                   // sets request.user; use as an onRequest/preHandler hook
request.user?: AccessTokenPayload; // FastifyRequest decorator populated by authenticate

toRequestActor(request.user);      // → RequestActor (a UserActor, or ANONYMOUS_ACTOR when absent);
                                   // pass it as the last argument of a use case's execute()
```

Authorization is **not** an HTTP-layer concern: the permission check lives in the use case, so it
holds for every caller rather than only for requests. The HTTP layer's job is to prove identity and
hand the use case an `Actor`. See [Authentication](./authentication.md) for `authenticate` /
`request.user` and [Role-Based Authorization](./role-based-authorization.md) for the access policy.

## Configuration

`src/config/env.ts` parses and validates the whole process environment once, via **`envalid`**
(`cleanEnv`), exports a typed frozen `env`, and then runs `assertProductionSecrets(env)` (see How it
works). The table below lists the env vars this and its sibling features read through `env.ts`;
variables the HTTP-infrastructure feature reads directly — in `buildApp`, its plugins, `security.ts`,
`cookies.ts`, or the boot-time guard — are **bold**, and feature-specific groups are cross-linked to
their owning docs. Defaults are copied verbatim; `—` means the variable is **required** (no default,
boot fails if unset). `devDefault` values apply only outside production. Two OpenTelemetry sampler
knobs — `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` — are read natively by the OTel SDK
rather than `env.ts`, so they are documented in [Tracing](./tracing.md) rather than here.

| Variable                      | Default                                   | Meaning                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`NODE_ENV`**                | `development`                             | Environment; one of `development`, `test`, `production`. Drives `env.isProduction`, which gates helmet CSP, Swagger, and the production secret check.                   |
| `HOST`                        | `0.0.0.0`                                 | Bind address for `app.listen` (used in `main.ts`).                                                                                                                      |
| `PORT`                        | `8000`                                    | Listen port (used in `main.ts`).                                                                                                                                        |
| **`LOG_LEVEL`**               | `info`                                    | Pino level (`fatal`…`trace`); `main.ts` turns it into the `loggerOptions` passed to `buildApp`. See [Structured Logging](./structured-logging.md).                      |
| `DATABASE_URL`                | `—`                                       | Prisma connection string (required).                                                                                                                                    |
| **`JWT_ACCESS_SECRET`**       | `—`                                       | Access-token signing secret (required; the boot-time guard demands ≥ 32 chars in production). See [Authentication](./authentication.md).                                |
| `JWT_ISSUER`                  | `finflow`                                 | JWT `iss` claim. See [Authentication](./authentication.md).                                                                                                             |
| `JWT_AUDIENCE`                | `finflow-api`                             | JWT `aud` claim. See [Authentication](./authentication.md).                                                                                                             |
| `ACCESS_TOKEN_TTL`            | `900`                                     | Access-token lifetime in seconds (15 min). See [Authentication](./authentication.md).                                                                                   |
| **`REFRESH_TOKEN_TTL`**       | `1209600`                                 | Refresh-token lifetime in seconds (14 days); also the refresh-cookie `Max-Age`.                                                                                         |
| **`COOKIE_SECRET`**           | `''` (empty)                              | When non-empty, cookies are signed; passed to `@fastify/cookie` in `buildApp` and read by the cookie helpers. The boot-time guard demands ≥ 32 chars in production.     |
| **`WEB_ORIGIN`**              | `—` (devDefault `http://127.0.0.1:3000`)  | Allowed CORS origin; passed to `@fastify/cors` with `credentials: true`.                                                                                                |
| **`COOKIE_SECURE`**           | `true` (devDefault `false`)               | Sets the `Secure` flag on the refresh cookie.                                                                                                                           |
| `BOOTSTRAP_ADMIN_EMAIL`       | `''` (empty)                              | Email of the admin seeded at bootstrap. See [Role-Based Authorization](./role-based-authorization.md).                                                                  |
| **`RATE_LIMIT_MAX`**          | `100`                                     | Global rate-limit ceiling per window; passed to `@fastify/rate-limit`.                                                                                                  |
| **`RATE_LIMIT_WINDOW`**       | `1 minute`                                | Global rate-limit window; passed to `@fastify/rate-limit`.                                                                                                              |
| `RATE_LIMIT_AUTH_MAX`         | `5`                                       | Stricter per-route ceiling for auth endpoints. See [Authentication](./authentication.md).                                                                               |
| **`REDIS_URL`**               | `—` (devDefault `redis://127.0.0.1:6379`) | Redis connection; backs the distributed rate-limit store (and BullMQ).                                                                                                  |
| `QUEUE_PREFIX`                | `finflow`                                 | BullMQ key prefix. See [Background Jobs](./background-jobs.md).                                                                                                         |
| `QUEUE_CONCURRENCY`           | `5`                                       | BullMQ worker concurrency. See [Background Jobs](./background-jobs.md).                                                                                                 |
| `DATA_RETENTION_TTL`          | `2592000`                                 | Retention window in seconds (30 days) for the scheduled data-retention job. See [Background Jobs](./background-jobs.md).                                                |
| **`METRICS_ENABLED`**         | `true`                                    | Gates registration of `metricsPlugin` and the `GET /metrics` route in `buildApp`. See [Metrics](./metrics.md).                                                          |
| `HEALTHCHECK_TIMEOUT_MS`      | `2000`                                    | Per-dependency timeout for health probes. See [Health Checks](./health-checks.md).                                                                                      |
| `OTEL_ENABLED`                | `false`                                   | Toggles OpenTelemetry tracing. See [Tracing](./tracing.md).                                                                                                             |
| `OTEL_SERVICE_NAME`           | `finflow-api`                             | Service name; also the `service` field `toServiceIdentity` stamps onto logs. See [Tracing](./tracing.md).                                                               |
| `OTEL_SERVICE_VERSION`        | `0.0.0`                                   | Service version; also the `version` field on log/trace identity. See [Tracing](./tracing.md).                                                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318`                   | OTLP exporter endpoint. See [Tracing](./tracing.md).                                                                                                                    |
| **`BULL_BOARD_ENABLED`**      | `false`                                   | Gates registration of `bullBoardPlugin` in `buildApp`, and whether the boot guard enforces `BULL_BOARD_PASSWORD` strength. See [Background Jobs](./background-jobs.md). |
| **`BULL_BOARD_PATH`**         | `/admin/queues`                           | Base path the dashboard mounts at.                                                                                                                                      |
| **`BULL_BOARD_USERNAME`**     | `admin`                                   | Basic-auth username for the dashboard.                                                                                                                                  |
| **`BULL_BOARD_PASSWORD`**     | `''` (empty)                              | Basic-auth password; empty fails login closed. The boot-time guard demands ≥ 16 chars in production when the dashboard is enabled.                                      |
| **`BULL_BOARD_READONLY`**     | `true`                                    | Mounts the dashboard in read-only mode (`readOnlyMode`).                                                                                                                |

`buildApp` also takes three code-level options, not env vars: `loggerOptions` (a Pino `LoggerOptions`),
the optional `disableRequestLogging` (default `false`), and the optional `rateLimit` (default `true`,
disabled by tests). `main.ts` supplies `loggerOptions: createLoggerOptions(env.LOG_LEVEL,
toServiceIdentity(env))` and `disableRequestLogging: env.isDevelopment`.

**Security defaults** derive from the environment rather than dedicated flags:

- `helmetOptions(env.isProduction)` returns `{}` in production (helmet's full defaults, **CSP on**) and
  `{ contentSecurityPolicy: false }` elsewhere — CSP is deliberately relaxed outside production so the
  Swagger UI at `/docs` loads.
- `rateLimitOptions(max, timeWindow)` sets `skipOnError: true` (fail-open — allow the request when
  Redis is unreachable), a `nameSpace` of `RATE_LIMIT_KEY_NAMESPACE` (`'finflow-rate-limit-'`) for its
  Redis keys, and an `errorResponseBuilder` that emits a `FastifyError` with `code: 'RATE_LIMITED'` and
  the window's `statusCode`, so a throttled request flows through the same error envelope as everything
  else.
- Swagger has no dedicated variable — it is gated purely on `!env.isProduction`. Bull Board, by
  contrast, is gated on `BULL_BOARD_ENABLED` and additionally protects itself with Basic Auth and its
  own strict CSP (see Design decisions).

## Usage & extension

**Throw a semantic error from any inner layer — it becomes the right HTTP response automatically.**
No `try/catch`, no status code, no `reply` in the use case:

```ts
import { ConflictError } from '@/shared/errors';

// inside a use case (application layer)
if (await this.users.findByEmail(email)) {
  throw new ConflictError('Email already registered', {
    code: 'EMAIL_TAKEN',
    details: { email },
  });
}
// → HTTP 409
// { "error": { "code": "EMAIL_TAKEN", "message": "Email already registered",
//              "details": { "email": "…" }, "requestId": "…" } }
```

**Add a brand-new error kind** (only when none of the six existing kinds fits — usually one does).
Three edits keep the mapping total and type-safe:

1. Add the kind to `ErrorKind` in `src/shared/errors/app-error.ts`:
   ```ts
   export const ErrorKind = {
     // …existing…
     TooManyRequests: 'TOO_MANY_REQUESTS',
   } as const;
   ```
2. Add its status to `KIND_TO_STATUS` in `src/presentation/http/error-handler.ts` (the `Record` is
   keyed by `ErrorKindType`, so TypeScript forces you to cover the new kind):
   ```ts
   [ErrorKind.TooManyRequests]: 429,
   ```
3. Add a semantic subclass in `src/shared/errors/semantic-errors.ts` and export it from
   `src/shared/errors/index.ts`:
   ```ts
   export class TooManyRequestsError extends AppError {
     constructor(message = 'Too many requests', options?: SemanticErrorOptions) {
       super({
         kind: ErrorKind.TooManyRequests,
         code: options?.code ?? 'TOO_MANY_REQUESTS',
         message,
         ...(options?.details !== undefined && { details: options?.details }),
         ...(options?.cause !== undefined && { cause: options?.cause }),
       });
     }
   }
   ```

**Declare a response contract on a route** so the wire shape is enforced and internal fields are
stripped. Compose `paginated`, `timestamp`, and `errorResponse` (this mirrors what the user routes do):

```ts
import { z } from 'zod';
import { paginated } from '../schemas/pagination-schema';
import { timestamp } from '../schemas/timestamp-schema';
import { errorResponse } from '../schemas/error-schema';

const userResponse = z.object({
  id: z.uuid(),
  email: z.email(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const paginatedUsers = paginated(userResponse);

app.get(
  '/',
  {
    schema: {
      querystring: z.object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).optional(),
      }),
      response: { 200: paginatedUsers, 400: errorResponse },
    },
  },
  handler,
);
```

Because the serializer compiler validates the outgoing payload against `userResponse`, any field the
schema does not list (a password hash, an internal flag) is dropped before it reaches the client —
even if a mapper accidentally includes it.

**Return a page from a use case** with the shared helpers (mirrors `src/application/user/list-users.ts`):

```ts
import { normalizePageQuery, createPage } from '@/shared/pagination';

async execute(input: ListUsersInput): Promise<ListUsersOutput> {
  const query = normalizePageQuery(input);          // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
  const { items, total } = await this.users.list(query);
  return createPage(items.map(toUserDto), total, query); // computes hasNext / hasPrev
}
```

**Protect a route** by wiring the decorator as a hook and handing the use case an actor (see the
linked docs for depth):

```ts
app.get(
  '/',
  {
    onRequest: [app.authenticate], // 401 if the bearer token is missing/invalid
    schema: { response: { 200: paginatedUsers, 401: errorResponse, 403: errorResponse } },
  },
  async (request, reply) => {
    const { listUsers } = request.diScope.cradle;
    // ListUsers.execute calls ensurePermission first — 403 if the caller lacks users.read
    const page = await listUsers.execute(request.query, toRequestActor(request.user));
    return reply.status(200).send(page);
  },
);
```

## Design decisions & trade-offs

- **One centralized error handler over per-route `try/catch`.** A single `setErrorHandler` owns the
  entire kind→status→envelope translation, so no route ever writes a status code for an error and the
  wire shape can never drift between endpoints. The alternative — HTTP-aware errors or `try/catch` in
  each use case — would scatter status codes across the application layer and duplicate the envelope.
  The cost is one indirection: to see why a thrown error became a given status you read
  `error-handler.ts`, not the throw site.
- **A semantic `AppError` hierarchy in `src/shared`, framework-free.** Inner layers throw meaning
  (`NotFoundError`, `ConflictError`) carrying a `kind`, a machine `code`, and optional `details`;
  `kind` decides the status, `code` / `message` / `details` fill the body. Because these types import
  no framework, an application use case constructs them without violating the Dependency Rule, and the
  presentation layer is the sole place they turn into HTTP.
- **`isOperational` splits expected failures from bugs.** Semantic errors are operational (logged at
  `info`); only `InternalError` is non-operational (logged at `error`), and any unknown throw is
  treated as a bug and answered with a generic `500` message. This keeps log severity meaningful and
  guarantees internal detail is never serialized to a client.
- **Zod serializer compilers to enforce response contracts.** Declaring a `response` schema makes the
  outgoing JSON validated and **whitelisted** to exactly the declared fields, turning "don't forget to
  omit the password hash" from a discipline into a guarantee (proved by `pagination-schema.test.ts`,
  which asserts unknown item fields are stripped). It doubles as the OpenAPI source of truth. The
  trade-off: every response needs a schema, and a too-loose schema weakens the guarantee — the
  enforcement is only as tight as the contract you write.
- **Shared, framework-free pagination (`normalizePageQuery` / `createPage`).** Request clamping
  (page ≥ 1, `pageSize` ≤ 100) and metadata math (`hasNext` / `hasPrev`) live once in `src/shared`,
  used by both use cases and the `paginated()` response schema, so every list endpoint paginates
  identically and a hostile `pageSize=100000` is bounded server-side.
- **Redis-backed, distributed rate limiting.** `@fastify/rate-limit` is given a dedicated Redis handle
  (`diContainer.cradle.rateLimitRedis`, a singleton `ioredis` connection with tight `connectTimeout` /
  `commandTimeout` and `enableOfflineQueue: false`) so the counter is shared across every process/replica
  rather than living in each instance's memory — a per-process store would let N replicas each grant the
  full quota, silently multiplying the real limit by N. The keys are namespaced with `finflow-rate-limit-`,
  and `skipOnError: true` makes the limiter **fail open**: if Redis is unreachable the request is allowed
  rather than blocked, trading strict enforcement for availability so a Redis blip cannot take the API down.
- **Secure-by-default middleware, environment-aware.** helmet, a `WEB_ORIGIN`-pinned CORS allowlist
  with `credentials: true` (required for the refresh cookie), and a global rate limit are all on unless
  explicitly relaxed. Two relaxations are deliberate and code-visible: CSP is disabled outside
  production so Swagger UI works, and Swagger itself is registered only when `!env.isProduction`.
- **Boot-time production secret check that fails loud, not silent.** `assertProductionSecrets` runs the
  moment `env.ts` is imported (before any server is built) and, in production only, refuses to start
  when `COOKIE_SECRET` or `JWT_ACCESS_SECRET` is under 32 chars — or `BULL_BOARD_PASSWORD` under 16
  chars when the dashboard is enabled. It reports **every** offending key in one throw with an
  `openssl rand -base64 48` hint, so a weak deploy is caught at startup rather than discovered after a
  breach. Outside production it is a no-op, keeping local dev friction-free.
- **Bull Board is opt-in and self-guarded.** The queue dashboard is registered only when
  `BULL_BOARD_ENABLED`, sits behind `@fastify/basic-auth` whose validator (`createBasicAuthValidator`)
  compares credentials in **constant time** (SHA-256 + `timingSafeEqual`) and **fails closed** when
  either configured credential is empty, stamps its own strict `Content-Security-Policy` on every
  response via an `onSend` hook, and defaults to `readOnlyMode`. This exposes operational queue
  visibility without adding an unauthenticated admin surface. Its queues and jobs are documented by
  [Background Jobs](./background-jobs.md).
- **Refresh cookie: `HttpOnly`, `SameSite=Strict`, `Path=/auth`, signed when a secret is set.** The
  refresh token is confined to the `/auth` path and unreadable by JavaScript; when `COOKIE_SECRET` is
  present it is HMAC-signed and `readRefreshCookie` rejects a tampered value. `COOKIE_SECURE` gates the
  `Secure` flag so local HTTP dev still works while production forces HTTPS-only.
- **Registration order is load-bearing.** Awilix is registered before the auth plugin and routes
  (which resolve from `request.diScope.cradle`); the correlation-id plugin runs early so every
  downstream log line and error body carries the id; the metrics plugin sits right after it to observe
  every response; and the error handler is registered before routes so it wraps all of them. Reordering
  these would silently break DI resolution, correlation, metrics coverage, or error coverage.
- **`buildApp` returns the instance without listening.** Networking, signal handling, and worker
  startup live in `main.ts`; `buildApp` only assembles the app and exposes a `rateLimit` toggle. This
  makes the whole HTTP stack injectable in tests (`app.inject(...)`) with no open sockets.

## Testing

Unit tests run under Vitest and live beside the code they cover:

- `src/presentation/http/error-handler.test.ts` — boots a Fastify app with `registerErrorHandler` and
  routes that throw each error type; asserts every `AppError` subclass maps to its status
  (400/404/409/401/403/500), a Fastify `error.validation` yields `400`/`VALIDATION`, a non-`AppError`
  4xx uses its own `statusCode` and `code` (falling back to `BAD_REQUEST`), an unhandled error yields
  `500`/`INTERNAL` with the generic message, unknown routes yield `404`/`ROUTE_NOT_FOUND`, and every
  body carries `requestId`.
- `src/presentation/http/security.test.ts` — registers helmet and rate-limit with the real option
  builders; asserts the `x-content-type-options: nosniff` header, the presence of `x-ratelimit-*`
  headers, a `429` in the `RATE_LIMITED` envelope once the global limit trips, that a per-route bucket
  enforces a stricter limit independently, and that `rateLimitOptions` sets `skipOnError` and the
  `RATE_LIMIT_KEY_NAMESPACE`.
- `src/presentation/http/cookies.test.ts` — exercises `setRefreshCookie` / `clearRefreshCookie` /
  `readRefreshCookie` for `HttpOnly`, `SameSite=Strict`, `Path=/auth`, `Max-Age`, the `Secure` flag,
  and signed-vs-unsigned behaviour including rejection of a tampered signature.
- `src/presentation/http/plugins/correlation-id.test.ts` — asserts the plugin echoes `request.id` as
  the `x-request-id` response header, exposes it as `contextData.correlationId` in the request context,
  and mints a distinct id per request.
- `src/presentation/http/plugins/metrics.test.ts` — asserts the `onResponse` hook records the matched
  route template (`/things/:id`), method, status, and a numeric `durationSeconds`, and labels unmatched
  routes with the bounded `__unmatched__` sentinel instead of the raw URL.
- `src/presentation/http/plugins/bull-board.test.ts` — covers `createBasicAuthValidator` (rejects
  unconfigured credentials, rejects mismatches, accepts an exact match) and `bullBoardPlugin` itself:
  wired through `@fastify/basic-auth` it challenges with `401` and stamps the dashboard's strict CSP
  header on the response.
- `src/presentation/http/schemas/pagination-schema.test.ts` — asserts `paginated()` validates a
  well-formed envelope and **strips unknown fields** from items.
- `src/config/assert-production-secrets.test.ts` — covers the boot-time guard: a no-op outside
  production; in production it passes when both secrets are ≥ 32 chars (including exactly at the
  minimum), throws naming `COOKIE_SECRET` / `JWT_ACCESS_SECRET` when either is short or empty, names
  every weak secret in one error, and includes the `openssl rand` remediation hint.
- `src/shared/errors/app-error.test.ts` — covers the `AppError` base: `instanceof Error`, subclass
  `name`, `kind` / `code` / `message`, `isOperational` default and override, `details`, `timestamp`,
  `cause`, and `toJSON()` (including omission of absent `details`).
- `src/shared/errors/semantic-errors.test.ts` — for each subclass, asserts its `kind`, default and
  custom `code`, default message, and `isOperational` (true for all except `InternalError`).
- `src/shared/pagination.test.ts` — covers `normalizePageQuery` clamping/truncation/defaults and
  `createPage`'s `hasNext` / `hasPrev` metadata, including the empty and exactly-one-full-page cases.

Run the whole suite:

```bash
npm test
```

Run only this feature's tests:

```bash
npx vitest run src/presentation/http src/shared/errors src/shared/pagination.test.ts src/config/assert-production-secrets.test.ts
```
