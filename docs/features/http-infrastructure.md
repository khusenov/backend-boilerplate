# HTTP Infrastructure

> **Status:** Complete · **Layers:** presentation, shared, config · **Verified against:** `5156995`

## Purpose

Every feature that speaks HTTP — user CRUD, authentication, authorization, health checks, metrics —
sits on one shared composition root and one shared set of request/response conventions. This feature
is that foundation: `buildApp` assembles the Fastify application, fixes the order in which
cross-cutting plugins run, mounts the versioned `/v1` API surface, and defines how requests are
validated, how successful responses are shaped, and how **every** error becomes a uniform JSON
envelope with the right HTTP status. Its reason to exist is the Dependency Rule: HTTP concerns —
status codes, headers, response shapes, security policy, URL versioning — must live at the
presentation boundary and nowhere else, so the domain and application layers can throw meaningful
errors and return plain objects without ever importing Fastify or knowing what a `409` is.

## How it works

`buildApp(opts)` in `src/presentation/http/app.ts` constructs and returns a configured Fastify
instance. It does **not** call `listen` — `src/main.ts` owns the network lifecycle: it imports
`./instrumentation` first (tracing bootstrap, see [Tracing](./tracing.md)), calls `buildApp`,
registers graceful shutdown (`registerGracefulShutdown` with `dispose: () => app.close()`), and then
listens on `env.HOST` / `env.PORT`. Construction has two phases: wiring the cross-cutting plugins in
a deliberate order, then registering routes.

### Boot-time configuration guard

Before `buildApp` ever runs, importing `src/config/env.ts` parses the whole process environment once
through **`envalid`** (`cleanEnv`) into a typed, frozen `env`, then immediately calls
`assertProductionSecrets(env)`. That guard is a no-op outside production; in production it refuses to
boot (throws) if any key in `PRODUCTION_SECRET_KEYS` — `COOKIE_SECRET`, `JWT_ACCESS_SECRET`,
`VERIFICATION_CODE_SECRET` — is shorter than `MIN_SECRET_LENGTH` (32) characters, and — only when
`BULL_BOARD_ENABLED` is true — if `BULL_BOARD_PASSWORD` is shorter than 16 characters. It collects
**all** offending keys and throws a single error naming them with a remediation hint
(`openssl rand -base64 48`), so a misconfigured deploy fails fast and loudly rather than starting
with a weak secret.

### Instance configuration

The Fastify factory is given `logger: opts.loggerOptions` (a Pino `LoggerOptions` object built by
`main.ts` from `createLoggerOptions(env.LOG_LEVEL, toServiceIdentity(env))`, so every log line
carries both the level and the service identity — name, environment, version),
`requestIdHeader: CORRELATION_ID_HEADER` (`'x-request-id'`) and `genReqId: () => randomUUID()`, so
every request carries an id taken from the client's `x-request-id` header or freshly minted. That id
becomes the correlation id in logs and the `requestId` in every error body.
`forceCloseConnections: true` supports clean shutdown; `disableRequestLogging` defaults to `false`
and is set to `env.isDevelopment` by `main.ts`.

### Plugin registration order

Fastify **encapsulates** every plugin passed to `app.register`: the plugin function runs against a
_child_ of the instance, and every hook or decorator it adds is scoped to that child — a fresh
**encapsulation context**, meaning a private branch of the instance tree whose additions are visible
to routes registered _inside_ that plugin and to nothing else. Registering at the root does **not**
change this. A plain root-level `app.register(async (app) => app.addHook('onRequest', …))` is
accepted without error and its hook never fires for any other route: silently invisible.

The escape hatch is **`fastify-plugin`** (imported as `fp`). Wrapping a plugin function in `fp(...)`
tells Fastify to skip creating that child context, so the plugin's hooks and decorators attach to the
_parent_ instance — here the root — and are visible to everything registered after it. That is why
every first-party cross-cutting plugin in this codebase is an `fp(...)` wrapper:

| Plugin                | Source                                            | Wrapper                |
| --------------------- | ------------------------------------------------- | ---------------------- |
| `correlationIdPlugin` | `src/presentation/http/plugins/correlation-id.ts` | `fp(async (app) => …)` |
| `metricsPlugin`       | `src/presentation/http/plugins/metrics.ts`        | `fp((app) => …)`       |
| `authPlugin`          | `src/presentation/http/plugins/authenticate.ts`   | `fp((app) => …)`       |
| `idempotencyPlugin`   | `src/presentation/http/plugins/idempotency.ts`    | `fp((app) => …)`       |

The `@fastify/*` plugins registered here ship their own `fp` wrapper for the same reason, which is
how `reply.unauthorized`, `request.diScope`, `request.cookies` and the helmet/CORS/rate-limit hooks
reach the whole app.

**The one deliberate exception is `bullBoardPlugin`** — a plain `export async function` with no
`fp()`, so it stays encapsulated on purpose. That is exactly why its Basic-Auth `onRequest` hook and
its strict-CSP `onSend` hook apply to the dashboard mount and to nothing else on the API.

Two consequences follow, and together they make registration order load-bearing: hooks run in the
order the plugins that added them were registered, and a hook or decorator only reaches routes
registered _after_ it. Each entry below is a real setter or `app.register` call, in current source
order; conditional registrations note their gate, and every entry states what constrains its
position.

1. `app.setValidatorCompiler(validatorCompiler)` and `app.setSerializerCompiler(serializerCompiler)`
   from **`fastify-type-provider-zod`** — makes Zod the schema language for both request validation
   and response serialization. _Constraint:_ must precede route registration, because a route picks
   up the compilers in force when it is added. Position relative to the plugins below is not
   constrained.
2. **`@fastify/sensible`** (`fastifySensible`) — HTTP utility decorators (e.g.
   `reply.unauthorized(...)`). _Constraint:_ must precede any route or plugin that calls one of its
   decorators; nothing else constrains it, so it goes first among the plugins.
3. **`@fastify/helmet`** (`fastifyHelmet`) with `helmetOptions(env.isProduction)` — security
   headers. _Constraint:_ must precede route registration so its header hook covers every response;
   position among the other pre-route plugins is not constrained.
4. **`@fastify/awilix`** (`fastifyAwilixPlugin`) with `disposeOnClose: true`, `disposeOnResponse:
true`, `strictBooleanEnforced: true`, `injectionMode: 'PROXY'` — creates a per-request DI scope
   and disposes it on response. _Constraint:_ its `onRequest` hook is what puts `request.diScope` on
   the request, so it must precede everything that resolves from `request.diScope.cradle` — the
   `authenticate` decorator's body, the idempotency hooks, and every route handler (the **cradle**
   is Awilix's resolved-dependency proxy).
5. `correlationIdPlugin` — registers `@fastify/request-context` and, on every `onRequest`, stamps
   the correlation id into the request context and echoes it back as the `x-request-id` response
   header. _Constraint:_ `onRequest` hooks fire in registration order, so it is registered first
   among the hook-adding first-party plugins to guarantee the id is already in context for every
   later hook, handler, log line, and error body. Documented by
   [Structured Logging](./structured-logging.md).
