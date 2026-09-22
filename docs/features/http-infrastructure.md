# HTTP Infrastructure

> **Status:** Complete · **Layers:** presentation, infrastructure, composition root, shared, config · **Verified against:** `7150871`

**Contents** — [Purpose](#purpose) · [How it works](#how-it-works)
([guards](#boot-time-configuration-guards), [container](#the-container-arrives-already-wired),
[instance](#instance-configuration), [order](#plugin-registration-order),
[versioning](#api-versioning), [happy path](#a-requests-happy-path),
[failures](#the-failure-paths-that-matter)) · [Architecture](#architecture) ·
[Public surface](#public-surface) ([bootstrap](#bootstrap-api),
[mounts](#operational-mounts-this-feature-owns), [URLs](#url-layout),
[plugin options](#plugin-option-contracts), [error envelope](#error-response-envelope),
[pagination](#pagination-envelope), [shared blocks](#shared-building-blocks),
[decorators](#route-decorators-config-flags-and-identity-helpers)) ·
[Configuration](#configuration) ([this feature](#read-by-this-feature),
[siblings](#read-by-sibling-features), [code-level](#code-level-options),
[security defaults](#derived-security-defaults),
[trusted proxies](#trusted-proxies-and-the-rate-limiter-bucket-key),
[raw limits](#limits-that-bypass-the-error-envelope)) ·
[Usage & extension](#usage--extension) ([run](#build-and-run-an-app),
[test overrides](#swap-a-dependency-in-a-test),
[throw an error](#throw-a-semantic-error-from-an-inner-layer),
[new error kind](#add-a-new-error-kind), [new plugin](#add-a-cross-cutting-plugin),
[new router](#mount-a-new-v1-resource-router),
[response contract](#declare-a-response-contract-on-a-route),
[pages](#return-a-page-from-a-use-case), [protect a route](#protect-a-route),
[route config](#tighten-per-route-policy-through-route-config)) ·
[Design decisions](#design-decisions--trade-offs) · [Testing](#testing)

## Purpose

Every feature that speaks HTTP — user CRUD, authentication, authorization, health checks, metrics —
sits on one shared application factory and one shared set of request/response conventions. This
feature is that foundation. `buildApp` assembles the Fastify application **around a dependency
container handed to it**, fixes the order in which cross-cutting plugins run, and mounts the
versioned `/v1` API surface. It also defines how requests are validated, how responses are shaped,
and how **every** error becomes a uniform JSON envelope with the right HTTP status.

Its reason to exist is the Dependency Rule. HTTP concerns — status codes, headers, response shapes,
security policy, URL versioning — must live at the presentation boundary and nowhere else. That is
what lets the domain and application layers throw meaningful errors and return plain objects without
importing Fastify or knowing what a `409` is.

## How it works

`buildApp(options)` in `src/presentation/http/app.ts` constructs and returns a configured Fastify
instance. It does **not** call `listen`, and it does **not** build its own dependency graph — both
are the entry point's job. `src/main.ts` owns the lifecycle: it imports `./instrumentation` first
(tracing bootstrap, see [Tracing](./tracing.md)), builds the container, calls `buildApp`, hands
teardown to [Graceful Shutdown](./graceful-shutdown.md) via `registerGracefulShutdown`, and listens
on `env.HOST` / `env.PORT`:

```ts
const container = createAppContainer(createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env)));
const app = await buildApp({ container, disableRequestLogging: env.isDevelopment });

registerGracefulShutdown({
  logger: app.log,
  dispose: () => app.close(),
  flushTelemetry: shutdownTracing,
});

await app.listen({ host: env.HOST, port: env.PORT }); // main.ts logs the error and exits 1 on failure
```

### Boot-time configuration guards

Importing `src/config/env.ts` parses the whole process environment once through **`envalid`**
(`cleanEnv`) into a typed, frozen `env`, then calls `assertProductionSecrets(env)`. That boot-time
guard is a no-op outside production; in production it throws if any key in `PRODUCTION_SECRET_KEYS` —
`COOKIE_SECRET`, `JWT_ACCESS_SECRET`, `VERIFICATION_CODE_SECRET` — is shorter than
`MIN_SECRET_LENGTH` (32) characters, or — only when `BULL_BOARD_ENABLED` is true — if
`BULL_BOARD_PASSWORD` is shorter than 16. It collects **all** offending keys into one error naming
them with a remediation hint (`openssl rand -base64 48`).

A second boot-time guard sits beside it: importing `src/config/http-transport.ts` runs
`parseTrustProxy(env.TRUST_PROXY)`, which throws on any value outside the grammar
`false | true | <address list>`. The two fire at different import times, so there is no single locatable
guard point — but both run before either entry point calls `listen()`, because `app.ts` and
`worker.ts` each import `http-transport` at module load. A malformed `TRUST_PROXY` fails the boot
rather than surfacing as a request-time surprise.

### The container arrives already wired

`src/container.ts` exports one function that both creates and populates the container, using the
options leaf `src/container-options.ts` — the single definition of how every container here behaves:

```ts
// src/container.ts
export function createAppContainer(baseLogger: FastifyBaseLogger): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>(APP_CONTAINER_OPTIONS);
  container.register(createRegistrations(baseLogger));
  return container;
}

// src/container-options.ts
export const APP_CONTAINER_OPTIONS = {
  injectionMode: InjectionMode.PROXY,
  strict: true,
} as const satisfies ContainerOptions;
```

`createRegistrations(baseLogger)` (`src/composition/compose.ts`) merges the thirteen per-module
registration maps under `src/composition/**` into one `CompleteRegistrations` object, so the
container is complete on return — no observable half-wired state, no second call to remember. Three
entry points build one this way (`src/main.ts`, `src/worker.ts`, `src/scripts/sync-auth.ts`), as does
every test that needs a real graph, and each call gets its **own** container, which is what
`src/container.test.ts` pins.

Two Awilix terms recur below. The **cradle** is a container's resolved-dependency proxy: reading
`container.cradle.foo` resolves the registration named `foo`, and its transitive dependencies, on
that property access. **`request.diScope`** is the per-request child container `@fastify/awilix`
creates on every `onRequest` and disposes when the response is sent; `request.diScope.cradle` is that
child's proxy, and it is where route handlers and request-scoped hooks resolve their collaborators.

`baseLogger` is a cradle key of its own, registered in `src/composition/platform.ts` as
`baseLogger: asValue(baseLogger)` alongside the application-layer `logger` port that wraps it
(`new PinoLogger(baseLogger, new RequestContextProvider())`). Both descend from the one root Pino
instance the entry point created, so `buildApp` is never handed the logger a second time — it reads
`container.cradle.baseLogger`.

Because the container is complete before `buildApp` is called, every cradle read inside `buildApp` is
valid from its first line; the factory carries no internal "wire here, read below" constraint.
`buildApp` reads exactly five keys at composition time, three of them only inside the branch that
needs them:

| Cradle key        | Read where                           | Passed to                                    |
| ----------------- | ------------------------------------ | -------------------------------------------- |
| `baseLogger`      | the `fastify()` factory call         | Fastify's `loggerInstance`                   |
| `metricsRecorder` | inside `if (env.METRICS_ENABLED)`    | `metricsPlugin`'s `MetricsPluginOptions`     |
| `dashboardQueue`  | inside `if (env.BULL_BOARD_ENABLED)` | `bullBoardPlugin`'s `BullBoardPluginOptions` |
| `rateLimitRedis`  | inside `if (rateLimit)`              | `@fastify/rate-limit`'s `redis` option       |
| `healthCheck`     | the `healthRoutes` registration      | `healthRoutes`' `HealthRoutesOptions`        |

The branch placement is load-bearing. The PROXY cradle resolves lazily on property access, and both
`rateLimitRedis` and `dashboardQueue` **open live connections when resolved** (`createRateLimitRedis`
constructs an `ioredis` client; `createDashboardQueue` constructs a BullMQ `Queue`, which pulls in the
`redisConnection` singleton and its socket). Reading them inside their gates means a process with
`BULL_BOARD_ENABLED=false`, or a test built with `rateLimit: false`, never opens a socket it will not
use.

Everything else resolves **per request** from `request.diScope.cradle`. The plugin also decorates the
instance with `app.diContainer`, pointing at the container that was passed in; the integration suite
under `test/integration/**` uses it to reach the root cradle (for example to read the limiter's Redis
handle back), and no file under `src/` reads it.

### Instance configuration

```ts
const app = fastify({
  loggerInstance: container.cradle.baseLogger,
  requestIdHeader: CORRELATION_ID_HEADER,
  genReqId: () => randomUUID(),
  forceCloseConnections: true,
  ...httpHardeningOptions({ ...httpLimits, trustProxy }),
  logController: new LogController({
    disableRequestLogging,
  }),
});
```

`loggerInstance` is the already-constructed root Pino logger, carrying the level and service identity
(name, environment, version) that `createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))` stamped
on it. `requestIdHeader: CORRELATION_ID_HEADER` (`'x-request-id'`) with `genReqId: () => randomUUID()`
gives every request an id taken from the client's header or freshly minted; that id becomes the
correlation id in logs and the `requestId` in every error body. `forceCloseConnections: true`
supports clean shutdown.

`LogController` is Fastify 5's replacement for the deprecated top-level `disableRequestLogging`
option: suppression is configured by handing the factory a controller object, and the top-level form
warns at runtime and is removed in Fastify 6. The boolean passed into it is
`BuildAppOptions.disableRequestLogging`, destructured with a `false` default and set to
`env.isDevelopment` by `main.ts`.

The five **transport limits** spread in from `httpHardeningOptions({ ...httpLimits, trustProxy })`.
`httpHardeningOptions` (`src/presentation/http/server-options.ts`) is a pure, total projection of
consumer vocabulary onto Fastify's option names; the values come from `src/config/http-transport.ts`,
the single owner of the environment-to-consumer mapping, so neither this server nor the worker's probe
server repeats it:

| Fastify option                 | From                    | Default   | Why it is set explicitly                                                                                                                                                                                   |
| ------------------------------ | ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trustProxy`                   | `TRUST_PROXY`           | `false`   | Decides whether `request.ip` — and so the limiter's bucket key — may come from `X-Forwarded-For`. See [Trusted proxies](#trusted-proxies-and-the-rate-limiter-bucket-key).                                 |
| `bodyLimit`                    | `BODY_LIMIT_BYTES`      | `1048576` | Fastify's own default, made explicit so it is tunable without a code change. Exceeding it yields `413` through the normal error envelope.                                                                  |
| `requestTimeout`               | `REQUEST_TIMEOUT_MS`    | `30000`   | The one changed default (Fastify ships `0`). Bounds the slow-POST / RUDY (R-U-Dead-Yet) shape, where a client sends headers then trickles a body forever. See [the caveat](#design-decisions--trade-offs). |
| `keepAliveTimeout`             | `KEEP_ALIVE_TIMEOUT_MS` | `72000`   | Fastify's own default, chosen to sit above the common 60 s load-balancer idle timeout.                                                                                                                     |
| `routerOptions.maxParamLength` | `MAX_PARAM_LENGTH`      | `100`     | Fastify's own default. An over-long route parameter yields a raw `414`.                                                                                                                                    |

`maxParamLength` **must** be nested under `routerOptions`. As a top-level option it is deprecated in
Fastify 5 (`FSTDEP022`, removed in Fastify 6) and warns on every `fastify()` call — including every
boot and test run. TypeScript does not catch it: the `.d.ts` carries no `@deprecated` tag, so
`typecheck` and `lint` stay green while the process warns. Routing `disableRequestLogging` through
`LogController` avoids the same trap.

### Plugin registration order

Fastify **encapsulates** every plugin passed to `app.register`: the plugin function runs against a
_child_ of the instance, and every hook or decorator it adds is scoped to that child — a fresh
**encapsulation context**, a private branch of the instance tree whose additions are visible to
routes registered _inside_ that plugin and nothing else. Registering at the root does not change
this: a plain `app.register(async (app) => app.addHook('onRequest', …))` is accepted without error
and its hook never fires for any other route.

The escape hatch is **`fastify-plugin`** (imported as `fp`). Wrapping a plugin in `fp(...)` skips the
child context, so its hooks and decorators attach to the parent instance and are visible to
everything registered after it. That is why every first-party cross-cutting plugin here is an `fp`
wrapper: `correlationIdPlugin` (`plugins/correlation-id.ts`), `metricsPlugin` (`plugins/metrics.ts`,
typed `fp<MetricsPluginOptions>`), `authPlugin` (`plugins/authenticate.ts`), and `idempotencyPlugin`
(`plugins/idempotency.ts`). The `@fastify/*` plugins ship their own `fp` wrapper for the same reason,
which is how `reply.unauthorized`, `request.diScope`, `request.cookies` and the helmet/CORS/rate-limit
hooks reach the whole app. The one deliberate exception is **`bullBoardPlugin`** — a plain
`export async function` with no `fp()`, so it stays encapsulated on purpose, which is exactly why its
Basic-Auth `onRequest` hook and strict-CSP `onSend` hook apply to the dashboard mount and nothing
else.

Two consequences make registration order load-bearing: hooks run in the order the plugins that added
them were registered, and a hook or decorator only reaches routes registered _after_ it. This is the
order `buildApp` uses, with each option object elided:

```ts
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

await app.register(fastifySensible);
await app.register(fastifyHelmet /* helmetOptions */);
await app.register(fastifyAwilixPlugin /* container + dispose flags */);
await app.register(correlationIdPlugin);
if (env.METRICS_ENABLED) await app.register(metricsPlugin /* metricsRecorder */);
await app.register(fastifyCors /* origin + credentials */);
await app.register(fastifyCookie /* secret when set */);
await app.register(authPlugin);
await app.register(idempotencyPlugin);

registerErrorHandler(app);

if (!env.isProduction) {
  await app.register(fastifySwagger /* openapi + jsonSchemaTransform */);
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
}
if (env.BULL_BOARD_ENABLED) await app.register(bullBoardPlugin /* dashboardQueue */);
if (rateLimit) await app.register(fastifyRateLimit /* rateLimitOptions + redis */);

await app.register(healthRoutes /* prefix + healthCheck */);
if (env.METRICS_ENABLED) await app.register(metricsRoutes, { prefix: '/metrics' });
await app.register(apiV1Routes, { prefix: API_V1_PREFIX });
```

What fixes each position:

| #   | Registered                                                                         | Constraint on its position                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Zod validator + serializer compilers (**`fastify-type-provider-zod`**)             | Before routes — a route picks up the compilers in force when it is added                                                                                                                   |
| 2   | **`@fastify/sensible`**                                                            | Before any route or plugin that calls a decorator such as `reply.unauthorized(...)`; nothing else constrains it                                                                            |
| 3   | **`@fastify/helmet`** with `helmetOptions(env.isProduction)`                       | Before routes, so its header hook covers every response                                                                                                                                    |
| 4   | **`@fastify/awilix`** with the injected container                                  | Before everything that resolves from `request.diScope.cradle` — its `onRequest` hook is what creates that scope                                                                            |
| 5   | `correlationIdPlugin`                                                              | First among hook-adding first-party plugins, so the id is in context for every later hook, handler, log line, and error body ([Structured Logging](./structured-logging.md))               |
| 6   | `metricsPlugin` — only when `env.METRICS_ENABLED`                                  | Before routes, or responses of earlier routes go unobserved ([Metrics](./metrics.md))                                                                                                      |
| 7   | **`@fastify/cors`** with `{ origin: env.WEB_ORIGIN, credentials: true }`           | Before routes, so preflight handling and headers cover every route                                                                                                                         |
| 8   | **`@fastify/cookie`** (`{ secret: env.COOKIE_SECRET }` when set, else `{}`)        | Before the auth routes that read and write the refresh cookie — in practice, before routes                                                                                                 |
| 9   | `authPlugin`                                                                       | Before any route plugin referencing `app.authenticate`, or that reference is `undefined` at registration; also after `@fastify/awilix` ([Authentication](./authentication.md))             |
| 10  | `idempotencyPlugin`                                                                | Before routes so its `preHandler`/`onSend` hooks wrap opted-in routes; its `preHandler` runs after validation, so the fingerprint hashes the parsed body ([Idempotency](./idempotency.md)) |
| 11  | `registerErrorHandler(app)`                                                        | Before the routes whose throws it should catch — anything registered after it is covered, anything before is not                                                                           |
| 12  | **`@fastify/swagger`** + **`@fastify/swagger-ui`** — only when `!env.isProduction` | Before the routes it documents (it harvests schemas via `onRoute`), or `/docs` renders an empty spec; `swagger-ui` must follow `swagger`                                                   |
| 13  | `bullBoardPlugin` — only when `env.BULL_BOARD_ENABLED`                             | Deliberately before the limiter, so the dashboard sits outside the API quota ([Background Jobs](./background-jobs.md))                                                                     |
| 14  | **`@fastify/rate-limit`** — only when `rateLimit` (default `true`)                 | Before the routes it should limit — the boundary that puts the three routers inside the quota and Bull Board outside it                                                                    |
| 15  | `healthRoutes`, `metricsRoutes`, `apiV1Routes`                                     | Last, because everything above only reaches routes registered after it                                                                                                                     |

Three positions carry a non-obvious detail. **Step 4** passes no `injectionMode`: supplying it
alongside `container` makes the plugin refuse to register ("If you are passing pre-created container
explicitly, you cannot specify injection mode"), which rejects the `await app.register(...)` and fails
the boot — the injection mode lives in `APP_CONTAINER_OPTIONS`. **Step 9** registers a _decorator_,
not a global hook, so it does nothing until a route group wires it (`userRoutes` opens with
`app.addHook('onRequest', app.authenticate)`). **Step 15** mounts `healthRoutes` under `/health` with
`container.cradle.healthCheck`, `metricsRoutes` under `/metrics` when `env.METRICS_ENABLED`, and
`apiV1Routes` under `API_V1_PREFIX`; both operational routers opt out of the limiter in their own
`onRoute` hook (`route.config = { ...route.config, rateLimit: false }`), so a kubelet polling
`/health/live` can never be throttled.

### API versioning

The whole business API lives under one URL version prefix. `API_V1_PREFIX` (`'/v1'`, in
`src/presentation/http/api-version.ts`) is the single constant naming the current generation;
`buildApp` registers `apiV1Routes` under it, and `apiV1Routes`
(`src/presentation/http/routes/api-v1-routes.ts`) mounts each resource router under its own
sub-prefix: `authRoutes` at `/auth`, `userRoutes` at `/users`, `roleRoutes` at `/roles`,
`permissionRoutes` at `/permissions` — so clients call `/v1/auth/login`, `/v1/users`, and so on.
Operational endpoints — `/health`, `/metrics`, `/docs`, the Bull Board dashboard — stay
**unversioned**: they address orchestrators and operators, not API clients. `cookies.ts` also consumes
the constant, scoping the refresh cookie to `` `${API_V1_PREFIX}/auth` `` so the cookie path tracks
the version prefix automatically.

### A request's happy path

Fastify assigns `request.id` → `onRequest` hooks run (the Awilix scope is created as
`request.diScope`; the correlation id is set and the `x-request-id` header echoed; for protected route
groups `authenticate` verifies the bearer token) → the body is parsed and the Zod **validator
compiler** checks `querystring` / `params` / `body` → `preHandler` hooks run (idempotency claim/replay
on opted-in routes) → the handler resolves its use case from `request.diScope.cradle` and calls
`execute()` → `reply.send(payload)` runs the payload through the Zod **serializer compiler**, which
validates it against the declared `response` schema and strips undeclared fields → `onSend` hooks run
(idempotency stores or releases the key) → the `onResponse` hook (when metrics are enabled) records
method, matched route template, status, and duration, and the request scope is disposed.

### The failure paths that matter

Every failure funnels through `registerErrorHandler`'s single `setErrorHandler`
(`src/presentation/http/error-handler.ts`), which maps a thrown **`AppError`** through
`KIND_TO_STATUS`, a Fastify `error.validation` to `400`/`VALIDATION`, any other error carrying a 4xx
`statusCode` to that status, and anything else to `500`. The full mapping is tabulated under
[Error-response envelope](#error-response-envelope). Operational errors log at `info`, non-operational
at `error`, and the `500` body carries the generic message `Internal Server Error` so internal detail
never leaks. An unmatched route is caught by `setNotFoundHandler` → `404` with code `ROUTE_NOT_FOUND`
and message `Route <METHOD> <URL> not found`; because the resource routers exist only under `/v1`, an
unversioned call like `GET /users` lands here.

## Architecture

This feature is not port/adapter-shaped like the others. It is the **HTTP application factory**, the
**composition-root entry** that feeds it, the one **infrastructure** adapter the boundary owns (the
limiter's Redis handle), and the framework-free **shared** vocabulary (`src/shared/errors`,
`src/shared/pagination`) that both the boundary and the inner layers speak. Inner layers throw
**semantic `AppError`s** — framework-free classes naming the _kind_ of failure (`NotFoundError`,
`ConflictError`, …) rather than an HTTP status — and return plain DTOs / `Page` objects with no HTTP
knowledge. The presentation layer is the **only** place that translates that vocabulary into HTTP:
status codes in `error-handler.ts`, wire shapes in the Zod schemas, security policy in `security.ts`,
URL versioning in `api-version.ts`. The shared error and pagination types carry no framework imports,
which is why an application use case may construct them without breaching the Dependency Rule.

The concretes the HTTP layer needs are **pushed in, never pulled**. `src/container.ts` is the only
place binding concretes to ports, and nothing under
`src/{domain,shared,application,infrastructure,presentation,config}/` may import it — the
dependency-cruiser rule `container-is-not-importable` enforces that with no exemptions. Entry points
build the container and hand it to `buildApp`, which resolves what its plugins need and passes each as
a plugin option (`MetricsPluginOptions`, `BullBoardPluginOptions`, `HealthRoutesOptions`, the
limiter's `redis`). Only two things resolve by name at runtime, both from the **request scope**: the
`authenticate` decorator (`accessTokenService`) and the idempotency hooks (`idempotencyStore`), plus
every route handler reaching for its use case in `request.diScope.cradle`.

| Component                                                       | Layer            | Responsibility                                                                                                                                                                             | File                                                         |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `buildApp` / `BuildAppOptions`                                  | Presentation     | HTTP application factory: configures Fastify from the injected container, registers plugins in order, mounts routes                                                                        | `src/presentation/http/app.ts`                               |
| `createAppContainer`                                            | Composition root | Creates **and** populates one Awilix container from a base logger; the only sanctioned way to build the graph                                                                              | `src/container.ts`                                           |
| `APP_CONTAINER_OPTIONS`                                         | Composition root | The shared `ContainerOptions` leaf (`InjectionMode.PROXY`, `strict: true`) used by production and the unit-test kit alike                                                                  | `src/container-options.ts`                                   |
| `baseLogger` cradle registration                                | Composition root | Puts Fastify's root `FastifyBaseLogger` in the cradle beside the `Logger` port that wraps it                                                                                               | `src/composition/platform.ts`                                |
| `createRateLimitRedis`                                          | Infrastructure   | Builds the limiter's dedicated `ioredis` client (tight connect/command timeouts, no offline queue); registered as the `rateLimitRedis` singleton with a `disconnect` disposer              | `src/infrastructure/security/rate-limit-redis.ts`            |
| `buildHealthApp`                                                | Presentation     | The worker's minimal probe server — Fastify + the Zod compilers + `/health` and (when enabled) `/metrics`, skipping the whole cross-cutting chain. See [Health Checks](./health-checks.md) | `src/presentation/http/health-app.ts`                        |
| `API_V1_PREFIX`                                                 | Presentation     | The single constant naming the current API URL version (`/v1`)                                                                                                                             | `src/presentation/http/api-version.ts`                       |
| `apiV1Routes`                                                   | Presentation     | Mounts the v1 resource routers (`/auth`, `/users`, `/roles`, `/permissions`) under the version prefix                                                                                      | `src/presentation/http/routes/api-v1-routes.ts`              |
| `registerErrorHandler`                                          | Presentation     | Single `setErrorHandler` + `setNotFoundHandler`; maps every error to the JSON envelope                                                                                                     | `src/presentation/http/error-handler.ts`                     |
| `KIND_TO_STATUS`                                                | Presentation     | Maps each `ErrorKindType` to its HTTP status code                                                                                                                                          | `src/presentation/http/error-handler.ts`                     |
| `helmetOptions` / `rateLimitOptions`                            | Presentation     | The helmet CSP toggle, and the limiter's `max`, `timeWindow`, `skipOnError`, Redis `nameSpace`, and `errorResponseBuilder`; the Redis handle is spread in by `buildApp`                    | `src/presentation/http/security.ts`                          |
| `httpHardeningOptions`                                          | Presentation     | Pure projection of the five transport limits onto Fastify's option names, nesting `maxParamLength` under `routerOptions`; used by `buildApp` and `buildHealthApp`                          | `src/presentation/http/server-options.ts`                    |
| `errorResponse`                                                 | Presentation     | Zod response contract routes declare for error statuses                                                                                                                                    | `src/presentation/http/schemas/error-schema.ts`              |
| `paginated`                                                     | Presentation     | Zod response-contract factory wrapping a page of items                                                                                                                                     | `src/presentation/http/schemas/pagination-schema.ts`         |
| `timestamp`                                                     | Presentation     | Zod response contract for date fields (`z.date()`)                                                                                                                                         | `src/presentation/http/schemas/timestamp-schema.ts`          |
| `correlationIdPlugin`                                           | Presentation     | Per-request correlation id (see [Structured Logging](./structured-logging.md))                                                                                                             | `src/presentation/http/plugins/correlation-id.ts`            |
| `metricsPlugin` / `MetricsPluginOptions`                        | Presentation     | `onResponse` hook recording HTTP metrics through an injected `MetricsRecorder` (see [Metrics](./metrics.md))                                                                               | `src/presentation/http/plugins/metrics.ts`                   |
| `authPlugin`                                                    | Presentation     | `authenticate` decorator for bearer auth (see [Authentication](./authentication.md))                                                                                                       | `src/presentation/http/plugins/authenticate.ts`              |
| `idempotencyPlugin`                                             | Presentation     | `preHandler`/`onSend` hooks replaying or storing responses for opted-in routes (see [Idempotency](./idempotency.md))                                                                       | `src/presentation/http/plugins/idempotency.ts`               |
| `bullBoardPlugin` / `BullBoardPluginOptions`                    | Presentation     | Basic-auth-guarded Bull Board mount over an injected `Queue`; the only cross-cutting plugin left encapsulated (see [Background Jobs](./background-jobs.md))                                | `src/presentation/http/plugins/bull-board.ts`                |
| `toRequestActor`                                                | Presentation     | Maps `request.user` to the domain `Actor` a use case authorizes against (see [Role-Based Authorization](./role-based-authorization.md))                                                    | `src/presentation/http/identity/actor-from-token-payload.ts` |
| `setRefreshCookie` / `readRefreshCookie` / `clearRefreshCookie` | Presentation     | Read/write the signed refresh-token cookie, scoped to `/v1/auth` (see [Authentication](./authentication.md))                                                                               | `src/presentation/http/cookies.ts`                           |
| `AppError`                                                      | Shared           | Abstract base error carrying `kind`, `code`, `details`, `isOperational`, `timestamp`, `toJSON()`                                                                                           | `src/shared/errors/app-error.ts`                             |
| `ErrorKind`                                                     | Shared           | The closed set of error kinds (`VALIDATION`…`INTERNAL`)                                                                                                                                    | `src/shared/errors/app-error.ts`                             |
| `ValidationError` … `InternalError`                             | Shared           | The semantic `AppError` subclasses inner layers throw                                                                                                                                      | `src/shared/errors/semantic-errors.ts`                       |
| `normalizePageQuery` / `createPage`                             | Shared           | Framework-free pagination: clamp request input, compute page metadata                                                                                                                      | `src/shared/pagination.ts`                                   |
| `Page` / `PageQuery` / `PageSlice`                              | Shared           | Pagination types shared by use cases, repositories, and response schemas                                                                                                                   | `src/shared/pagination.ts`                                   |
| `env`                                                           | Config           | Parse + validate the whole environment once at boot (`envalid`), exported frozen                                                                                                           | `src/config/env.ts`                                          |
| `assertProductionSecrets`                                       | Config           | Boot-time guard: refuse to start when a production secret is weak                                                                                                                          | `src/config/assert-production-secrets.ts`                    |
| `parseTrustProxy`                                               | Config           | Boot-time guard and parser for the `TRUST_PROXY` grammar; rejects hop counts, which Fastify no longer honours                                                                              | `src/config/trust-proxy.ts`                                  |
| `trustProxy` / `httpLimits`                                     | Config           | Derived transport configuration read once from `env`; the single owner of the environment-to-consumer mapping for both servers                                                             | `src/config/http-transport.ts`                               |
| `toServiceIdentity`                                             | Config           | Derive `{ service, environment, version }` for logs/traces from env                                                                                                                        | `src/config/service-identity.ts`                             |

## Public surface

Clients program against the **URL layout**, the **error envelope**, and the **pagination envelope**.
Engineers program against the **factories**, the **shared error and pagination building blocks**, the
**Zod response schemas**, and the **route decorators, config flags, and identity helper**.

### Bootstrap API

```ts
// src/container.ts
function createAppContainer(baseLogger: FastifyBaseLogger): AwilixContainer<Cradle>;

// src/container-options.ts
const APP_CONTAINER_OPTIONS: { injectionMode: InjectionMode.PROXY; strict: true };

// src/presentation/http/app.ts
interface BuildAppOptions {
  container: AwilixContainer<Cradle>;
  disableRequestLogging?: boolean; // default false
  rateLimit?: boolean; // default true
}
function buildApp(options: BuildAppOptions): Promise<FastifyInstance>;
```

`container` is **required** and is the only dependency `buildApp` accepts; the other two are
behaviour flags. The returned instance is not listening — the caller decides between `app.listen(...)`
(production) and `app.inject(...)` (tests). Because `fastifyAwilixPlugin` is registered with
`disposeOnClose: true`, `await app.close()` also disposes that container, running every
`.disposer(...)` registered in `src/composition/**` (Redis connections, BullMQ queues, Prisma).

### Operational mounts this feature owns

| Method | Path         | Auth | Gate                |
| ------ | ------------ | ---- | ------------------- |
| `GET`  | `/docs`      | None | `!env.isProduction` |
| `GET`  | `/docs/json` | None | `!env.isProduction` |
| `GET`  | `/docs/yaml` | None | `!env.isProduction` |

`/docs` is the Swagger UI; `/docs/json` and `/docs/yaml` serve the generated OpenAPI document. All
three come from `@fastify/swagger-ui` at `routePrefix: '/docs'` and exist only outside production.
Every other mount belongs to another feature: `/health/live` and `/health/ready` to
[Health Checks](./health-checks.md), `/metrics` to [Metrics](./metrics.md), the dashboard at
`BULL_BOARD_PATH` to [Background Jobs](./background-jobs.md), and the `/v1` routers to the docs under
[URL layout](#url-layout).

### URL layout

Every business endpoint lives under `API_V1_PREFIX` (`/v1`): `/v1/auth/*`, `/v1/users/*`,
`/v1/roles/*`, `/v1/permissions`. The endpoint tables live in the docs that own them
([Authentication](./authentication.md), [User CRUD](./user-crud.md),
[Role-Based Authorization](./role-based-authorization.md)). Operational endpoints are unversioned.

### Plugin option contracts

For anything mounting these plugins directly (the unit tests do):

```ts
interface MetricsPluginOptions {
  metricsRecorder: MetricsRecorder;
} // plugins/metrics.ts
interface BullBoardPluginOptions {
  dashboardQueue: Queue;
} // plugins/bull-board.ts
interface HealthRoutesOptions {
  healthCheck: HealthCheck;
} // routes/health-routes.ts

// src/presentation/http/server-options.ts
interface HttpHardeningInput {
  readonly trustProxy: TrustProxySetting;
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxParamLength: number;
}
function httpHardeningOptions(input: HttpHardeningInput): FastifyHardeningOptions;
```

`FastifyHardeningOptions` is module-internal — declared without `export`, so it is not importable. It
is `Readonly<Required<Pick<FastifyServerOptions, 'trustProxy' | 'bodyLimit' | 'requestTimeout' | 'keepAliveTimeout' | 'routerOptions'>>>`,
which callers spread straight into `fastify(...)` without naming the type.

### Error-response envelope

Every failure — validation, auth, rate limit, unknown crash, unknown route — comes back as
`{ "error": { "code": "EMAIL_TAKEN", "message": "…", "details": { … }, "requestId": "a1b2c3d4-…" } }`.
The shape is guaranteed by _construction_, not validation: `setErrorHandler` and `setNotFoundHandler`
are the single producers of every error body, and they build it unconditionally. `errorResponse` (in
`error-schema.ts`) is a separate, **opt-in** Zod contract a route declares for a given status — it
publishes the shape in OpenAPI and lets the serializer check it, but only for a status that route
declares. Plenty of error responses never touch it: a `500`, an unmatched-route `404`, and any route
with no `response` map (`POST /v1/auth/logout` declares only a `body` schema). `code`, `message`, and
`requestId` are always present, `details` is optional, and `requestId` equals the correlation id
(`x-request-id`), so a client error report is traceable to that request's log lines.

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

The status is governed by the error's `kind`; the `code` defaults to the kind string but a semantic
error accepts a **custom** `code` (e.g. `new ConflictError('…', { code: 'EMAIL_TAKEN' })`) that
overrides the default while the status stays fixed. The idempotency plugin uses exactly this mechanism
for its `409 IDEMPOTENCY_KEY_IN_PROGRESS` and `400 IDEMPOTENCY_KEY_INVALID` /
`IDEMPOTENCY_KEY_MISMATCH` answers (see [Idempotency](./idempotency.md)).

### Pagination envelope

List endpoints accept `page` and `pageSize` query parameters (defaults `page=1`, `pageSize=10`;
`pageSize` capped at 100) and return the envelope defined by `paginated(itemSchema)`:

```json
{ "items": [], "page": 1, "pageSize": 10, "total": 42, "hasNext": true, "hasPrev": false }
```

### Shared building blocks

```ts
// src/shared/errors  — throw meaning, not HTTP. Each also takes { code?, details?, cause? }.
new ValidationError(message);    // → 400          new NotFoundError(message); // → 404
new ConflictError(message);      // → 409          new ForbiddenError(message?); // → 403 'Forbidden'
new UnauthorizedError(message?); // → 401 'Unauthorized'
new InternalError(message?);     // → 500 'Internal error', isOperational = false

// src/shared/pagination  — framework-free page math
function normalizePageQuery(input: PageQueryInput): PageQuery; // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
function createPage<T>(items: T[], total: number, query: PageQuery): Page<T>; // hasNext/hasPrev

// src/presentation/http/schemas  — Zod response contracts feature routes reference
function paginated<Item extends z.ZodType>(item: Item); // page envelope
const timestamp; // z.date() for date fields
const errorResponse; // the error envelope
```

### Route decorators, config flags, and identity helpers

```ts
app.authenticate;                  // FastifyInstance decorator — verifies the bearer token and sets
request.user?: AccessTokenPayload; // request.user; wire it as an onRequest/preHandler hook

app.diContainer;                   // the container buildApp was given (root cradle)
request.diScope;                   // its per-request child scope, disposed on response

config: { idempotency: true };     // opts the route into Idempotency-Key claim/replay
config: { rateLimit: { max, timeWindow } }; // a stricter, independently-counted per-route bucket
config: { rateLimit: false };      // opt OUT of the global limiter — used by healthRoutes and
                                   // metricsRoutes so probes never consume the RATE_LIMIT_MAX quota

toRequestActor(request.user);      // → RequestActor (a UserActor, or ANONYMOUS_ACTOR when absent);
                                   // pass it as the last argument of a use case's execute()
```

Authorization is **not** an HTTP-layer concern: the permission check lives in the use case, so it
holds for every caller rather than only for requests. The HTTP layer proves identity and hands the use
case an `Actor`. See [Authentication](./authentication.md) for `authenticate` / `request.user` and
[Role-Based Authorization](./role-based-authorization.md) for the access policy.

## Configuration

`src/config/env.ts` parses and validates the whole process environment once via **`envalid`**
(`cleanEnv`), exports a typed frozen `env`, then runs `assertProductionSecrets(env)` (see
[Boot-time configuration guards](#boot-time-configuration-guards)). Defaults are copied verbatim; `—`
means **required** (no default, boot fails if unset), and `devDefault` values apply only outside
production. Two OpenTelemetry sampler knobs — `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` —
are read natively by the OTel SDK rather than `env.ts`, so they are documented in
[Tracing](./tracing.md).

### Read by this feature

Consumed directly in `buildApp`, its plugins, `security.ts`, `cookies.ts`, `health-app.ts`, `main.ts`,
or a boot-time guard.

| Variable                   | Default                                                   | Meaning                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development`                                             | One of `development`, `test`, `production`. Drives `env.isProduction`, which gates helmet CSP, Swagger, and the production secret check.                                                                                   |
| `HOST`                     | `0.0.0.0`                                                 | Bind address for `app.listen` (used in `main.ts` and `worker.ts`).                                                                                                                                                         |
| `PORT`                     | `8000`                                                    | Listen port of the API process.                                                                                                                                                                                            |
| `WORKER_PORT`              | `8001`                                                    | Listen port of the worker's probe server — the app built by `buildHealthApp` and started in `src/worker.ts`. See [Health Checks](./health-checks.md).                                                                      |
| `LOG_LEVEL`                | `info`                                                    | Pino level (`fatal`…`trace`); `main.ts` passes it to `createBaseLogger`, whose logger lands in the cradle as `baseLogger` and becomes Fastify's `loggerInstance`. See [Structured Logging](./structured-logging.md).       |
| `JWT_ACCESS_SECRET`        | `—`                                                       | Access-token signing secret (required); the boot-time guard demands ≥ 32 chars in production. See [Authentication](./authentication.md).                                                                                   |
| `REFRESH_TOKEN_TTL`        | `1209600`                                                 | Refresh-token lifetime in seconds (14 days); also the refresh-cookie `Max-Age` set by `cookies.ts`.                                                                                                                        |
| `COOKIE_SECRET`            | `''` (empty)                                              | When non-empty, cookies are signed; passed to `@fastify/cookie` and read by the cookie helpers. The boot-time guard demands ≥ 32 chars in production.                                                                      |
| `COOKIE_SECURE`            | `true` (devDefault `false`)                               | Sets the `Secure` flag on the refresh cookie.                                                                                                                                                                              |
| `WEB_ORIGIN`               | `—` (devDefault `http://localhost:5173`)                  | Allowed CORS origin; passed to `@fastify/cors` with `credentials: true`.                                                                                                                                                   |
| `RATE_LIMIT_MAX`           | `100`                                                     | Global rate-limit ceiling per window.                                                                                                                                                                                      |
| `RATE_LIMIT_WINDOW`        | `1 minute`                                                | Global rate-limit window; also reused by the per-route auth buckets.                                                                                                                                                       |
| `TRUST_PROXY`              | `false`                                                   | Which proxies may be believed when resolving `request.ip` from `X-Forwarded-For`. Parsed by `parseTrustProxy` at boot. **Security-sensitive** — see [Trusted proxies](#trusted-proxies-and-the-rate-limiter-bucket-key).   |
| `BODY_LIMIT_BYTES`         | `1048576`                                                 | Maximum request body in bytes; a larger body yields `413`.                                                                                                                                                                 |
| `REQUEST_TIMEOUT_MS`       | `30000`                                                   | How long a request may take to _arrive_ (headers plus body) before Fastify answers `408`. Also read by the worker's probe server. Does not bound handler execution.                                                        |
| `KEEP_ALIVE_TIMEOUT_MS`    | `72000`                                                   | Idle keep-alive window; keep it above your load balancer's idle timeout.                                                                                                                                                   |
| `MAX_PARAM_LENGTH`         | `100`                                                     | Maximum length of a single route parameter; a longer one yields a raw `414`.                                                                                                                                               |
| `REDIS_URL`                | `—` (devDefault `redis://127.0.0.1:6379`)                 | Redis connection; backs the distributed rate-limit store (and BullMQ, idempotency, health checks).                                                                                                                         |
| `METRICS_ENABLED`          | `true`                                                    | Gates `metricsPlugin` and `GET /metrics` in `buildApp` (and the worker's `/metrics`), and therefore whether `metricsRecorder` is resolved. See [Metrics](./metrics.md).                                                    |
| `BULL_BOARD_ENABLED`       | `false`                                                   | Gates `bullBoardPlugin` — and therefore whether `dashboardQueue` (a live BullMQ queue) is resolved — and whether the boot-time guard enforces `BULL_BOARD_PASSWORD` strength. See [Background Jobs](./background-jobs.md). |
| `BULL_BOARD_PATH`          | `/admin/queues`                                           | Base path the dashboard mounts at.                                                                                                                                                                                         |
| `BULL_BOARD_USERNAME`      | `admin`                                                   | Basic-auth username for the dashboard.                                                                                                                                                                                     |
| `BULL_BOARD_PASSWORD`      | `''` (empty)                                              | Basic-auth password; empty fails login closed. The boot-time guard demands ≥ 16 chars in production when the dashboard is enabled.                                                                                         |
| `BULL_BOARD_READONLY`      | `true`                                                    | Mounts the dashboard in read-only mode (`readOnlyMode`).                                                                                                                                                                   |
| `APP_NAME`                 | `app`                                                     | Identity prefix read by `src/config/app-identity.ts`; supplies the OpenAPI title (`<APP_NAME> API`), the rate-limit key namespace (`<APP_NAME>-rate-limit-`), and the dashboard's Basic realm.                             |
| `VERIFICATION_CODE_SECRET` | `—` (devDefault `dev-verification-code-secret-change-me`) | Not used by the HTTP layer, but one of the three keys the boot-time guard enforces. See [Email Verification](./email-verification.md).                                                                                     |

### Read by sibling features

Parsed by the same `cleanEnv` call and validated at the same moment, but consumed elsewhere. Listed
here only so the boot-time contract is complete in one place; each owning doc states the variable's
default and meaning.

| Variable                                                                                                | Owning doc                                                |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                                                                                          | [User CRUD](./user-crud.md)                               |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL`, `RATE_LIMIT_AUTH_MAX`                                 | [Authentication](./authentication.md)                     |
| `BOOTSTRAP_ADMIN_EMAIL`                                                                                 | [Role-Based Authorization](./role-based-authorization.md) |
| `QUEUE_PREFIX`, `QUEUE_CONCURRENCY`                                                                     | [Background Jobs](./background-jobs.md)                   |
| `DATA_RETENTION_TTL`                                                                                    | [Data Retention](./data-retention.md)                     |
| `IDEMPOTENCY_RESULT_TTL`, `IDEMPOTENCY_LOCK_TTL`                                                        | [Idempotency](./idempotency.md)                           |
| `HEALTHCHECK_TIMEOUT_MS`                                                                                | [Health Checks](./health-checks.md)                       |
| `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT`              | [Tracing](./tracing.md)                                   |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | [Email Sending](./email-sending.md)                       |
| `VERIFICATION_CODE_TTL`, `VERIFICATION_MAX_ATTEMPTS`                                                    | [Email Verification](./email-verification.md)             |
| `PASSWORD_RESET_TOKEN_TTL`, `PASSWORD_RESET_URL_BASE`                                                   | [Password Reset](./password-reset.md)                     |

### Code-level options

`BuildAppOptions` (see [Bootstrap API](#bootstrap-api)) is the whole code-level surface: `container`,
plus the behaviour flags `disableRequestLogging` and `rateLimit` — the integration harness and any test
that does not want a Redis-backed limiter pass `rateLimit: false`. There is no logger option: the
logger is a cradle key, so the container is the single source of truth for it.

`APP_CONTAINER_OPTIONS` is the second knob, deliberately not configurable per call site.
`InjectionMode.PROXY` decides how every resolver receives its dependencies (one destructurable cradle
object rather than positional arguments), and `strict: true` turns Awilix's lifetime checks on —
registering a `SINGLETON` on a non-root scope is refused, and a longer-lived registration resolving a
shorter-lived one is reported as a lifetime leak instead of silently captured.

### Derived security defaults

- `helmetOptions(env.isProduction)` returns `{}` in production (helmet's full defaults, **CSP on**)
  and `{ contentSecurityPolicy: false }` elsewhere — CSP is relaxed outside production so the Swagger
  UI at `/docs` loads.
- `rateLimitOptions(max, timeWindow)` sets `skipOnError: true` (fail-open), a `nameSpace` of
  `RATE_LIMIT_KEY_NAMESPACE` (`appIdentity.rateLimitNamespace`, i.e. `'app-rate-limit-'` at the
  default `APP_NAME`) for its Redis keys, and an `errorResponseBuilder` emitting a `FastifyError` with
  `code: 'RATE_LIMITED'` and the window's `statusCode`, so a throttled request flows through the same
  envelope as everything else. It sets no `keyGenerator`, so buckets are keyed on `request.ip`.
- Swagger has no dedicated variable — it is gated purely on `!env.isProduction`. Bull Board is gated
  on `BULL_BOARD_ENABLED` and additionally protects itself with Basic Auth and its own strict CSP.

### Trusted proxies and the rate-limiter bucket key

Because the limiter keys on `request.ip`, `TRUST_PROXY` decides whether it can be bypassed. What
`request.ip` resolves to is decided entirely by `trustProxy`, which Fastify delegates to
**`@fastify/proxy-addr`**: it builds the candidate list right-to-left — socket address first, then
`X-Forwarded-For` reversed — and walks left for as long as each address it meets is one it trusts.

| `TRUST_PROXY`                   | `request.ip` resolves to                             | Spoofable?                                    |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `false`                         | the socket address                                   | No                                            |
| `true`                          | the leftmost `X-Forwarded-For` entry                 | **Yes** — the client writes that entry        |
| an address, CIDR or named range | the first entry whose peer is outside the trust list | No, when the list names only your own proxies |

Take one proxy in front and a malicious client sending `X-Forwarded-For: 198.51.100.1` (a lie). The
proxy _appends_ the real peer, so the server sees `X-Forwarded-For: 198.51.100.1, 203.0.113.9`. With
`TRUST_PROXY` naming that proxy's own address, the walk trusts the peer it actually connected to,
steps one entry left, finds `203.0.113.9` outside the trust list and stops — the real client. With
`TRUST_PROXY=true`, or a trust list stretched to also cover `203.0.113.9`, it resolves to
`198.51.100.1` — the address the attacker chose, letting them mint unlimited fresh buckets. Both
hazards are pinned by tests. Use `true` only when the edge provably strips inbound `X-Forwarded-For`;
otherwise name your proxies and nothing beyond them.

**Hop counts are rejected at boot.** Earlier revisions of this boilerplate accepted `TRUST_PROXY=1`
and handed the integer to Fastify, which then trusted that many entries without ever checking who the
peer was. Fastify closed that hole in **5.12.1**: a hop count cannot verify the immediate peer, so a
client reaching the socket directly could forge an entire chain and have the Nth entry believed. Since
5.12.1 a numeric `trustProxy` is inert — it fails closed, and `request.ip` silently falls back to the
socket address. Left unhandled that is the worse failure for this app: every proxied request would
collapse onto a single limiter bucket and throttle all users as one client. `parseTrustProxy`
therefore rejects numeric values outright, turning a silent loss of client identity into a loud boot
error that names the accepted forms.

The shipped default is `false`, which is also what `docker-compose.yml` pins, because that topology
publishes port 8000 directly with no ingress in front. Address **syntax** is validated by
`@fastify/proxy-addr` when the server is constructed, so a malformed CIDR still fails the boot;
`parseTrustProxy` deliberately does not reproduce that acceptance set, which would mean taking on
`ipaddr.js` as a direct dependency to say the same thing twice.

### Limits that bypass the error envelope

Only `bodyLimit` (`413`) throws a `FastifyError` that reaches `registerErrorHandler`. A
`requestTimeout` expiry produces a `408` written by Fastify's `defaultClientErrorHandler`, and an
over-long route parameter produces a raw `414` (`FST_ERR_MAX_PARAM_LENGTH`) written straight to the
response. Neither carries `requestId` or the JSON envelope, so clients must not be written against one
for those two statuses. This is upstream Fastify behaviour, not a choice made here.

## Usage & extension

### Build and run an app

Any process wanting the HTTP stack composes the two factories — the `src/main.ts` shape shown under
[How it works](#how-it-works), minus the shutdown wiring:

```ts
const container = createAppContainer(createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env)));
const app = await buildApp({ container, disableRequestLogging: env.isDevelopment });
await app.listen({ host: env.HOST, port: env.PORT });
```

### Swap a dependency in a test

Register over the container _before_ calling `buildApp` — this is what
`test/integration/support/harness.ts` does, and the ordering is the whole point: the five keys read at
composition time are read during the build, so a later override is too late.

```ts
export async function createHarness(overrides: CradleOverrides = {}): Promise<TestHarness> {
  const container = createAppContainer(createBaseLogger(SILENT_LOG_LEVEL));
  for (const [name, value] of Object.entries(overrides)) {
    container.register({ [name]: asValue(value) });
  }

  const app = await buildApp({ container, disableRequestLogging: true, rateLimit: false });
  await app.ready();

  return { app, prisma: container.cradle.prisma };
}
```

For a **unit** test that needs a DI scope but not the whole graph, use the kit at
`test/unit/support/container.ts`, which builds a throwaway container from the same
`APP_CONTAINER_OPTIONS` so unit and production containers cannot drift on injection mode or
strictness:

```ts
const app = fastify({ logger: false });
await registerTestContainer(app, { accessTokenService: asValue(stubService) });
await app.register(authPlugin);
```

### Throw a semantic error from an inner layer

It becomes the right HTTP response automatically — no `try/catch`, no status code, no `reply`:

```ts
// inside a use case (application layer)
if (await this.users.findByEmail(email)) {
  throw new ConflictError('Email already registered', { code: 'EMAIL_TAKEN', details: { email } });
}
// → 409 { "error": { "code": "EMAIL_TAKEN", "message": "…", "details": {…}, "requestId": "…" } }
```

### Add a new error kind

Only when none of the six existing kinds fits — usually one does. Three edits keep the mapping total
and type-safe:

1. Add the kind to `ErrorKind` in `src/shared/errors/app-error.ts`, beside the existing
   `Validation`, `NotFound`, `Conflict`, `Unauthorized`, `Forbidden`, `Internal`:
   ```ts
   TooManyRequests: 'TOO_MANY_REQUESTS',
   ```
2. Add its status to `KIND_TO_STATUS` in `src/presentation/http/error-handler.ts` — the `Record` is
   keyed by `ErrorKindType`, so TypeScript forces you to cover the new kind:
   ```ts
   [ErrorKind.TooManyRequests]: 429,
   ```
3. Add a subclass in `src/shared/errors/semantic-errors.ts`, copying the shape of its siblings — the
   two spreads are what keep `details` and `cause` absent rather than `undefined` — and export it
   from `src/shared/errors/index.ts`:
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

### Add a cross-cutting plugin

This is the extension this doc owns end to end. A plugin adding a hook or decorator for the _whole_
app must be wrapped in `fp(...)` — without it Fastify encapsulates the plugin and the hook fires for
nothing (see [Plugin registration order](#plugin-registration-order)).

```ts
// src/presentation/http/plugins/tenant.ts
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

Then add exactly one line to `buildApp`:

```ts
await app.register(idempotencyPlugin);
await app.register(tenantPlugin); // hooks must wrap routes → before route registration

registerErrorHandler(app);
```

If the plugin needs a collaborator from the graph, **declare it as a plugin option and let `buildApp`
push it in** — the pattern `metricsPlugin`, `bullBoardPlugin`, and `healthRoutes` all follow. Do not
reach into `app.diContainer.cradle` from inside a plugin; that is service location by string key, and
it makes the plugin untestable without a container:

```ts
export interface TenantPluginOptions {
  tenantResolver: TenantResolver;
}
export const tenantPlugin = fp<TenantPluginOptions>((app, { tenantResolver }) => {
  /* … */
});

// in src/presentation/http/app.ts
await app.register(tenantPlugin, { tenantResolver: container.cradle.tenantResolver });
```

Position follows from what the plugin needs; the rules compose, so take the latest position every
applicable rule allows, then register before every route:

| The plugin…                                            | goes after / before                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| resolves per request from `request.diScope.cradle`     | **after** `fastifyAwilixPlugin` (that's what creates `request.diScope`)  |
| needs a value from the graph at composition time       | anywhere — the container arrives fully wired; take it as a plugin option |
| adds hooks that must wrap routes                       | **before** the route registrations at the end of `buildApp`              |
| must observe or translate errors thrown by other hooks | **before** `registerErrorHandler(app)`                                   |
| should be exempt from / covered by the global limiter  | **before** / **after** `fastifyRateLimit`                                |
| deliberately scopes its hooks to one mount only        | drop the `fp()` wrapper (this is what `bullBoardPlugin` does)            |

Give it a sibling test under `plugins/` — the existing five (`authenticate.test.ts`,
`correlation-id.test.ts`, `idempotency.test.ts`, `metrics.test.ts`, `bull-board.test.ts`) build a bare
Fastify instance, register the plugin with a `vitest-mock-extended` `mock<T>()` or a
`registerTestContainer` stub for its collaborators, and `inject` requests at it.

### Mount a new v1 resource router

Feature routers are Fastify plugins (typed `FastifyPluginCallbackZod`); `apiV1Routes` is the one place
that assigns their URL real estate. Add one registration and the router inherits the `/v1` prefix, the
shared plugins, and the error handler:

```ts
// src/presentation/http/routes/api-v1-routes.ts
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
tag** — a router without it lands untagged in `/docs`. The same hook is where a router sets group-wide
route `config`, which is how `healthRoutes` and `metricsRoutes` exempt themselves from the limiter:

```ts
// src/presentation/http/routes/account-routes.ts
export const accountRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('onRoute', (route) => {
    route.schema = { ...route.schema, tags: ['Accounts'], security: [{ bearerAuth: [] }] };
    // healthRoutes / metricsRoutes additionally set:
    // route.config = { ...route.config, rateLimit: false };
  });
  done();
};
```

A future breaking generation gets its own `API_V2_PREFIX` constant in `api-version.ts` and a sibling
`apiV2Routes` registered next to `apiV1Routes` in `app.ts` — v1 keeps serving unchanged.

### Declare a response contract on a route

The wire shape is then enforced and internal fields stripped. Compose `paginated`, `timestamp`, and
`errorResponse`, mirroring what the user routes do:

```ts
const accountResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  closedAt: timestamp.nullable(), // nullable in the DTO ⇒ nullable here, or a real null becomes a 500
  createdAt: timestamp,
  updatedAt: timestamp,
});
const paginatedAccounts = paginated(accountResponse);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

app.get('/', { schema: { querystring: listQuery, response: { 200: paginatedAccounts } } }, handler);
```

Because the serializer compiler validates the payload against `accountResponse`, any field the schema
does not list (a password hash, an internal flag) is dropped before it reaches the client — even if a
mapper accidentally includes it. The same validation is **fail-closed** in the other direction, so the
schema must admit every legal value the DTO can hold (see
[Design decisions](#design-decisions--trade-offs)).

### Return a page from a use case

This is the body of `src/application/user/list-users.ts` — note the two-argument
`execute(input, actor)` signature and the permission check as the first statement, which is what makes
`toRequestActor(request.user)` the last argument at the call site:

```ts
async execute(input: ListUsersInput, actor: Actor): Promise<ListUsersOutput> {
  ensurePermission(actor, PERMISSIONS.UsersRead.key);       // throws ForbiddenError → 403

  const query = normalizePageQuery(input);                  // clamps page ≥ 1, 1 ≤ pageSize ≤ 100
  const { items, total } = await this.users.list(query);
  return createPage(items.map(toUserDto), total, query);    // computes hasNext / hasPrev
}
```

### Protect a route

Wire the decorator as a hook and hand the use case an actor:

```ts
app.get(
  '/',
  {
    onRequest: [app.authenticate], // 401 if the bearer token is missing/invalid
    schema: { response: { 200: paginatedAccounts, 401: errorResponse, 403: errorResponse } },
  },
  async (request, reply) => {
    const { listAccounts } = request.diScope.cradle;
    // the use case runs its permission check first — 403 if the caller lacks the permission
    return reply.send(await listAccounts.execute(request.query, toRequestActor(request.user)));
  },
);
```

### Tighten per-route policy through route config

A stricter rate bucket and idempotent retries are both opt-in flags, no new plumbing — this mirrors
`POST /v1/auth/register` in `src/presentation/http/routes/auth-routes.ts`. The claim/replay semantics
behind the first flag are documented in [Idempotency](./idempotency.md):

```ts
app.post(
  '/',
  {
    config: {
      idempotency: true, // Idempotency-Key claim/replay
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW },
    },
    schema: { body: createAccountBody, response: { 201: accountResponse, 409: errorResponse } },
  },
  handler,
);
```

## Design decisions & trade-offs

- **`buildApp` consumes a container; it never builds one.** `@fastify/awilix` exports a module-global
  `diContainer`, and registering the graph into it is the library's default path; this codebase does
  not. `container` is required, `createAppContainer` is called only by entry points, and the
  presentation layer never imports `src/container.ts`, so `container-is-not-importable` needs no
  exemption. The alternative — an optional `container` with a `?? createAppContainer(app.log)`
  fallback — was rejected because it would leave the _production_ path constructing the graph inside
  the presentation layer, keeping the breach alive for the call site that matters most. The payoff
  beyond layering is reentrancy and honest test overrides: with a shared global, two `buildApp` calls
  overwrite each other's registrations, and a harness registering overrides after `buildApp` returns
  type-checks, runs green, and changes nothing for the five keys read during the build —
  `test/integration/harness-overrides.int.test.ts` keeps that regression from returning. Hoisting
  those five reads into `BuildAppOptions` was rejected too: it would not remove the reads
  (`fastifyAwilixPlugin` still needs a real container for request scopes, so every call site would
  pass `container` **and** values derived from it), and since `rateLimitRedis` and `dashboardQueue`
  open live connections when resolved, required options would force a `BULL_BOARD_ENABLED=false`
  process to open a queue and a Redis connection nothing uses. The cost is one line per entry point.
- **Dependencies arrive as options, never by service location.** `container` is the _only_ dependency
  option: passing a dependency _alongside_ the container it came from creates a second source of truth
  no type or test can police — nothing would force an `opts.healthCheck` to be the container's
  `healthCheck`. The rule holds one level down: `app.diContainer.cradle.X` inside a plugin is a leaf
  pulling a collaborator by string key, so `metricsPlugin` takes
  `MetricsPluginOptions { metricsRecorder }` and `bullBoardPlugin` takes
  `BullBoardPluginOptions { dashboardQueue }`, joining `healthRoutes`, `workerMetricsRoutes`, and
  `buildHealthApp`; their unit tests hand them a `mock<Queue>()` or a plain recorder instead of
  standing up DI. The only by-name resolutions left are from the **request scope**, where per-request
  lifetime is the actual requirement. Two supporting choices follow: `APP_CONTAINER_OPTIONS` lives in
  a leaf module rather than an export of `container.ts`, so the unit-test kit shares the exact
  injection mode and strictness without a _value_ import of `createRegistrations` dragging all
  thirteen composition modules (Prisma, ioredis, bullmq, argon2, jose) into lean unit tests; and
  `injectionMode` is a container property rather than a plugin option because
  `@fastify/awilix@8.2.1` rejects `{ container, injectionMode }` together.
- **Registration order is load-bearing for hooks, not for wiring.** Misordering the chain fails
  **silently** — Fastify raises no error for a hook that reaches nothing, so a plugin registered after
  the routes it should wrap never fires, and DI resolution, correlation, metrics coverage, the OpenAPI
  spec, idempotent replay, or error coverage break with no diagnostic. The constraint fixing each
  position is tabulated under [Plugin registration order](#plugin-registration-order). Dependency
  wiring imposes no ordering constraint at all: the container arrives fully wired, so all five
  composition-time cradle reads are valid from `buildApp`'s first line. Three nonetheless stay inside
  their feature gates, so an unused Redis or BullMQ socket is never opened.
- **One centralized error handler over per-route `try/catch`.** A single `setErrorHandler` owns the
  whole kind→status→envelope translation, so no route ever writes a status code for an error and the
  wire shape cannot drift between endpoints. The alternative — HTTP-aware errors or `try/catch` in
  each use case — would scatter status codes across the application layer and duplicate the envelope.
  The cost is one indirection: to see why a thrown error became a given status you read
  `error-handler.ts`, not the throw site.
- **A semantic `AppError` hierarchy in `src/shared`, framework-free.** Inner layers throw meaning
  carrying a `kind`, a machine `code`, and optional `details`; `kind` decides the status, the rest
  fills the body. Because these types import no framework, an application use case constructs them
  without violating the Dependency Rule, and the presentation layer is the sole place they become
  HTTP. `isOperational` then splits expected failures from bugs: semantic errors log at `info`, only
  `InternalError` is non-operational and logs at `error`, and any unknown throw is treated as a bug
  and answered with a generic `500`, so internal detail is never serialized to a client.
- **URL-prefix versioning through one constant.** The version lives in the path, not a header, so it
  is visible in logs, curl-able, and cacheable, and the whole generation is one constant
  (`API_V1_PREFIX`) plus one mounting plugin (`apiV1Routes`) — a breaking v2 becomes a sibling mount
  rather than a rewrite. Operational endpoints stay unversioned because they are contracts with
  orchestrators. The costs: the version string appears in every client URL, and anything path-scoped
  must follow it — which is why `cookies.ts` derives the refresh-cookie path from `API_V1_PREFIX`.
- **Zod serializer compilers to enforce response contracts.** A declared `response` schema makes the
  outgoing JSON validated and **whitelisted** to exactly the declared fields, turning "don't forget to
  omit the password hash" into a guarantee (proved by `pagination-schema.test.ts`), and doubles as the
  OpenAPI source of truth. Enforcement is **fail-closed** in both directions, which is the sharp edge:
  a payload the schema _rejects_ does not degrade — serialization throws and the client gets a `500`
  in place of a perfectly good `200`. A response schema must therefore admit every legal value the DTO
  can hold, which is why `role-response-schema.ts` marks `key` and `description` `.nullable()`: both
  are `string | null` in `RoleDto`, and a plain `z.string()` would turn every role with no key into a
  `500`. The other cost: every response needs a schema, and a too-loose one weakens the stripping.
- **Shared, framework-free pagination.** Request clamping (page ≥ 1, `pageSize` ≤ 100) and metadata
  math (`hasNext` / `hasPrev`) live once in `src/shared`, used by both use cases and the `paginated()`
  response schema, so every list endpoint paginates identically and a hostile `pageSize=100000` is
  bounded server-side.
- **Redis-backed, distributed rate limiting that fails open.** The limiter gets a dedicated handle —
  `container.cradle.rateLimitRedis`, an `ioredis` singleton from `createRateLimitRedis` with
  `connectTimeout: CONNECT_TIMEOUT_MS` (500), `commandTimeout: COMMAND_TIMEOUT_MS` (1000),
  `maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST` (1) and `enableOfflineQueue: false` — so the counter
  is shared across every process and replica. The rejected alternative, a per-process store, would let
  N replicas each grant the full quota, multiplying the real limit by N. Those four settings make
  `skipOnError: true` a bounded cost rather than a stall: with no offline queue and one retry, an
  unreachable Redis fails the command fast and the request is allowed through, trading enforcement for
  availability so a Redis blip cannot take the API down. Sensitive endpoints layer stricter per-route
  buckets on top via `config.rateLimit` (`RATE_LIMIT_AUTH_MAX`), each counted independently; the
  operational routers opt out entirely, because a kubelet probe or a Prometheus scrape must never
  exhaust — or be refused by — the shared client quota. Both are proved by
  `test/integration/rate-limit.int.test.ts`.
- **Cross-cutting idempotency as a plugin, opt-in per route.** Retried mutations are an HTTP delivery
  concern, so the claim/replay mechanics live in one `fastify-plugin` rather than inside use cases,
  and routes opt in with a one-line `config: { idempotency: true }`. Store, TTLs, and failure
  semantics are documented in [Idempotency](./idempotency.md).
- **Secure-by-default middleware, environment-aware.** helmet, a `WEB_ORIGIN`-pinned CORS allowlist
  with `credentials: true` (required for the refresh cookie), and a global rate limit are all on unless
  explicitly relaxed. Two relaxations are deliberate and code-visible: CSP is disabled outside
  production so Swagger UI works, and Swagger itself is registered only when `!env.isProduction`.
- **The production secret check runs at import time, not at server start.** Living in `env.ts` means
  every process that reads configuration — API, worker, scripts — is covered by construction, with no
  "which entry point forgot to call the guard" question. Reporting **every** offending key in one
  throw rather than failing on the first is equally deliberate: a misconfigured deploy is fixed in one
  pass instead of N restarts. Mechanics in
  [Boot-time configuration guards](#boot-time-configuration-guards).
- **Bull Board is opt-in, self-guarded, and deliberately encapsulated.** It is registered only when
  `BULL_BOARD_ENABLED` and defends itself (constant-time Basic Auth that fails closed, its own strict
  CSP, `readOnlyMode` by default) instead of relying on ambient protections. It is the one
  cross-cutting plugin _not_ wrapped in `fastify-plugin`, which confines its Basic-Auth and CSP hooks
  to the dashboard mount — the encapsulation that is a hazard everywhere else is the feature here.
  Details in [Background Jobs](./background-jobs.md).
- **Refresh cookie: `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, signed when a secret is set.** The
  refresh token is confined to the versioned auth path and unreadable by JavaScript; when
  `COOKIE_SECRET` is present it is HMAC-signed and `readRefreshCookie` rejects a tampered value.
  `COOKIE_SECURE` gates the `Secure` flag so local HTTP dev works while production forces HTTPS-only.
- **The worker gets a separate, minimal app.** `buildHealthApp` builds a second Fastify instance with
  only the Zod compilers and the `/health` + `/metrics` routers — no DI scope plugin, CORS, cookies,
  auth, idempotency, rate limiting, Swagger, or error handler — taking `healthCheck` and
  `metricsExposition` as plain options from the container `src/worker.ts` builds. The worker serves no
  public traffic, so every omitted plugin would be cost without benefit, and a change to the API's
  plugin chain cannot break its probes (see [Health Checks](./health-checks.md)).
- **`buildApp` returns the instance without listening.** Networking and signal handling live in
  `main.ts`. This makes the whole HTTP stack injectable in tests (`app.inject(...)`) with no open
  sockets, and `disposeOnClose: true` ties container disposal to `app.close()`, so a test that closes
  its app also closes that app's Redis and BullMQ connections.
- **`REQUEST_TIMEOUT_MS` does not mean what its name suggests.** It is worth setting — it bounds an
  otherwise unbounded body phase — but three things surprise. Node does not apply `headersTimeout` to
  headers and `requestTimeout` to the whole request; its sweep **normalises the pair**, treating the
  smaller value as the header deadline and the larger as the whole-request deadline. Fastify assigns
  `server.requestTimeout` after construction and never touches `server.headersTimeout` (60 s), so
  `REQUEST_TIMEOUT_MS=30000` yields a 60 s request deadline and a **30 s header deadline** — set very
  low it cuts off legitimate slow clients mid-headers. Enforcement is also swept rather than exact
  (`connectionsCheckingInterval` defaults to 30 s, so the close lands anywhere in a 30 s band), and it
  bounds the _arrival_ of the request, not the handler — a slow handler still returns `200`.
- **Zero and negative transport limits are handled inconsistently by Fastify.** `BODY_LIMIT_BYTES`
  rejects both `0` and negatives at boot (`'bodyLimit' option must be an integer > 0`).
  `KEEP_ALIVE_TIMEOUT_MS=0` and `MAX_PARAM_LENGTH=0` silently revert to their defaults by different
  mechanisms: `keepAliveTimeout` is Fastify's own `options.x || default`, whereas Fastify preserves
  `maxParamLength: 0` and the `|| 100` fallback happens inside `find-my-way` — so `initialConfig`
  reports `0` while the effective limit is `100`. Negative `KEEP_ALIVE_TIMEOUT_MS` and
  `REQUEST_TIMEOUT_MS` reach the Node server unvalidated, and a negative `MAX_PARAM_LENGTH` makes
  every parameterised route answer `414`. Lower bounds on the envalid declarations are a reasonable
  follow-up.
- **`trustProxy` correctness cannot be validated at boot.** Whether `1` or `2` is right depends on
  deployment topology, which the process cannot observe — `parseTrustProxy` can reject values outside
  the grammar, not values wrong for the deployment. The mitigations are the safe `false` default and
  documentation.
- **`connectionTimeout` is deliberately not exposed.** Fastify defaults it to `0`, `requestTimeout`
  already bounds the slow-request window, and any non-zero value severs healthy keep-alive connections
  mid-reuse. A knob that must stay at its default would be an empty abstraction.

## Testing

Unit tests run under Vitest beside the code they cover. `src/container.ts` and
`src/container-options.ts` are inside the 100 % coverage gate declared in `vitest.config.ts`.

- `src/container.test.ts` — the container factory's contract: two calls return **different**
  containers; a `register({ metricsRecorder: asValue(stub) })` on one is invisible to the other;
  `.options` equals `{ injectionMode: InjectionMode.PROXY, strict: true }`; `cradle.baseLogger` is the
  very logger the factory was given.
- `src/composition/compose.test.ts` — builds a real container through `createAppContainer` and asserts
  the merged registration map is complete and free of duplicate keys across the thirteen modules.
- `src/presentation/http/error-handler.test.ts` — routes that throw each error type; asserts every
  `AppError` subclass maps to its status (400/404/409/401/403/500), a Fastify `error.validation` yields
  `400`/`VALIDATION`, a non-`AppError` 4xx uses its own `statusCode` and `code` (falling back to
  `BAD_REQUEST`), an unhandled error yields `500`/`INTERNAL` with the generic message, unknown routes
  yield `404`/`ROUTE_NOT_FOUND`, and every body carries `requestId`.
- `src/presentation/http/security.test.ts` — registers helmet and rate-limit with the real option
  builders; asserts `x-content-type-options: nosniff`, the `x-ratelimit-*` headers, a `429` in the
  `RATE_LIMITED` envelope once the global limit trips, an independently enforced stricter per-route
  bucket, and that `rateLimitOptions` sets `skipOnError` and `RATE_LIMIT_KEY_NAMESPACE`.
- `src/presentation/http/cookies.test.ts` — `setRefreshCookie` / `clearRefreshCookie` /
  `readRefreshCookie` for `HttpOnly`, `SameSite=Strict`, `Path=/v1/auth`, `Max-Age`, the `Secure` flag,
  and signed-vs-unsigned behaviour including rejection of a tampered signature.
- `src/presentation/http/routes/api-v1-routes.test.ts` — mocks the four resource routers and asserts
  each mounts under its own `/v1` sub-prefix and that unversioned paths (`/users`) 404.
- `src/presentation/http/plugins/correlation-id.test.ts` — the plugin echoes `request.id` back as the
  `x-request-id` header, exposes it as `correlationId` in the `@fastify/request-context` store, and
  mints a distinct id per request.
- `src/presentation/http/schemas/pagination-schema.test.ts` — `paginated()` validates a well-formed
  envelope and **strips unknown fields** from items.
- `src/presentation/http/server-options.test.ts` — every input field lands on its Fastify option with
  `maxParamLength` nested under `routerOptions`, then boots probe apps to pin the four client-address
  outcomes (`false` → socket address; `'loopback'` → the real peer, discarding the forged leftmost
  entry; `true` and a trust list stretched past the real peer → the forged entry) and the request limits (oversized
  body `413`, body within the limit `200`, over-long route parameter `414`, short parameter `200`).
- `src/config/trust-proxy.test.ts` — the `TRUST_PROXY` grammar: `'false'`, `''` and whitespace-only
  trust nothing; `'true'` trusts every hop; keyword casing and surrounding whitespace are ignored;
  addresses, CIDRs, named ranges and comma-separated lists pass through for Fastify to compile, with
  address casing preserved for IPv6; `'1'`, `'0'`, `'01'`, `'-1'`, `'1.5'` and `'33'` are rejected as
  hop counts; and the error message names both the variable and the offending value.
- `src/config/assert-production-secrets.test.ts` — the boot-time guard: a no-op outside production; in
  production it passes at exactly the minimum length, throws naming the offending key when one is
  short or empty, names every weak secret in one error, and includes the `openssl rand` hint.
- `src/shared/errors/app-error.test.ts` and `semantic-errors.test.ts` — the `AppError` base
  (`instanceof Error`, subclass `name`, `kind` / `code` / `message`, `isOperational` default and
  override, `details`, `timestamp`, `cause`, `toJSON()` omitting absent `details`) and, per subclass,
  its `kind`, default and custom `code`, default message, and `isOperational`.
- `src/shared/pagination.test.ts` — `normalizePageQuery` clamping/truncation/defaults and
  `createPage`'s `hasNext` / `hasPrev`, including the empty and exactly-one-full-page cases.
- The other plugins under `plugins/` carry their own sibling tests (`authenticate.test.ts`,
  `idempotency.test.ts`, `metrics.test.ts`, `bull-board.test.ts`), described in the docs that own those
  subsystems. `authenticate.test.ts`, `idempotency.test.ts` and `routes/metrics-routes.test.ts` stand
  up a DI scope through `registerTestContainer` (`test/unit/support/container.ts`); `metrics.test.ts`
  and `bull-board.test.ts` need no container, because their plugins take collaborators as options.
- `src/presentation/http/health-app.test.ts` covers the worker's probe server; its scenarios are
  documented in [Health Checks](./health-checks.md) and [Metrics](./metrics.md).

Integration tests (real container, Redis-backed; configured by `vitest.integration.config.ts`):

- `test/integration/app-bootstrap.int.test.ts` — boots the **real** `buildApp` end to end over a real
  `createAppContainer` and asserts `GET /health/live` and `GET /health/ready` answer 200.
- `test/integration/harness-overrides.int.test.ts` — the regression guard for override ordering:
  `createHarness({ healthCheck: { check: () => Promise.reject(...) } })` must make `GET /health/ready`
  answer `503 { status: 'unavailable' }`. It fails if a refactor moves override registration back
  after `buildApp`, or moves `healthCheck` back to a global container.
- `test/integration/rate-limit.int.test.ts` — with a real Redis: trips the auth bucket at
  `RATE_LIMIT_AUTH_MAX` on `POST /v1/auth/login`, proves `/v1/auth/forgot-password` and
  `/v1/auth/reset-password` count in independent buckets, verifies the counters live under
  `RATE_LIMIT_KEY_NAMESPACE`-prefixed keys (read back through `app.diContainer.cradle.rateLimitRedis`),
  and proves fail-open by disconnecting that handle and still receiving a `401` rather than a block. It
  stays green under the suite's `TRUST_PROXY=loopback` because its requests carry no `X-Forwarded-For`.
- `test/integration/http-hardening.int.test.ts` — pins the **wiring**, not just the factory: asserts
  `app.server.requestTimeout` equals `env.REQUEST_TIMEOUT_MS` and
  `app.initialConfig.routerOptions?.maxParamLength` equals `env.MAX_PARAM_LENGTH`, then proves a forged
  `X-Forwarded-For` entry is discarded end to end under the configured trust list
  (`test/integration/setup-env.ts` sets `TRUST_PROXY=loopback`). Two details make it worth its weight.
  `BODY_LIMIT_BYTES` and `KEEP_ALIVE_TIMEOUT_MS` deliberately equal Fastify's own defaults, so
  asserting them would pass even if the options were never applied — only `requestTimeout` (`0` → 30 s)
  and `routerOptions` (absent → present) discriminate. And `requestTimeout` is **absent from Fastify's
  `initialConfig` type** though it is set at runtime, so it must be read from `app.server`, which also
  proves the value reached the transport rather than just the config object.

Run the suites:

```bash
npm test                 # all unit tests
npm run test:integration # integration tests (needs Docker — the suite starts MariaDB + Redis testcontainers)
```

Run only this feature's unit tests:

```bash
npx vitest run src/presentation/http src/shared/errors src/shared/pagination.test.ts src/container.test.ts src/composition/compose.test.ts src/config/assert-production-secrets.test.ts src/config/trust-proxy.test.ts
```
