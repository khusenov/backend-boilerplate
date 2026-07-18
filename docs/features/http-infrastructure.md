# HTTP Infrastructure

> **Status:** Complete · **Layers:** presentation, shared, config · **Verified against:** `46c4a07`

## Purpose

Every feature that speaks HTTP — user CRUD, authentication, authorization, health checks — sits on
one shared composition root and one shared set of request/response conventions. This feature is that
foundation: it assembles the Fastify application (`buildApp`), fixes the order in which cross-cutting
plugins run, and defines how requests are validated, how successful responses are shaped, and how
**every** error becomes a uniform JSON envelope with the right HTTP status. Its reason to exist is the
Dependency Rule: HTTP concerns — status codes, headers, response shapes, security policy — must live
at the presentation boundary and nowhere else, so the domain and application layers can throw
meaningful errors and return plain objects without ever importing Fastify or knowing what a `409` is.

## How it works

`buildApp(opts)` in `src/presentation/http/app.ts` constructs and returns a configured Fastify
instance (it does **not** call `listen` — `src/main.ts` owns the network lifecycle). Construction has
two phases: wiring the cross-cutting plugins in a deliberate order, then registering feature routes.

**Instance configuration.** The Fastify factory is given `requestIdHeader: CORRELATION_ID_HEADER`
(`'x-request-id'`) and `genReqId: () => randomUUID()`, so every request carries an id taken from the
client's `x-request-id` header or freshly minted. That id becomes the correlation id in logs and the
`requestId` in every error body. `forceCloseConnections: true` supports clean shutdown; `logger.level`
and `disableRequestLogging` come from `opts`.

**Plugin registration order** (each line is a real `app.register` / setter call, in source order):

1. `app.setValidatorCompiler(validatorCompiler)` and `app.setSerializerCompiler(serializerCompiler)`
   from **`fastify-type-provider-zod`** — makes Zod the schema language for both request validation
   and response serialization.
2. **`@fastify/sensible`** (`fastifySensible`) — HTTP utility decorators.
3. **`@fastify/helmet`** (`fastifyHelmet`) with `helmetOptions(env.isProduction)` — security headers.
4. **`@fastify/awilix`** (`fastifyAwilixPlugin`) — creates a per-request DI scope
   (`disposeOnResponse: true`, `injectionMode: 'PROXY'`); must precede anything that resolves from
   `request.diScope.cradle`.
5. `correlationIdPlugin` — stamps the correlation id into request context and echoes the
   `x-request-id` response header. Documented by [Structured Logging](./structured-logging.md).
6. **`@fastify/cors`** (`fastifyCors`) with `{ origin: env.WEB_ORIGIN, credentials: true }`.
7. **`@fastify/cookie`** (`fastifyCookie`), signed when `COOKIE_SECRET` is set.
8. `authPlugin` — decorates the instance with `authenticate`. Documented by
   [Authentication](./authentication.md).
9. `registerDependencies(diContainer, app.log)` — Awilix wiring (the composition root).
10. `registerErrorHandler(app)` — installs the app-wide error handler **and** the not-found handler.
    Registered before routes so it catches everything they throw.
11. **`@fastify/swagger`** + **`@fastify/swagger-ui`** at `/docs` — **non-production only**
    (`if (!env.isProduction)`).
12. **`@fastify/rate-limit`** (`fastifyRateLimit`) with `rateLimitOptions(env.RATE_LIMIT_MAX,
env.RATE_LIMIT_WINDOW)` — gated on `opts.rateLimit ?? true` so tests can disable it.
13. Feature routes, each under a prefix: `healthRoutes` (`/health`), `authRoutes` (`/auth`),
    `userRoutes` (`/users`), `roleRoutes` (`/roles`), `permissionRoutes` (`/permissions`).

**A request's happy path.** Fastify assigns `request.id` → `onRequest` hooks run (correlation id set,
security headers applied, and for protected route groups the `authenticate` decorator verifies the
bearer token) → the Zod **validator compiler** checks `querystring`/`params`/`body` against the
route's schema → the handler resolves its use case from `request.diScope.cradle` and calls
`execute()` → `reply.send(payload)` runs the payload through the Zod **serializer compiler**, which
validates it against the route's declared `response` schema and strips any field the schema does not
declare.