6. `metricsPlugin` — **only when `env.METRICS_ENABLED`** — an `onResponse` hook that records
   per-request HTTP metrics. _Constraint:_ must precede route registration, or the responses of
   routes registered earlier would go unobserved. Documented by [Metrics](./metrics.md).
7. **`@fastify/cors`** (`fastifyCors`) — Cross-Origin Resource Sharing (CORS) — with `{ origin:
env.WEB_ORIGIN, credentials: true }`. _Constraint:_ must precede route registration so its
   preflight handling and response headers cover every route; position among the other pre-route
   plugins is not constrained.
8. **`@fastify/cookie`** (`fastifyCookie`), passed `{ secret: env.COOKIE_SECRET }` when
   `COOKIE_SECRET` is set (enabling signed cookies) and `{}` otherwise. _Constraint:_ it decorates
   `request.cookies` / `reply.setCookie`, so it must precede the auth routes that read and write the
   refresh cookie — in practice, before route registration.
9. `authPlugin` — decorates the instance with `authenticate`, a bearer-token verifier that route
   groups opt into by wiring it as an `onRequest`/`preHandler` hook (e.g. `userRoutes` opens with
   `app.addHook('onRequest', app.authenticate)`). _Constraint:_ because it is a **decorator** rather
   than a global hook, it does nothing on its own — it must be registered before any route plugin
   that references `app.authenticate`, or that reference is `undefined` at registration time. Its
   body resolves `accessTokenService` per request, so it also depends on `@fastify/awilix` having
   run. Documented by [Authentication](./authentication.md).
10. `idempotencyPlugin` — adds app-wide `preHandler` and `onSend` hooks that make retried mutations
    safe on routes opting in via `config: { idempotency: true }` and an `Idempotency-Key` header:
    the `preHandler` claims the key or replays the stored response, the `onSend` stores or releases
    it. _Constraint:_ must sit before route registration so its hooks wrap every opted-in route, and
    its `preHandler` timing matters — it runs after body parsing and schema validation, so the
    request fingerprint hashes the parsed body. Documented by [Idempotency](./idempotency.md).
11. `registerDependencies(diContainer, app.log)` — Awilix wiring (the composition root,
    `src/container.ts`). _Constraint:_ must precede the three registrations below that read
    `diContainer.cradle` **at composition time** rather than per request: the rate limiter's
    `rateLimitRedis`, the health routes' `healthCheck`, and Bull Board's `dashboardQueue`.
12. `registerErrorHandler(app)` — installs the app-wide error handler **and** the not-found handler.
    _Constraint:_ must be registered before the routes whose throws it should catch; anything
    registered after it is covered, anything before it is not.
13. **`@fastify/swagger`** + **`@fastify/swagger-ui`** at `/docs` — **only when
    `!env.isProduction`** — with the Zod `jsonSchemaTransform` so route schemas become OpenAPI, plus
    a `bearerAuth` JWT security scheme. _Constraint:_ `@fastify/swagger` harvests route schemas
    through an `onRoute` hook, so it must be registered **before** the routes it documents —
    registered after them, `/docs` renders an empty spec. `swagger-ui` must follow `swagger`.
14. `bullBoardPlugin` — **only when `env.BULL_BOARD_ENABLED`** — mounts the Bull Board queue
    dashboard at `env.BULL_BOARD_PATH` (default `/admin/queues`) behind constant-time HTTP Basic
    Auth with its own strict Content-Security-Policy. _Constraint:_ after `registerDependencies`
    (it reads `diContainer.cradle.dashboardQueue` at composition time) and, deliberately, **before**
    `@fastify/rate-limit` — since the global limiter only covers routes registered after it, the
    dashboard sits outside the API quota. Documented by [Background Jobs](./background-jobs.md).
15. **`@fastify/rate-limit`** (`fastifyRateLimit`) with `rateLimitOptions(env.RATE_LIMIT_MAX,
env.RATE_LIMIT_WINDOW)` and `redis: diContainer.cradle.rateLimitRedis` — **only when
    `opts.rateLimit ?? true`**, so tests can disable it. _Constraint:_ after `registerDependencies`
    (it needs `rateLimitRedis`), and before the routes it should limit — its global `onRequest` hook
    applies only to routes registered later, which is precisely the boundary that puts
    `healthRoutes` / `metricsRoutes` / `apiV1Routes` inside the quota and Bull Board outside it. The
    `redis` handle makes the limiter's counters live in Redis (see Design decisions).
16. Routes, each under a prefix: `healthRoutes` (`/health`, receives
    `diContainer.cradle.healthCheck`; see [Health Checks](./health-checks.md)), `metricsRoutes`
    (`/metrics`, **only when `env.METRICS_ENABLED`**; see [Metrics](./metrics.md)), and
    `apiV1Routes` under `API_V1_PREFIX` — the versioned business API described next. _Constraint:_
    last, because every hook, decorator, compiler, and error handler above only reaches routes
    registered after it. Both operational routers then opt **out** of the global limiter in their
    own `onRoute` hook (`route.config = { ...route.config, rateLimit: false }`), so a kubelet
    polling `/health/live` can never be throttled.

### API versioning

The whole business API lives under a single URL version prefix. `API_V1_PREFIX`
(`'/v1'`, defined in `src/presentation/http/api-version.ts`) is the one constant naming the current
API generation; `buildApp` registers `apiV1Routes` under it, and `apiV1Routes`
(`src/presentation/http/routes/api-v1-routes.ts`) in turn mounts each resource router under its own
sub-prefix: `authRoutes` at `/auth`, `userRoutes` at `/users`, `roleRoutes` at `/roles`,
`permissionRoutes` at `/permissions` — so clients call `/v1/auth/login`, `/v1/users`, `/v1/roles`,
`/v1/permissions`. Operational endpoints — `/health`, `/metrics`, `/docs`, the Bull Board dashboard
— stay **unversioned**: they address orchestrators and operators, not API clients. The constant is
also consumed by `cookies.ts`, which scopes the refresh cookie to `` `${API_V1_PREFIX}/auth` ``
(`/v1/auth`), so the cookie path tracks the version prefix automatically.

### A request's happy path

Fastify assigns `request.id` → `onRequest` hooks run (correlation id set and `x-request-id` header
echoed; for protected route groups the `authenticate` decorator verifies the bearer token) → the
body is parsed and the Zod **validator compiler** checks `querystring` / `params` / `body` against
the route's schema → `preHandler` hooks run (idempotency claim/replay on opted-in routes) → the
handler resolves its use case from `request.diScope.cradle` and calls `execute()` →
`reply.send(payload)` runs the payload through the Zod **serializer compiler**, which validates it
against the route's declared `response` schema and strips any field the schema does not declare →
`onSend` hooks run (idempotency stores or releases the key) → the `onResponse` hook (when metrics
are enabled) records the method, matched route template, status, and duration.

### The failure paths that matter

All are funnelled through `registerErrorHandler`'s single `setErrorHandler`
(`src/presentation/http/error-handler.ts`):

- A thrown **`AppError`** (from any inner layer) → its `kind` is mapped through `KIND_TO_STATUS` to
  an HTTP status; the body is `{ error: { ...error.toJSON(), requestId } }`. Operational errors log
  at `info`, non-operational at `error`.
- A **Fastify schema-validation** failure (`error.validation` present) → `400` with code
  `VALIDATION` and the validator's message.
- Any other error carrying a **4xx `statusCode`** → that status, code `error.code ?? 'BAD_REQUEST'`.
  This is how the rate limiter's `429` surfaces (its `errorResponseBuilder` sets `statusCode` and
  `code = 'RATE_LIMITED'`).
- Anything else → `500` with code `INTERNAL` and the generic message `Internal Server Error`, so
  internal failure detail never leaks to the client.

An unmatched route is caught by `setNotFoundHandler` → `404` with code `ROUTE_NOT_FOUND` and the
message `Route <METHOD> <URL> not found`. Because the resource routers exist only under `/v1`, an
unversioned call like `GET /users` falls into this handler.

## Architecture

This feature is not port/adapter-shaped like the others; it is the **presentation composition root**
plus the framework-free **shared** vocabulary (`src/shared/errors`, `src/shared/pagination`) that
both the boundary and the inner layers speak. The direction of dependency is what matters: inner
layers throw **semantic `AppError`s** — framework-free error classes that name the _kind_ of failure
(`NotFoundError`, `ConflictError`, …) instead of an HTTP status — and return plain DTOs / `Page`
objects with no HTTP knowledge; the presentation layer is the **only** place that translates that
vocabulary into HTTP — status codes in `error-handler.ts`, wire shapes in the Zod schemas, security
policy in `security.ts`, URL versioning in `api-version.ts`. The shared error and pagination types
carry no framework imports, which is precisely why an application use case may construct them
without breaching the Dependency Rule. The concrete dependencies the HTTP layer pulls from
`src/container.ts` come from the Awilix cradle at different moments: `rateLimitRedis`, `healthCheck`,
and (when enabled) `dashboardQueue` are resolved once from the global `diContainer.cradle` at
composition time in `buildApp` / `bullBoardPlugin`; `accessTokenService` (in `authenticate`) and
`idempotencyStore` (in the idempotency hooks) are resolved **per request** from
`request.diScope.cradle`; `metricsRecorder` is read from the global cradle per response inside the
`onResponse` metrics hook.

| Component                                      | Layer        | Responsibility                                                                                                                                                                                                                                                                                                                                       | File                                                         |
| ---------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `buildApp`                                     | Presentation | Composition root: configures Fastify, registers plugins in order, mounts routes                                                                                                                                                                                                                                                                      | `src/presentation/http/app.ts`                               |
| `buildHealthApp`                               | Presentation | The worker process's minimal probe server — Fastify + the Zod compilers + `/health` and (when enabled) `/metrics`, deliberately skipping the whole cross-cutting chain (no DI scope, CORS, auth, idempotency, rate limit, or error handler). See [Health Checks](./health-checks.md) and [Metrics](./metrics.md)                                     | `src/presentation/http/health-app.ts`                        |
| `API_V1_PREFIX`                                | Presentation | The single constant naming the current API URL version (`/v1`)                                                                                                                                                                                                                                                                                       | `src/presentation/http/api-version.ts`                       |
| `apiV1Routes`                                  | Presentation | Mounts the v1 resource routers (`/auth`, `/users`, `/roles`, `/permissions`) under the version prefix                                                                                                                                                                                                                                                | `src/presentation/http/routes/api-v1-routes.ts`              |
| `registerErrorHandler`                         | Presentation | Single `setErrorHandler` + `setNotFoundHandler`; maps every error to the JSON envelope                                                                                                                                                                                                                                                               | `src/presentation/http/error-handler.ts`                     |
| `KIND_TO_STATUS`                               | Presentation | Maps each `ErrorKindType` to its HTTP status code                                                                                                                                                                                                                                                                                                    | `src/presentation/http/error-handler.ts`                     |
| `helmetOptions` / `rateLimitOptions`           | Presentation | Security defaults: the helmet Content-Security-Policy (CSP) toggle, and the rate limiter's option set — `max`, `timeWindow`, `skipOnError`, Redis key `nameSpace`, and the `errorResponseBuilder` that turns a throttle into a normal `FastifyError`. (The Redis handle itself is not built here; `buildApp` spreads it in alongside these options.) | `src/presentation/http/security.ts`                          |
| `errorResponse`                                | Presentation | Zod response contract routes declare for error statuses                                                                                                                                                                                                                                                                                              | `src/presentation/http/schemas/error-schema.ts`              |
| `paginated`                                    | Presentation | Zod response-contract factory wrapping a page of items                                                                                                                                                                                                                                                                                               | `src/presentation/http/schemas/pagination-schema.ts`         |
| `timestamp`                                    | Presentation | Zod response contract for date fields (`z.date()`)                                                                                                                                                                                                                                                                                                   | `src/presentation/http/schemas/timestamp-schema.ts`          |
| `correlationIdPlugin`                          | Presentation | Per-request correlation id (see [Structured Logging](./structured-logging.md))                                                                                                                                                                                                                                                                       | `src/presentation/http/plugins/correlation-id.ts`            |
| `metricsPlugin`                                | Presentation | `onResponse` hook recording HTTP metrics (see [Metrics](./metrics.md))                                                                                                                                                                                                                                                                               | `src/presentation/http/plugins/metrics.ts`                   |
| `authPlugin`                                   | Presentation | `authenticate` decorator for bearer auth (see [Authentication](./authentication.md))                                                                                                                                                                                                                                                                 | `src/presentation/http/plugins/authenticate.ts`              |
| `idempotencyPlugin`                            | Presentation | `preHandler`/`onSend` hooks replaying or storing responses for opted-in routes (see [Idempotency](./idempotency.md))                                                                                                                                                                                                                                 | `src/presentation/http/plugins/idempotency.ts`               |
| `bullBoardPlugin` / `createBasicAuthValidator` | Presentation | Basic-auth-guarded Bull Board dashboard mount; the only cross-cutting plugin left encapsulated (see [Background Jobs](./background-jobs.md))                                                                                                                                                                                                         | `src/presentation/http/plugins/bull-board.ts`                |
| `toRequestActor`                               | Presentation | Maps `request.user` to the domain `Actor` a use case authorizes against (see [Role-Based Authorization](./role-based-authorization.md))                                                                                                                                                                                                              | `src/presentation/http/identity/actor-from-token-payload.ts` |
| cookie helpers                                 | Presentation | Read/write the signed refresh-token cookie, scoped to `/v1/auth` (see [Authentication](./authentication.md))                                                                                                                                                                                                                                         | `src/presentation/http/cookies.ts`                           |
| `AppError`                                     | Shared       | Abstract base error carrying `kind`, `code`, `details`, `isOperational`, `timestamp`, `toJSON()`                                                                                                                                                                                                                                                     | `src/shared/errors/app-error.ts`                             |
| `ErrorKind`                                    | Shared       | The closed set of error kinds (`VALIDATION`…`INTERNAL`)                                                                                                                                                                                                                                                                                              | `src/shared/errors/app-error.ts`                             |
| `ValidationError` … `InternalError`            | Shared       | The semantic `AppError` subclasses inner layers throw                                                                                                                                                                                                                                                                                                | `src/shared/errors/semantic-errors.ts`                       |
| `normalizePageQuery` / `createPage`            | Shared       | Framework-free pagination: clamp request input, compute page metadata                                                                                                                                                                                                                                                                                | `src/shared/pagination.ts`                                   |
| `Page` / `PageQuery` / `PageSlice`             | Shared       | Pagination types shared by use cases, repositories, and response schemas                                                                                                                                                                                                                                                                             | `src/shared/pagination.ts`                                   |
| `env`                                          | Config       | Parse + validate the whole environment once at boot (`envalid`), exported frozen                                                                                                                                                                                                                                                                     | `src/config/env.ts`                                          |
| `assertProductionSecrets`                      | Config       | Boot-time guard: refuse to start when a production secret is weak                                                                                                                                                                                                                                                                                    | `src/config/assert-production-secrets.ts`                    |
| `toServiceIdentity`                            | Config       | Derive `{ service, environment, version }` for logs/traces from env                                                                                                                                                                                                                                                                                  | `src/config/service-identity.ts`                             |