**The failure paths that matter**, all funnelled through `registerErrorHandler`'s single
`setErrorHandler` (see `src/presentation/http/error-handler.ts`):

- A thrown **`AppError`** (from any inner layer) → its `kind` is mapped through `KIND_TO_STATUS` to an
  HTTP status; the body is `{ error: { ...error.toJSON(), requestId } }`. Operational errors log at
  `info`, non-operational at `error`.
- A **Fastify schema-validation** failure (`error.validation` present) → `400` with code
  `VALIDATION`.
- Any other error carrying a **4xx `statusCode`** → that status, code `error.code ?? 'BAD_REQUEST'`.
  This is how the rate limiter's `429` surfaces (its `errorResponseBuilder` sets `statusCode = 429`,
  `code = 'RATE_LIMITED'`).
- Anything else → `500` with code `INTERNAL` and the generic message `Internal Server Error`, so
  internal failure detail never leaks to the client.

An unmatched route is caught by `setNotFoundHandler` → `404` with code `ROUTE_NOT_FOUND`.

## Architecture

This feature is not port/adapter-shaped like the others; it is the **presentation composition root**
plus the framework-free **shared** vocabulary (`src/shared/errors`, `src/shared/pagination`) that both
the boundary and the inner layers speak. The direction of dependency is what matters: inner layers
throw semantic `AppError`s and return plain DTOs/`Page` objects with no HTTP knowledge; the
presentation layer is the **only** place that translates that vocabulary into HTTP — status codes in
`error-handler.ts`, wire shapes in the Zod schemas, security policy in `security.ts`. The shared error
and pagination types carry no framework imports, which is precisely why an application use case may
construct them without breaching the Dependency Rule.

| Component                            | Layer        | Responsibility                                                                                   | File                                                 |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `buildApp`                           | Presentation | Composition root: configures Fastify, registers plugins in order, mounts routes                  | `src/presentation/http/app.ts`                       |
| `registerErrorHandler`               | Presentation | Single `setErrorHandler` + `setNotFoundHandler`; maps every error to the JSON envelope           | `src/presentation/http/error-handler.ts`             |
| `KIND_TO_STATUS`                     | Presentation | Maps each `ErrorKind` to its HTTP status code                                                    | `src/presentation/http/error-handler.ts`             |
| `helmetOptions` / `rateLimitOptions` | Presentation | Security defaults: helmet CSP toggle and the rate-limit envelope                                 | `src/presentation/http/security.ts`                  |
| `errorResponse`                      | Presentation | Zod response contract for the error envelope                                                     | `src/presentation/http/schemas/error-schema.ts`      |
| `paginated`                          | Presentation | Zod response-contract factory wrapping a page of items                                           | `src/presentation/http/schemas/pagination-schema.ts` |
| `timestamp`                          | Presentation | Zod response contract for date fields (`z.date()`)                                               | `src/presentation/http/schemas/timestamp-schema.ts`  |
| `AppError`                           | Shared       | Abstract base error carrying `kind`, `code`, `details`, `isOperational`, `timestamp`, `toJSON()` | `src/shared/errors/app-error.ts`                     |
| `ErrorKind`                          | Shared       | The closed set of error kinds (`VALIDATION`…`INTERNAL`)                                          | `src/shared/errors/app-error.ts`                     |
| `ValidationError` … `InternalError`  | Shared       | Semantic `AppError` subclasses inner layers throw                                                | `src/shared/errors/semantic-errors.ts`               |
| `normalizePageQuery` / `createPage`  | Shared       | Framework-free pagination: clamp request input, compute page metadata                            | `src/shared/pagination.ts`                           |
| `Page` / `PageQuery` / `PageSlice`   | Shared       | Pagination types shared by use cases, repositories, and response schemas                         | `src/shared/pagination.ts`                           |
| cookie helpers                       | Presentation | Read/write the signed refresh-token cookie (see [Authentication](./authentication.md))           | `src/presentation/http/cookies.ts`                   |
| `correlationIdPlugin`                | Presentation | Per-request correlation id (see [Structured Logging](./structured-logging.md))                   | `src/presentation/http/plugins/correlation-id.ts`    |
| `authPlugin`                         | Presentation | `authenticate` decorator for bearer auth (see [Authentication](./authentication.md))             | `src/presentation/http/plugins/authenticate.ts`      |