## Public surface

Clients program against the **URL layout**, the **error envelope**, and the **pagination envelope**.
Engineers program against the **shared error and pagination building blocks**, the **Zod response
schemas**, and the **route decorators, config flags, and identity helper** the HTTP layer exposes.

**URL layout.** Every business endpoint lives under the version prefix `API_V1_PREFIX` (`/v1`):
`/v1/auth/*`, `/v1/users/*`, `/v1/roles/*`, `/v1/permissions` — the endpoint tables live in the docs
of the features that own them ([Authentication](./authentication.md),
[User CRUD](./user-crud.md), [Role-Based Authorization](./role-based-authorization.md)).
Operational endpoints are unversioned: `/health/live`, `/health/ready`, `/metrics` (when enabled),
`/docs` (non-production), and the Bull Board dashboard at `BULL_BOARD_PATH` (when enabled).

**Error-response envelope.** Every failure — validation, auth, rate limit, unknown crash, unknown
route — comes back in this shape:

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

The shape is guaranteed by _construction_, not by validation: `registerErrorHandler`'s
`setErrorHandler` and `setNotFoundHandler` are the single producers of every error body, and they
build it unconditionally. `errorResponse` (in `error-schema.ts`) is a separate, **opt-in** Zod
contract that a route declares for a given status — it publishes the shape in OpenAPI and lets the
serializer check it, but it only runs when that route declares that status. Plenty of error
responses never touch it: a `500`, an unmatched-route `404`, and any route with no `response` map at
all (`POST /v1/auth/logout` declares only a `body` schema) are serialized straight from the handler.

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
that overrides the default while the status stays fixed. The idempotency plugin uses exactly this
mechanism for its `409 IDEMPOTENCY_KEY_IN_PROGRESS` and `400 IDEMPOTENCY_KEY_INVALID` /
`IDEMPOTENCY_KEY_MISMATCH` answers (see [Idempotency](./idempotency.md)).

**Pagination envelope.** List endpoints accept `page` and `pageSize` query parameters (defaults
`page=1`, `pageSize=10`; `pageSize` capped at 100) and return the page envelope defined by
`paginated(itemSchema)`:

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

// src/presentation/http/schemas  — Zod response contracts feature routes reference
function paginated<Item extends z.ZodType>(item: Item); // page envelope
const timestamp;      // z.date() for date fields
const errorResponse;  // the error envelope
```

**Route decorators, config flags, and identity helpers** the HTTP layer exposes for feature routes
to program against (their behaviour is documented in depth in the linked feature docs):

```ts
app.authenticate;                  // FastifyInstance decorator — verifies the bearer token,
                                   // sets request.user; wire as an onRequest/preHandler hook
request.user?: AccessTokenPayload; // FastifyRequest decorator populated by authenticate

config: { idempotency: true };     // route config flag — opts the route into Idempotency-Key
                                   // claim/replay handling (typed via FastifyContextConfig)

config: { rateLimit: { max, timeWindow } }; // a stricter, independently-counted per-route bucket
config: { rateLimit: false };      // opt OUT of the global limiter entirely — used by the
                                   // operational routers (healthRoutes, metricsRoutes) so probes
                                   // never consume or trip the RATE_LIMIT_MAX quota

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
works). Defaults are copied verbatim; `—` means the variable is **required** (no default, boot fails
if unset). `devDefault` values apply only outside production. Two OpenTelemetry sampler knobs —
`OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` — are read natively by the OTel SDK rather than
`env.ts`, so they are documented in [Tracing](./tracing.md) rather than here.

### Read by this feature

Consumed directly in `buildApp`, its plugins, `security.ts`, `cookies.ts`, `health-app.ts`,
`main.ts`, or the boot-time guard.

| Variable                   | Default                                                   | Meaning                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development`                                             | Environment; one of `development`, `test`, `production`. Drives `env.isProduction`, which gates helmet CSP, Swagger, and the production secret check.                                                                             |
| `HOST`                     | `0.0.0.0`                                                 | Bind address for `app.listen` (used in `main.ts` and `worker.ts`).                                                                                                                                                                |
| `PORT`                     | `8000`                                                    | Listen port of the API process (used in `main.ts`).                                                                                                                                                                               |
| `WORKER_PORT`              | `8001`                                                    | Listen port of the worker process's probe server — the app built by `buildHealthApp` (`src/presentation/http/health-app.ts`) and started in `src/worker.ts`. See [Health Checks](./health-checks.md) and [Metrics](./metrics.md). |
| `LOG_LEVEL`                | `info`                                                    | Pino level (`fatal`…`trace`); `main.ts` turns it into the `loggerOptions` passed to `buildApp`. See [Structured Logging](./structured-logging.md).                                                                                |
| `JWT_ACCESS_SECRET`        | `—`                                                       | Access-token signing secret (required); the boot-time guard demands ≥ 32 chars in production. See [Authentication](./authentication.md).                                                                                          |
| `REFRESH_TOKEN_TTL`        | `1209600`                                                 | Refresh-token lifetime in seconds (14 days); also the refresh-cookie `Max-Age` set by `cookies.ts`.                                                                                                                               |
| `COOKIE_SECRET`            | `''` (empty)                                              | When non-empty, cookies are signed; passed to `@fastify/cookie` in `buildApp` and read by the cookie helpers. The boot-time guard demands ≥ 32 chars in production.                                                               |
| `COOKIE_SECURE`            | `true` (devDefault `false`)                               | Sets the `Secure` flag on the refresh cookie.                                                                                                                                                                                     |
| `WEB_ORIGIN`               | `—` (devDefault `http://127.0.0.1:3000`)                  | Allowed CORS origin; passed to `@fastify/cors` with `credentials: true`.                                                                                                                                                          |
| `RATE_LIMIT_MAX`           | `100`                                                     | Global rate-limit ceiling per window; passed to `@fastify/rate-limit`.                                                                                                                                                            |
| `RATE_LIMIT_WINDOW`        | `1 minute`                                                | Global rate-limit window; also reused by the per-route auth buckets.                                                                                                                                                              |
| `REDIS_URL`                | `—` (devDefault `redis://127.0.0.1:6379`)                 | Redis connection; backs the distributed rate-limit store (and BullMQ, idempotency, health checks).                                                                                                                                |
| `METRICS_ENABLED`          | `true`                                                    | Gates registration of `metricsPlugin` and the `GET /metrics` route in `buildApp` (and the worker's `/metrics` in `buildHealthApp`). See [Metrics](./metrics.md).                                                                  |
| `BULL_BOARD_ENABLED`       | `false`                                                   | Gates registration of `bullBoardPlugin` in `buildApp`, and whether the boot guard enforces `BULL_BOARD_PASSWORD` strength. See [Background Jobs](./background-jobs.md).                                                           |
| `BULL_BOARD_PATH`          | `/admin/queues`                                           | Base path the dashboard mounts at.                                                                                                                                                                                                |
| `BULL_BOARD_USERNAME`      | `admin`                                                   | Basic-auth username for the dashboard.                                                                                                                                                                                            |
| `BULL_BOARD_PASSWORD`      | `''` (empty)                                              | Basic-auth password; empty fails login closed. The boot-time guard demands ≥ 16 chars in production when the dashboard is enabled.                                                                                                |
| `BULL_BOARD_READONLY`      | `true`                                                    | Mounts the dashboard in read-only mode (`readOnlyMode`).                                                                                                                                                                          |
| `VERIFICATION_CODE_SECRET` | `—` (devDefault `dev-verification-code-secret-change-me`) | Not used by the HTTP layer itself, but one of the three keys the boot-time guard enforces (≥ 32 chars in production). See [Email Verification](./email-verification.md).                                                          |

### Read by sibling features through the same `env.ts`

Parsed by the same `cleanEnv` call and validated at the same moment, but consumed elsewhere. Listed
here only so the boot-time contract is complete in one place.

| Variable                      | Default                                                 | Owning doc                                                                                                                 |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `—`                                                     | Prisma connection string (required). See [User CRUD](./user-crud.md).                                                      |
| `JWT_ISSUER`                  | `finflow`                                               | JWT `iss` claim. See [Authentication](./authentication.md).                                                                |
| `JWT_AUDIENCE`                | `finflow-api`                                           | JWT `aud` claim. See [Authentication](./authentication.md).                                                                |
| `ACCESS_TOKEN_TTL`            | `900`                                                   | Access-token lifetime in seconds (15 min). See [Authentication](./authentication.md).                                      |
| `BOOTSTRAP_ADMIN_EMAIL`       | `''` (empty)                                            | Email of the admin seeded at bootstrap. See [Role-Based Authorization](./role-based-authorization.md).                     |
| `RATE_LIMIT_AUTH_MAX`         | `5`                                                     | Stricter per-route ceiling the auth endpoints set via route `config.rateLimit`. See [Authentication](./authentication.md). |
| `QUEUE_PREFIX`                | `finflow`                                               | BullMQ key prefix. See [Background Jobs](./background-jobs.md).                                                            |
| `QUEUE_CONCURRENCY`           | `5`                                                     | BullMQ worker concurrency. See [Background Jobs](./background-jobs.md).                                                    |
| `DATA_RETENTION_TTL`          | `2592000`                                               | Retention window in seconds (30 days). See [Data Retention](./data-retention.md).                                          |
| `IDEMPOTENCY_RESULT_TTL`      | `86400`                                                 | Replay window in seconds for stored idempotent responses (24 h). See [Idempotency](./idempotency.md).                      |
| `IDEMPOTENCY_LOCK_TTL`        | `30`                                                    | In-flight claim guard in seconds for an idempotency key. See [Idempotency](./idempotency.md).                              |
| `HEALTHCHECK_TIMEOUT_MS`      | `2000`                                                  | Per-dependency timeout for health probes. See [Health Checks](./health-checks.md).                                         |
| `OTEL_ENABLED`                | `false`                                                 | Toggles OpenTelemetry tracing. See [Tracing](./tracing.md).                                                                |
| `OTEL_SERVICE_NAME`           | `finflow-api`                                           | Service name; also the `service` field `toServiceIdentity` stamps onto logs. See [Tracing](./tracing.md).                  |
| `OTEL_SERVICE_VERSION`        | `0.0.0`                                                 | Service version; also the `version` field on log/trace identity. See [Tracing](./tracing.md).                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318`                                 | OTLP exporter endpoint. See [Tracing](./tracing.md).                                                                       |
| `SMTP_HOST`                   | `—` (devDefault `localhost`)                            | Outbound SMTP host. See [Email Sending](./email-sending.md).                                                               |
| `SMTP_PORT`                   | `587` (devDefault `1025`)                               | Outbound SMTP port. See [Email Sending](./email-sending.md).                                                               |
| `SMTP_SECURE`                 | `false`                                                 | `true` for port 465 (implicit TLS); `false` uses STARTTLS. See [Email Sending](./email-sending.md).                        |
| `SMTP_REQUIRE_TLS`            | `true` (devDefault `false`)                             | Refuse to send if STARTTLS cannot be negotiated. See [Email Sending](./email-sending.md).                                  |
| `SMTP_USER`                   | `''` (empty)                                            | SMTP auth user; empty means no auth. See [Email Sending](./email-sending.md).                                              |
| `SMTP_PASSWORD`               | `''` (empty)                                            | SMTP auth password. See [Email Sending](./email-sending.md).                                                               |
| `EMAIL_FROM`                  | `—` (devDefault `no-reply@finflow.local`)               | Default `From` address. See [Email Sending](./email-sending.md).                                                           |
| `VERIFICATION_CODE_TTL`       | `900`                                                   | Verification-code lifetime in seconds (15 min). See [Email Verification](./email-verification.md).                         |
| `VERIFICATION_MAX_ATTEMPTS`   | `5`                                                     | Allowed attempts per verification code. See [Email Verification](./email-verification.md).                                 |
| `PASSWORD_RESET_TOKEN_TTL`    | `1800`                                                  | Password-reset token lifetime in seconds (30 min). See [Password Reset](./password-reset.md).                              |
| `PASSWORD_RESET_URL_BASE`     | `—` (devDefault `http://localhost:3000/reset-password`) | Frontend URL the reset email links to; the raw token is appended as `?token=`. See [Password Reset](./password-reset.md).  |

### Code-level options and derived security defaults

`buildApp` also takes three code-level options, not env vars — the `BuildAppOptions` interface:
`loggerOptions` (a Pino `LoggerOptions`), the optional `disableRequestLogging` (default `false`),
and the optional `rateLimit` (default `true`, disabled by unit tests). `main.ts` supplies
`loggerOptions: createLoggerOptions(env.LOG_LEVEL, toServiceIdentity(env))` and
`disableRequestLogging: env.isDevelopment`.

**Security defaults** derive from the environment rather than dedicated flags:

- `helmetOptions(env.isProduction)` returns `{}` in production (helmet's full defaults, **CSP on**)
  and `{ contentSecurityPolicy: false }` elsewhere — CSP is deliberately relaxed outside production
  so the Swagger UI at `/docs` loads.
- `rateLimitOptions(max, timeWindow)` sets `skipOnError: true` (fail-open — allow the request when
  Redis is unreachable), a `nameSpace` of `RATE_LIMIT_KEY_NAMESPACE` (`'finflow-rate-limit-'`) for
  its Redis keys, and an `errorResponseBuilder` that emits a `FastifyError` with `code:
'RATE_LIMITED'` and the window's `statusCode`, so a throttled request flows through the same error
  envelope as everything else.
- Swagger has no dedicated variable — it is gated purely on `!env.isProduction`. Bull Board, by
  contrast, is gated on `BULL_BOARD_ENABLED` and additionally protects itself with Basic Auth and
  its own strict CSP (see [Background Jobs](./background-jobs.md)).

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
     Validation: 'VALIDATION',
     NotFound: 'NOT_FOUND',
     Conflict: 'CONFLICT',
     Unauthorized: 'UNAUTHORIZED',
     Forbidden: 'FORBIDDEN',
     Internal: 'INTERNAL',
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

**Add a cross-cutting plugin.** This is the extension this doc owns end to end. A plugin that adds a
hook or a decorator for the _whole_ app must be wrapped in `fp(...)` — without it Fastify
encapsulates the plugin and the hook fires for nothing (see Plugin registration order). Create the
plugin under `src/presentation/http/plugins/`:

```ts
// src/presentation/http/plugins/tenant.ts
import fp from 'fastify-plugin';
import { ValidationError } from '@/shared/errors';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
  }
}

export const tenantPlugin = fp((app) => {
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-tenant-id'];
    if (header === undefined) return;
    if (typeof header !== 'string' || header.length === 0) {
      throw new ValidationError('Malformed X-Tenant-Id header', { code: 'TENANT_INVALID' });
    }
    request.tenantId = header;
  });
});
```

Then add exactly one line to `buildApp` in `src/presentation/http/app.ts`:

```ts
await app.register(authPlugin);
await app.register(idempotencyPlugin);
await app.register(tenantPlugin); // hooks must wrap routes → before route registration

registerDependencies(diContainer, app.log);
registerErrorHandler(app);
```

Position follows from what the plugin needs, and the four rules compose — take the latest position
every applicable rule allows, then register before every route:

| The plugin…                                            | goes after / before                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| resolves per request from `request.diScope.cradle`     | **after** `fastifyAwilixPlugin` (that's what creates `request.diScope`) |
| reads `diContainer.cradle` at composition time         | **after** `registerDependencies(...)`                                   |
| adds hooks that must wrap routes                       | **before** the route registrations at the end of `buildApp`             |
| must observe or translate errors thrown by other hooks | **before** `registerErrorHandler(app)`                                  |
| should be exempt from / covered by the global limiter  | **before** / **after** `fastifyRateLimit`                               |
| deliberately scopes its hooks to one mount only        | drop the `fp()` wrapper (this is what `bullBoardPlugin` does)           |

Give it a sibling test under `plugins/` — the existing five (`authenticate.test.ts`,
`correlation-id.test.ts`, `idempotency.test.ts`, `metrics.test.ts`, `bull-board.test.ts`) build a
bare Fastify instance, register the plugin, and `inject` requests at it.

**Mount a new v1 resource router.** Feature routers are Fastify plugins (typed
`FastifyPluginCallbackZod`); `apiV1Routes` is the one place that assigns their URL real estate. Add
one registration in `src/presentation/http/routes/api-v1-routes.ts` and the router inherits the
`/v1` prefix, the shared plugins, and the error handler:

```ts
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { accountRoutes } from '@/presentation/http/routes/account-routes';
import { authRoutes } from '@/presentation/http/routes/auth-routes';
import { permissionRoutes } from '@/presentation/http/routes/permission-routes';
import { roleRoutes } from '@/presentation/http/routes/role-routes';
import { userRoutes } from '@/presentation/http/routes/user-routes';

export const apiV1Routes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.register(authRoutes, { prefix: '/auth' });
  app.register(userRoutes, { prefix: '/users' });
  app.register(roleRoutes, { prefix: '/roles' });
  app.register(permissionRoutes, { prefix: '/permissions' });
  app.register(accountRoutes, { prefix: '/accounts' }); // → /v1/accounts
  done();
};
```

The router itself opens with the convention every existing router follows: one `onRequest` hook for
auth (when the whole group is protected) and one **`onRoute` hook that stamps the group's OpenAPI
tag** — a router without it lands untagged and unlabelled in `/docs`:

```ts
// src/presentation/http/routes/account-routes.ts
export const accountRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = {
      ...route.schema,
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
    };
  });

  // app.get('/', …), app.post('/', …), …
  done();
};
```

The same hook is where a router sets group-wide route `config` — this is how `healthRoutes` and
`metricsRoutes` exempt themselves from the global rate limiter:

```ts
app.addHook('onRoute', (route) => {
  route.schema = { ...route.schema, tags: ['Health'] };
  route.config = { ...route.config, rateLimit: false };
});
```

A future breaking API generation gets its own `API_V2_PREFIX` constant in `api-version.ts` and a
sibling `apiV2Routes` registered next to `apiV1Routes` in `app.ts` — v1 keeps serving unchanged.

**Declare a response contract on a route** so the wire shape is enforced and internal fields are
stripped. Compose `paginated`, `timestamp`, and `errorResponse` (this mirrors what the user routes
do):

```ts
import { z } from 'zod';
import { paginated } from '../schemas/pagination-schema';
import { timestamp } from '../schemas/timestamp-schema';
import { errorResponse } from '../schemas/error-schema';

const accountResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  closedAt: timestamp.nullable(), // nullable in the DTO ⇒ nullable here, or a real null becomes a 500
  createdAt: timestamp,
  updatedAt: timestamp,
});
const paginatedAccounts = paginated(accountResponse);

app.get(
  '/',
  {
    schema: {
      querystring: z.object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).optional(),
      }),
      response: { 200: paginatedAccounts, 400: errorResponse },
    },
  },
  handler,
);
```

Because the serializer compiler validates the outgoing payload against `accountResponse`, any field
the schema does not list (a password hash, an internal flag) is dropped before it reaches the client
— even if a mapper accidentally includes it. The same validation is **fail-closed** in the other
direction, so the schema must admit every legal value the DTO can hold (see Design decisions).

**Return a page from a use case** with the shared helpers. This is exactly the body of
`src/application/user/list-users.ts` — note the two-argument `execute(input, actor)` signature and
the permission check as the first statement, which is what makes `toRequestActor(request.user)` the
last argument at the call site:

```ts
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { createPage, normalizePageQuery } from '@/shared/pagination';

async execute(input: ListUsersInput, actor: Actor): Promise<ListUsersOutput> {
  ensurePermission(actor, PERMISSIONS.UsersRead.key);       // throws ForbiddenError → 403

  const query = normalizePageQuery(input);                  // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
  const { items, total } = await this.users.list(query);
  return createPage(items.map(toUserDto), total, query);    // computes hasNext / hasPrev
}
```

**Protect a route** by wiring the decorator as a hook and handing the use case an actor (see the
linked docs for depth):

```ts
app.get(
  '/',
  {
    onRequest: [app.authenticate], // 401 if the bearer token is missing/invalid
    schema: { response: { 200: paginatedAccounts, 401: errorResponse, 403: errorResponse } },
  },
  async (request, reply) => {
    const { listAccounts } = request.diScope.cradle;
    // the use case calls its permission check first — 403 if the caller lacks the permission
    const page = await listAccounts.execute(request.query, toRequestActor(request.user));
    return reply.status(200).send(page);
  },
);
```

**Tighten or specialize per-route policy through route `config`** — the same mechanism the auth
routes use. A stricter rate bucket and idempotent retries are both opt-in flags, no new plumbing
(mirrors `POST /v1/auth/register` in `src/presentation/http/routes/auth-routes.ts`):

```ts
app.post(
  '/',
  {
    config: {
      idempotency: true, // Idempotency-Key claim/replay — see docs/features/idempotency.md
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW },
    },
    schema: { body: createAccountBody, response: { 201: accountResponse, 409: errorResponse } },
  },
  handler,
);
```

## Design decisions & trade-offs

- **One centralized error handler over per-route `try/catch`.** A single `setErrorHandler` owns the
  entire kind→status→envelope translation, so no route ever writes a status code for an error and
  the wire shape can never drift between endpoints. The alternative — HTTP-aware errors or
  `try/catch` in each use case — would scatter status codes across the application layer and
  duplicate the envelope. The cost is one indirection: to see why a thrown error became a given
  status you read `error-handler.ts`, not the throw site.
- **A semantic `AppError` hierarchy in `src/shared`, framework-free.** Inner layers throw meaning
  (`NotFoundError`, `ConflictError`) carrying a `kind`, a machine `code`, and optional `details`;
  `kind` decides the status, `code` / `message` / `details` fill the body. Because these types
  import no framework, an application use case constructs them without violating the Dependency
  Rule, and the presentation layer is the sole place they turn into HTTP.
- **`isOperational` splits expected failures from bugs.** Semantic errors are operational (logged at
  `info`); only `InternalError` is non-operational (logged at `error`), and any unknown throw is
  treated as a bug and answered with a generic `500` message. This keeps log severity meaningful and
  guarantees internal detail is never serialized to a client.
- **URL-prefix versioning through one constant.** The version lives in the path (`/v1/...`), not in
  a header, so it is visible in logs, curl-able, and cacheable, and the whole generation is
  represented by a single constant (`API_V1_PREFIX`) plus a single mounting plugin (`apiV1Routes`) —
  a breaking v2 becomes a sibling mount rather than a rewrite, and old clients keep working.
  Operational endpoints stay unversioned because they are contracts with orchestrators, not API
  clients. The costs: the version string appears in every client URL, and anything path-scoped must
  follow the prefix — which is why `cookies.ts` derives the refresh-cookie path from
  `API_V1_PREFIX`; a v2 auth router would need its own cookie scope decision.
- **Zod serializer compilers to enforce response contracts.** Declaring a `response` schema makes
  the outgoing JSON validated and **whitelisted** to exactly the declared fields, turning "don't
  forget to omit the password hash" from a discipline into a guarantee (proved by
  `pagination-schema.test.ts`, which asserts unknown item fields are stripped). It doubles as the
  OpenAPI source of truth. The enforcement is **fail-closed** in both directions, and that is the
  sharp edge: a payload the schema _rejects_ does not degrade gracefully — serialization throws and
  the client gets a `500` in place of a perfectly good `200`. So a response schema must admit every
  legal value the DTO can hold, which is exactly why `role-response-schema.ts` marks `key` and
  `description` `.nullable()`: both are `string | null` in `RoleDto`, and a plain `z.string()` would
  turn every role with no key into a `500`. The other trade-off: every response needs a schema, and
  a too-loose one weakens the stripping guarantee — the enforcement is only as tight as the contract
  you write.
- **Shared, framework-free pagination (`normalizePageQuery` / `createPage`).** Request clamping
  (page ≥ 1, `pageSize` ≤ 100) and metadata math (`hasNext` / `hasPrev`) live once in `src/shared`,
  used by both use cases and the `paginated()` response schema, so every list endpoint paginates
  identically and a hostile `pageSize=100000` is bounded server-side.
- **Redis-backed, distributed rate limiting that fails open.** `@fastify/rate-limit` is given a
  dedicated Redis handle (`diContainer.cradle.rateLimitRedis`, a singleton `ioredis` connection with
  tight `connectTimeout` / `commandTimeout` and `enableOfflineQueue: false`) so the counter is
  shared across every process/replica rather than living in each instance's memory — a per-process
  store would let N replicas each grant the full quota, silently multiplying the real limit by N.
  The keys are namespaced with `finflow-rate-limit-`, and `skipOnError: true` makes the limiter
  **fail open**: if Redis is unreachable the request is allowed rather than blocked, trading strict
  enforcement for availability so a Redis blip cannot take the API down. Sensitive endpoints layer
  stricter per-route buckets on top via route `config.rateLimit` (`RATE_LIMIT_AUTH_MAX`), each
  bucket counted independently; conversely the operational routers opt out entirely with
  `config: { rateLimit: false }`, because a liveness probe from a kubelet or a Prometheus scrape
  must never be able to exhaust — or be refused by — the shared client quota. Both the global and
  per-route behaviours are proved by `test/integration/rate-limit.int.test.ts`.
- **Cross-cutting idempotency as a plugin, opt-in per route.** Retried mutations are an HTTP
  delivery concern, so the claim/replay mechanics live in one `fastify-plugin`
  (`idempotencyPlugin`) rather than inside use cases, and routes opt in with a one-line
  `config: { idempotency: true }`. Its placement in `buildApp` — before route registration — is
  what lets its `preHandler`/`onSend` hooks wrap every opted-in route. Store, TTLs, and failure
  semantics are documented in [Idempotency](./idempotency.md).
- **Secure-by-default middleware, environment-aware.** helmet, a `WEB_ORIGIN`-pinned CORS allowlist
  with `credentials: true` (required for the refresh cookie), and a global rate limit are all on
  unless explicitly relaxed. Two relaxations are deliberate and code-visible: CSP is disabled
  outside production so Swagger UI works, and Swagger itself is registered only when
  `!env.isProduction`.
- **Boot-time production secret check that fails loud, not silent.** `assertProductionSecrets` runs
  the moment `env.ts` is imported (before any server is built) and, in production only, refuses to
  start when `COOKIE_SECRET`, `JWT_ACCESS_SECRET`, or `VERIFICATION_CODE_SECRET` is under 32 chars —
  or `BULL_BOARD_PASSWORD` under 16 chars when the dashboard is enabled. It reports **every**
  offending key in one throw with an `openssl rand -base64 48` hint, so a weak deploy is caught at
  startup rather than discovered after a breach. Outside production it is a no-op, keeping local dev
  friction-free.
- **Bull Board is opt-in, self-guarded, and deliberately encapsulated.** The queue dashboard is
  registered only when `BULL_BOARD_ENABLED` and defends itself (constant-time Basic Auth that fails
  closed, its own strict CSP, `readOnlyMode` by default) instead of relying on ambient protections.
  It is the one cross-cutting plugin _not_ wrapped in `fastify-plugin`, which is what confines its
  Basic-Auth and CSP hooks to the dashboard mount rather than applying them to the whole API — the
  encapsulation that is a hazard everywhere else is the feature here. Details in
  [Background Jobs](./background-jobs.md).
- **Refresh cookie: `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, signed when a secret is set.**
  The refresh token is confined to the versioned auth path and unreadable by JavaScript; when
  `COOKIE_SECRET` is present it is HMAC-signed and `readRefreshCookie` rejects a tampered value.
  `COOKIE_SECURE` gates the `Secure` flag so local HTTP dev still works while production forces
  HTTPS-only.
- **Registration order is load-bearing.** Awilix is registered before the auth and idempotency
  plugins and routes (which resolve from `request.diScope.cradle`); `registerDependencies` runs
  before the rate limiter, health routes, and Bull Board (which read `diContainer.cradle` at
  composition time); the correlation-id plugin runs early so every downstream log line and error
  body carries the id; the metrics plugin sits before routes to observe every response; Swagger
  precedes routes because it harvests schemas through an `onRoute` hook; the idempotency plugin
  precedes route registration so its hooks wrap opted-in routes; and the error handler is registered
  before routes so it wraps all of them. Reordering these would silently break DI resolution,
  correlation, metrics coverage, the OpenAPI spec, idempotent replay, or error coverage — silently,
  because Fastify raises no error for a hook that reaches nothing.
- **The worker gets a separate, minimal app.** `buildHealthApp` builds a second Fastify instance for
  the worker process with only the Zod compilers and the `/health` + `/metrics` routers — no DI
  scope plugin, CORS, cookies, auth, idempotency, rate limiting, Swagger, or error handler. The
  worker serves no public traffic, so every one of those would be cost without benefit, and keeping
  them out means a change to the API's plugin chain cannot break the worker's probes (see
  [Health Checks](./health-checks.md) and [Metrics](./metrics.md)).
- **`buildApp` returns the instance without listening.** Networking, signal handling, and worker
  startup live in `main.ts`; `buildApp` only assembles the app and exposes a `rateLimit` toggle.
  This makes the whole HTTP stack injectable in tests (`app.inject(...)`) with no open sockets.

## Testing

Unit tests run under Vitest and live beside the code they cover:

- `src/presentation/http/error-handler.test.ts` — boots a Fastify app with `registerErrorHandler`
  and routes that throw each error type; asserts every `AppError` subclass maps to its status
  (400/404/409/401/403/500), a Fastify `error.validation` yields `400`/`VALIDATION`, a non-`AppError`
  4xx uses its own `statusCode` and `code` (falling back to `BAD_REQUEST`), an unhandled error
  yields `500`/`INTERNAL` with the generic message, unknown routes yield `404`/`ROUTE_NOT_FOUND`,
  and every body carries `requestId`.
- `src/presentation/http/security.test.ts` — registers helmet and rate-limit with the real option
  builders; asserts the `x-content-type-options: nosniff` header, the presence of `x-ratelimit-*`
  headers, a `429` in the `RATE_LIMITED` envelope once the global limit trips, that a per-route
  bucket enforces a stricter limit independently, and that `rateLimitOptions` sets `skipOnError` and
  the `RATE_LIMIT_KEY_NAMESPACE`.
- `src/presentation/http/cookies.test.ts` — exercises `setRefreshCookie` / `clearRefreshCookie` /
  `readRefreshCookie` for `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, `Max-Age`, the `Secure`
  flag, and signed-vs-unsigned behaviour including rejection of a tampered signature.
- `src/presentation/http/routes/api-v1-routes.test.ts` — mocks the four resource routers and
  asserts `apiV1Routes` mounts each under its own `/v1` sub-prefix (`/v1/auth/login`, `/v1/users`,
  `/v1/roles`, `/v1/permissions`) and that unversioned paths (`/users`) 404.
- `src/presentation/http/schemas/pagination-schema.test.ts` — asserts `paginated()` validates a
  well-formed envelope and **strips unknown fields** from items.
- `src/config/assert-production-secrets.test.ts` — covers the boot-time guard: a no-op outside
  production; in production it passes when secrets are ≥ 32 chars (including exactly at the
  minimum), throws naming the offending key when one is short or empty, names every weak secret in
  one error, and includes the `openssl rand` remediation hint.
- `src/shared/errors/app-error.test.ts` — covers the `AppError` base: `instanceof Error`, subclass
  `name`, `kind` / `code` / `message`, `isOperational` default and override, `details`,
  `timestamp`, `cause`, and `toJSON()` (including omission of absent `details`).
- `src/shared/errors/semantic-errors.test.ts` — for each subclass, asserts its `kind`, default and
  custom `code`, default message, and `isOperational` (true for all except `InternalError`).
- `src/shared/pagination.test.ts` — covers `normalizePageQuery` clamping/truncation/defaults and
  `createPage`'s `hasNext` / `hasPrev` metadata, including the empty and exactly-one-full-page
  cases.
- The plugins under `src/presentation/http/plugins/` each carry their own sibling test
  (`authenticate.test.ts`, `correlation-id.test.ts`, `idempotency.test.ts`, `metrics.test.ts`,
  `bull-board.test.ts`); their scenarios are described in the feature docs that own those
  subsystems.

Integration tests (real container, Redis-backed; configured by `vitest.integration.config.ts`):

- `test/integration/app-bootstrap.int.test.ts` — boots the **real** `buildApp` end to end (full
  plugin chain and container wiring) and asserts `GET /health/live` and `GET /health/ready` answer 200.
- `test/integration/rate-limit.int.test.ts` — with a real Redis: trips the auth bucket at
  `RATE_LIMIT_AUTH_MAX` on `POST /v1/auth/login`, proves `/v1/auth/forgot-password` and
  `/v1/auth/reset-password` count in independent buckets, verifies the counters live under
  `RATE_LIMIT_KEY_NAMESPACE`-prefixed Redis keys, and proves fail-open by disconnecting
  `rateLimitRedis` and still receiving a `401` (not a block).

Run the suites:

```bash
npm test                       # all unit tests
npm run test:integration       # integration tests (needs the docker-compose dependencies)
```

Run only this feature's unit tests:

```bash
npx vitest run src/presentation/http src/shared/errors src/shared/pagination.test.ts src/config/assert-production-secrets.test.ts
```