## Public surface

Two things clients program against (the wire contracts) and one thing engineers program against (the
building blocks).

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

`code` and `message` and `requestId` are always present; `details` is optional. `requestId` equals the
request's correlation id (`x-request-id`), so a client error report is traceable straight to the log
lines for that request. The status→code correspondence:

| HTTP status | `code`                          | Source                                                    |
| ----------- | ------------------------------- | --------------------------------------------------------- |
| 400         | `VALIDATION`                    | `ValidationError`, or a Fastify schema-validation failure |
| 401         | `UNAUTHORIZED`                  | `UnauthorizedError`                                       |
| 403         | `FORBIDDEN`                     | `ForbiddenError`                                          |
| 404         | `NOT_FOUND` / `ROUTE_NOT_FOUND` | `NotFoundError` / unmatched route                         |
| 409         | `CONFLICT`                      | `ConflictError`                                           |
| 429         | `RATE_LIMITED`                  | rate limiter's `errorResponseBuilder`                     |
| 4xx         | `error.code ?? 'BAD_REQUEST'`   | any non-`AppError` with a 4xx `statusCode`                |
| 500         | `INTERNAL`                      | `InternalError` or any unhandled error (generic message)  |

The `code` is a stable machine-readable string; semantic errors accept a **custom** `code`
(e.g. `new ConflictError('…', { code: 'EMAIL_TAKEN' })`) that overrides the default while the HTTP
status stays governed by `kind`.

**Pagination envelope.** List endpoints accept `page` and `pageSize` query parameters and return the
page envelope defined by `paginated(itemSchema)`:

```json
{
  "items": [/* … */],
  "page": 1,
  "pageSize": 10,
  "total": 42,
  "hasNext": true,
  "hasPrev": false
}
```

**Building blocks other features call:**

```ts
// src/shared/errors  — throw meaning, not HTTP
new ValidationError(message, { code?, details?, cause? });   // → 400
new NotFoundError(message, { code?, details?, cause? });     // → 404
new ConflictError(message, { code?, details?, cause? });     // → 409
new UnauthorizedError(message?, { code?, details?, cause? }); // → 401
new ForbiddenError(message?, { code?, details?, cause? });   // → 403
new InternalError(message?, { code?, details?, cause? });    // → 500, isOperational = false

// src/shared/pagination  — framework-free page math
function normalizePageQuery(input: PageQueryInput): PageQuery; // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
function createPage<T>(items: T[], total: number, query: PageQuery): Page<T>;

// src/presentation/http/schemas  — Zod response contracts
function paginated<Item extends z.ZodType>(item: Item): z.ZodObject; // page envelope
const timestamp: z.ZodDate;                                          // date field
const errorResponse: z.ZodObject;                                    // the error envelope
```

## Configuration

`src/config/env.ts` parses and validates the whole process environment once, via **`envalid`**
(`cleanEnv`), and exports a typed frozen `env`. This is the app-wide configuration surface; the table
below is the full set, with the variables this HTTP-infrastructure feature reads directly marked
**bold**. Feature-specific groups are cross-linked to their owning docs. Defaults are copied verbatim;
`—` means the variable is **required** (no default, boot fails if unset). `devDefault` values apply
only outside production.

| Variable                | Default                                   | Meaning                                                                                                                      |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | `development`                             | Environment; one of `development`, `test`, `production`. Drives `env.isProduction` / `env.isDevelopment`.                    |
| `HOST`                  | `0.0.0.0`                                 | Bind address for `app.listen` (used in `main.ts`).                                                                           |
| `PORT`                  | `8000`                                    | Listen port (used in `main.ts`).                                                                                             |
| **`LOG_LEVEL`**         | `info`                                    | Fastify/Pino level; one of `fatal`,`error`,`warn`,`info`,`debug`,`trace`. See [Structured Logging](./structured-logging.md). |
| `DATABASE_URL`          | `—`                                       | Prisma connection string (required).                                                                                         |
| `JWT_ACCESS_SECRET`     | `—`                                       | Access-token signing secret (required). See [Authentication](./authentication.md).                                           |
| `JWT_ISSUER`            | `finflow`                                 | JWT `iss` claim. See [Authentication](./authentication.md).                                                                  |
| `JWT_AUDIENCE`          | `finflow-api`                             | JWT `aud` claim. See [Authentication](./authentication.md).                                                                  |
| `ACCESS_TOKEN_TTL`      | `900`                                     | Access-token lifetime in seconds (15 min). See [Authentication](./authentication.md).                                        |
| **`REFRESH_TOKEN_TTL`** | `1209600`                                 | Refresh-token lifetime in seconds (14 days); also the refresh-cookie `Max-Age`.                                              |
| **`COOKIE_SECRET`**     | `''` (empty)                              | When non-empty, cookies are signed; passed to `@fastify/cookie` in `buildApp`.                                               |
| **`WEB_ORIGIN`**        | `—` (devDefault `http://127.0.0.1:3000`)  | Allowed CORS origin; passed to `@fastify/cors` with `credentials: true`.                                                     |
| **`COOKIE_SECURE`**     | `true` (devDefault `false`)               | Sets the `Secure` flag on the refresh cookie.                                                                                |
| `BOOTSTRAP_ADMIN_EMAIL` | `''` (empty)                              | Email of the admin seeded at bootstrap. See [Role-Based Authorization](./role-based-authorization.md).                       |
| **`RATE_LIMIT_MAX`**    | `100`                                     | Global rate-limit ceiling per window; passed to `@fastify/rate-limit`.                                                       |
| **`RATE_LIMIT_WINDOW`** | `1 minute`                                | Global rate-limit window; passed to `@fastify/rate-limit`.                                                                   |
| `RATE_LIMIT_AUTH_MAX`   | `5`                                       | Stricter per-route ceiling for auth endpoints. See [Authentication](./authentication.md).                                    |
| `REDIS_URL`             | `—` (devDefault `redis://127.0.0.1:6379`) | Redis connection for BullMQ.                                                                                                 |
| `QUEUE_PREFIX`          | `finflow`                                 | BullMQ key prefix.                                                                                                           |
| `QUEUE_CONCURRENCY`     | `5`                                       | BullMQ worker concurrency.                                                                                                   |

`buildApp` itself takes three code-level options, not env vars: `logLevel` (string), the optional
`disableRequestLogging` (default `false`), and the optional `rateLimit` (default `true`, disabled by
tests). `main.ts` supplies `logLevel: env.LOG_LEVEL` and `disableRequestLogging: env.isDevelopment`.

**Security defaults** derive from the environment rather than dedicated flags:

- `helmetOptions(env.isProduction)` returns `{}` in production (helmet's full defaults, **CSP on**)
  and `{ contentSecurityPolicy: false }` elsewhere — CSP is deliberately relaxed outside production so
  the Swagger UI at `/docs` loads.
- `rateLimitOptions` wires the limiter to emit a `FastifyError` with `code: 'RATE_LIMITED'` and the
  window's `statusCode`, so a throttled request flows through the same error envelope as everything
  else.

## Usage & extension

**Throw a semantic error from any inner layer — it becomes the right HTTP response automatically.**
No `try/catch`, no status code, no `reply` in the use case:

```ts
import { ConflictError } from '@/shared/errors';

// inside a use case (application layer)
if (await this.users.existsByEmail(email)) {
  throw new ConflictError('Email already registered', {
    code: 'EMAIL_TAKEN',
    details: { email },
  });
}
// → HTTP 409
// { "error": { "code": "EMAIL_TAKEN", "message": "Email already registered",
//              "details": { "email": "…" }, "requestId": "…" } }
```

**Add a brand-new error kind** (only when none of the six existing kinds fits — usually one of them
does). Three edits keep the mapping total and type-safe:

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
stripped. Compose `paginated`, `timestamp`, and `errorResponse` (this is exactly what
`src/presentation/http/schemas/user-response-schema.ts` and `user-routes.ts` do):

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

## Design decisions & trade-offs

- **One centralized error handler over per-route `try/catch`.** A single `setErrorHandler` owns the
  entire kind→status→envelope translation, so no route ever writes a status code for an error and the
  wire shape can never drift between endpoints. The alternative — HTTP-aware errors or `try/catch` in
  each use case — would scatter status codes across the application layer and duplicate the envelope.
  The cost is one indirection: to see why a thrown error became a given status you read
  `error-handler.ts`, not the throw site.
- **A semantic `AppError` hierarchy in `src/shared`, framework-free.** Inner layers throw meaning
  (`NotFoundError`, `ConflictError`) carrying a `kind`, a machine `code`, and optional `details`;
  `kind` decides the status, `code`/`message`/`details` fill the body. Because these types import no
  framework, an application use case constructs them without violating the Dependency Rule, and the
  presentation layer is the sole place they turn into HTTP.
- **`isOperational` splits expected failures from bugs.** Semantic errors are operational (logged at
  `info`); only `InternalError` is non-operational (logged at `error`), and any unknown throw is
  treated as a bug and answered with a generic `500` message. This keeps log severity meaningful and
  guarantees internal detail is never serialized to a client.
- **Zod serializer compilers to enforce response contracts.** Declaring a `response` schema makes the
  outgoing JSON validated and **whitelisted** to exactly the declared fields, turning
  "don't forget to omit the password hash" from a discipline into a guarantee (proved by
  `pagination-schema.test.ts`, which asserts unknown item fields are stripped). It doubles as the
  OpenAPI source of truth. The trade-off: every response needs a schema, and a too-loose schema
  weakens the guarantee — the enforcement is only as tight as the contract you write.
- **Shared, framework-free pagination (`normalizePageQuery` / `createPage`).** Request clamping
  (page ≥ 1, `pageSize` ≤ 100) and metadata math (`hasNext`/`hasPrev`) live once in `src/shared`, used
  by both use cases and the `paginated()` response schema, so every list endpoint paginates
  identically and a hostile `pageSize=100000` is bounded server-side.
- **Secure-by-default middleware, environment-aware.** helmet, a `WEB_ORIGIN`-pinned CORS allowlist
  with `credentials: true` (required for the refresh cookie), and a global rate limit are all on
  unless explicitly relaxed. Two relaxations are deliberate and code-visible: CSP is disabled outside
  production so Swagger UI works, and Swagger itself is registered only when `!env.isProduction`.
- **Registration order is load-bearing.** Awilix is registered before the auth plugin and routes
  (which resolve from `request.diScope.cradle`); the correlation-id plugin runs early so every
  downstream log line and error body carries the id; and the error handler is registered before routes
  so it wraps all of them. Reordering these would silently break DI resolution, correlation, or error
  coverage.
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
  headers, a `429` in the `RATE_LIMITED` envelope once the global limit trips, and that a per-route
  bucket enforces a stricter limit independently.
- `src/presentation/http/cookies.test.ts` — exercises `setRefreshCookie` / `clearRefreshCookie` /
  `readRefreshCookie` for `HttpOnly`, `SameSite=Strict`, `Path=/auth`, `Max-Age`, the `Secure` flag,
  and signed-vs-unsigned behaviour including rejection of a tampered signature.
- `src/presentation/http/schemas/pagination-schema.test.ts` — asserts `paginated()` validates a
  well-formed envelope and **strips unknown fields** from items.
- `src/shared/errors/app-error.test.ts` — covers the `AppError` base: `instanceof Error`, subclass
  `name`, `kind`/`code`/`message`, `isOperational` default and override, `details`, `timestamp`,
  `cause`, and `toJSON()` (including omission of absent `details`).
- `src/shared/errors/semantic-errors.test.ts` — for each subclass, asserts its `kind`, default and
  custom `code`, default message, and `isOperational` (true for all except `InternalError`).
- `src/shared/pagination.test.ts` — covers `normalizePageQuery` clamping/truncation/defaults and
  `createPage`'s `hasNext`/`hasPrev` metadata, including the empty and exactly-one-full-page cases.

Run the whole suite:

```bash
npm test
```

Run only this feature's tests:

```bash
npx vitest run src/presentation/http src/shared/errors src/shared/pagination.test.ts
```
