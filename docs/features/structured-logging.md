# Structured Logging

> **Status:** Complete · **Layers:** application, infrastructure, presentation, composition root, config, ops · **Verified against:** `7150871`

## Purpose

Structured logging emits each entry as a machine-parseable record of key/value fields — here one JSON
object per line — instead of a free-form text string, so entries can be filtered, correlated, and
indexed by field. Inner layers need to emit diagnostics without depending on a concrete logging
library; every line produced while handling a request must be correlatable back to that request and to
the distributed trace it belongs to; sensitive values must never reach the log sink (the destination
logs are written to — here, the container's stdout); and the framework's own lines must obey exactly
the same rules as the application's. This feature satisfies all of that from a single root logger
instance per process, published on the container under two keys so that Fastify's logger and the
application's logger cannot diverge in level, redaction, or identity. The framing caveat is that the
application never talks to a log store: it writes JSON to stdout, and a separate collector ships that
stream to centralized search, completing the metrics/traces/logs trio alongside
[Metrics](./metrics.md) and [Tracing](./tracing.md).

## How it works

The runtime flow has six concerns. The first five meet inside the Pino configuration, the container,
and the logger adapter, inside the process; the sixth ships the resulting stdout lines to Loki, out of
process.

**1. Building the one root logger (process bootstrap).** Every entry point — `src/main.ts` (HTTP
server), `src/worker.ts` (job worker), `src/scripts/sync-auth.ts` (CLI) — begins by calling
`createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))`, which is exactly
`pino(createLoggerOptions(level, identity))`: a single root Pino instance, typed as Fastify's
`FastifyBaseLogger`. That instance is passed as an argument to `createAppContainer(baseLogger)`, which
registers it under **two** keys on the container's _cradle_ — Awilix's typed object of everything the
container can resolve, from which dependencies are injected by name — in `src/composition/platform.ts`:

- **`baseLogger`** (`asValue(baseLogger)`) — the raw Pino/Fastify logger, for consumers that need the
  full framework surface: all six levels including `fatal` and `trace`, `child()`, and Pino's
  `(mergingObject, message)` argument order. Fastify takes one as `loggerInstance` and then exposes it
  as `app.log`, which is Fastify's own view of the very instance handed to it;
  [`buildHealthApp`](./health-checks.md) and
  [`registerGracefulShutdown`](./graceful-shutdown.md) take one too.
- **`logger`** (`asValue(new PinoLogger(baseLogger, new RequestContextProvider()))`) — the
  application-layer `Logger` port: a four-method, framework-free interface that use cases, event
  handlers, and infrastructure adapters program against.

The two keys are different types serving different audiences, but they are the same underlying stream:
the port instance wraps the very object registered as `baseLogger`. `buildApp` reads that object back
out of the container — `fastify({ loggerInstance: container.cradle.baseLogger, … })` — rather than
constructing a logger of its own, and it is today the **sole** consumer of the `baseLogger` cradle key:
`src/worker.ts` passes its own module-level instance straight into `buildHealthApp` and
`registerGracefulShutdown`, and `src/main.ts` passes `app.log`, which is the same instance reached
through Fastify. `BuildAppOptions` carries **no** logging configuration at all
(`{ container, disableRequestLogging?, rateLimit? }`), so there is no second construction site where a
level, a redaction list, or a service identity could drift out of sync. One instance, one set of
options, every producer.

**2. Establishing the correlation id (per HTTP request).** Fastify is configured in `buildApp` to treat
the `x-request-id` header as the request id (`requestIdHeader: CORRELATION_ID_HEADER`) and to mint a
`randomUUID()` when the header is absent (`genReqId`). The `correlationIdPlugin` registers
`@fastify/request-context` and adds an `onRequest` hook that runs early, before route handlers and the
code that reads the id: it builds a `ContextData` object `{ correlationId: request.id }`, stores it in
the request-scoped context under the key `contextData`, and echoes the id back to the client in the
`x-request-id` response header. Because the hook runs first, the id is available to everything
downstream in that request. Fastify's own automatic lines (`incoming request`, `request completed`,
`request errored`) are written through a per-request **child** logger that Fastify binds with the
`reqId` field, so framework lines and application lines carry the same value under two names —
`reqId` from Fastify, `correlationId` from the request context. (The Fastify instance and plugin
ordering are covered by [HTTP Infrastructure](./http-infrastructure.md); the bounds of the header
contract are in [Public surface](#public-surface) below.)

**3. Making the id available deep in the call stack.** `@fastify/request-context` is backed by Node's
`AsyncLocalStorage`, so the stored `contextData` is visible anywhere within the same asynchronous
execution — a use case, a repository, a domain-event handler — without being passed as an argument.
`RequestContextProvider` (the `ContextProvider` adapter) reads it back with
`requestContext.get('contextData') ?? {}`.

**4. Emitting an enriched log line.** When any layer calls `logger.info(message, data)` on the injected
`Logger`, the `PinoLogger` adapter merges the caller's `data` with the current context via
`withContext`, which returns `{ ...data, ...this.context.getAll() }` — spreading `getAll()` last so
context fields (e.g. `correlationId`) win on key collision — then forwards to the underlying Pino logger
in Pino's `(mergingObject, message)` argument order. Pino serializes the result as one JSON line to
stdout.

**5. Cross-cutting enrichment applied by Pino itself.** The root instance is built from
`createLoggerOptions(level, identity?)`, which wires four behaviours that run on _every_ line regardless
of who emitted it — application code through the port, or Fastify through `app.log`:

- **`base` (service identity)** — when a `ServiceIdentity` is supplied, `{ service, env, version }` is
  stamped onto every line as base fields (replacing Pino's default `pid`/`hostname` base). All three
  real entry points supply one, so lines always carry `service` (e.g. `app-api`), `env` (e.g.
  `development`), and `version` (e.g. `0.0.0`). This is what lets Loki tell one service's logs apart
  and lets an operator filter by environment or release.
- **`formatters.level`** returns `{ level: label }`, overriding Pino's default numeric level (`30`,
  `40`, …) with the string label (`"info"`, `"warn"`, …). Emitting the level as a string is what lets
  the Loki pipeline promote it to a clean indexed label.
- **`redact`** replaces the value at each configured path with the censor string `[Redacted]`
  (`REDACT_CENSOR`) before serialization, so authorization headers, cookies, passwords, and tokens never
  leave the process in cleartext — this covers Fastify's own automatic `req`/`res` logs as well as
  anything your code logs.
- **`mixin: traceCorrelationMixin`** is invoked per line; it reads the active OpenTelemetry span via
  `trace.getActiveSpan()` and, when the span context is valid (`isSpanContextValid`), merges
  `{ trace_id, span_id }` into the line. When no span is active (tracing disabled, or code running
  outside a span) it returns `{}` and nothing is added. See [Tracing](./tracing.md) for how spans are
  created and exported.

**6. Aggregating stdout into Loki (out of process).** The application never opens a socket to Loki —
there is no Pino transport or `pino-loki` target. It only writes newline-delimited JSON to stdout,
Docker captures that stream, and a **Grafana Alloy** collector (`docker/alloy/config.alloy`) does the
rest, in five stages:

1. **Discover.** `discovery.docker` lists every container the Docker daemon knows about, over the
   socket at `unix:///var/run/docker.sock`.
2. **Relabel.** `discovery.relabel` keeps only this compose project's containers
   (`com.docker.compose.project == app`) and drops the observability tools' own logs
   (`alloy|loki|grafana|tempo`, to avoid a self-feeding loop). The same stage promotes each container's
   compose service name to a `compose_service` label and its container name to a `container` label.
   These are Docker-metadata labels, distinct from the `service` value parsed out of the JSON body in
   stage 4.
3. **Tail.** `loki.source.docker` reads the stdout/stderr of the surviving containers and forwards each
   line into the processing pipeline.
4. **Parse and label.** `loki.process` runs three stages in order: `stage.json` extracts `level`,
   `service`, and `trace_id` from the line; `stage.labels` promotes the low-cardinality `level` and
   `service` to **indexed labels** (a label's _cardinality_ is the number of distinct values it takes);
   `stage.structured_metadata` keeps the high-cardinality `trace_id` as **structured metadata**, never a
   label, to avoid label explosion. Non-JSON lines (from mariadb, redis) pass through untouched.
5. **Push.** `loki.write` batches the result to `http://loki:3100/loki/api/v1/push`.

**Loki** (`docker/loki/loki-config.yaml`) then stores the lines on a filesystem backend with a 168h
(7-day) retention window and `allow_structured_metadata: true`. Finally, Grafana provisioning wires
**bidirectional correlation**: the Loki datasource declares a derived field `TraceID` (regex
`"trace_id":"(\w+)"`) that links a log line out to its Tempo trace, and the Tempo datasource's
`tracesToLogsV2` links a trace back to its logs via a LogQL query of the form
`{compose_service="app"} | trace_id = <traceId>` — selecting the app container by the Docker-derived
`compose_service` label, then filtering on the `trace_id` structured metadata.

**Outside an HTTP request** there is no request context: `getAll()` returns `{}`, so `withContext`
passes the caller's `data` through unchanged and the line carries no `correlationId`. Redaction,
identity stamping, the string level, and the trace mixin still apply. Two non-HTTP processes exist, and
only one of them logs through this feature:

- **`src/worker.ts` is the exemplar.** It builds its root logger from the same `createBaseLogger` call,
  hands it to the same `createAppContainer`, and its [job handlers](./background-jobs.md) resolve the
  same `logger` port — so its lines are structured, redacted, and identity-stamped exactly like the
  API's. They carry no `correlationId`, but `JobWorker` wraps every job in
  `runWithExtractedContext(job.data, …)`, which restores the OpenTelemetry context the enqueuing request
  injected into the payload; so when tracing is enabled, a worker line carries the enqueuing request's
  `trace_id`. That, not `correlationId`, is the cross-process correlation key. (The worker's health app
  does not register `correlationIdPlugin`, so its own liveness probes produce no correlation id either.)
- **`src/scripts/sync-auth.ts` is a known gap.** It builds a root logger only to satisfy
  `createAppContainer`'s required argument; every line it actually prints goes through `console.info`,
  `console.warn`, or `console.error`. Those lines are plain text: no `service`/`env`/`version`, no
  redaction, and nothing for Alloy's `stage.json` to parse — they would reach Loki as unparsed strings
  carrying only the Docker-derived labels. Treat it as a script to fix, not as a shape to copy.

## Architecture

The `Logger` and `ContextProvider` **ports** live in the application layer; their **adapters**
(`PinoLogger`, `RequestContextProvider`) live in infrastructure, and the request-scoped correlation id
is seeded in the presentation layer by `correlationIdPlugin`. Dependencies point inward: the
application layer (use cases, event handlers) and the infrastructure adapters that log — the BullMQ
`JobWorker`, the outbox relay, the domain-event dispatcher — depend only on the `Logger` interface, and
Pino, `@fastify/request-context`, and `@opentelemetry/api` are imported only under
`src/infrastructure/logging/**` and in the composition root. The **domain layer does not log at all**:
`Logger` lives in `src/application/shared/ports/logger.ts`, and the `domain-stays-pure` rule in
`.dependency-cruiser.cjs` (severity `error`) forbids any import from `^src/domain/` to
`^src/(application|infrastructure|presentation|config)/`, so a domain class that injected a logger would
fail `npm run arch`. There are zero `logger` references under `src/domain`. The concrete `PinoLogger` is
bound to the `logger` key in exactly one place, `src/composition/platform.ts` — the platform slice of
the composition root — which is also the only place the root Pino instance is published as `baseLogger`.
That is what lets `UserCreatedLogHandler` (application layer) log without importing a logging library,
and what lets `buildApp` (presentation layer) obtain a fully configured Fastify logger without knowing
how it was configured. Note the direction of the root instance itself: `createAppContainer` and
`createPlatformRegistrations` **receive** it as a parameter rather than importing an entry point or
reading a module-level global, so the composition root stays a pure function of its inputs and a test can
hand it a mock. The Loki aggregation path is entirely outside the TypeScript process: the app only writes
JSON to stdout, and the Docker/Grafana layer (Alloy, Loki, Grafana datasources) scrapes and stores it, so
no application code depends on Loki either.

| Component                                       | Layer            | Responsibility                                                                                                                                                                                                 | File                                                                                                      |
| ----------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Logger`                                        | Application      | Port: the `info`/`warn`/`error`/`debug` logging contract inner layers call                                                                                                                                     | `src/application/shared/ports/logger.ts`                                                                  |
| `ContextProvider`                               | Application      | Port: exposes the current request's `ContextData` (`getAll()`)                                                                                                                                                 | `src/application/shared/ports/context-provider.ts`                                                        |
| `ContextData`                                   | Application      | Shape of the per-request context carried alongside logs (`correlationId`)                                                                                                                                      | `src/application/shared/ports/context-provider.ts`                                                        |
| `PinoLogger`                                    | Infrastructure   | `Logger` adapter: enriches each call with context, forwards to Pino in `(object, message)` order                                                                                                               | `src/infrastructure/logging/pino-logger.ts`                                                               |
| `RequestContextProvider`                        | Infrastructure   | `ContextProvider` adapter over `@fastify/request-context` (`AsyncLocalStorage`)                                                                                                                                | `src/infrastructure/logging/request-context-provider.ts`                                                  |
| `createBaseLogger`                              | Infrastructure   | Builds the one root Pino instance (`FastifyBaseLogger`) every entry point starts from                                                                                                                          | `src/infrastructure/logging/create-base-logger.ts`                                                        |
| `createLoggerOptions`                           | Infrastructure   | Builds the Pino `LoggerOptions` — level, optional identity `base`, string-level formatter, redaction, trace mixin                                                                                              | `src/infrastructure/logging/logger-options.ts`                                                            |
| `REDACT_PATHS` / `REDACT_CENSOR`                | Infrastructure   | The sensitive-field redaction registry and its censor string                                                                                                                                                   | `src/infrastructure/logging/logger-options.ts`                                                            |
| `traceCorrelationMixin`                         | Infrastructure   | Pino `mixin` that injects `trace_id`/`span_id` from the active OTel span                                                                                                                                       | `src/infrastructure/logging/logger-options.ts`                                                            |
| `RequestContextData` augmentation               | Infrastructure   | Types the `contextData` slot on `@fastify/request-context` as `Partial<ContextData>`                                                                                                                           | `src/infrastructure/logging/request-context-data.d.ts`                                                    |
| `createPlatformRegistrations`                   | Composition root | Publishes the injected root logger as `baseLogger` and binds `PinoLogger` to the `logger` port                                                                                                                 | `src/composition/platform.ts`                                                                             |
| `createAppContainer`                            | Composition root | Takes the root logger as a required argument and builds the container every entry point shares                                                                                                                 | `src/container.ts`, `src/container-options.ts`                                                            |
| `toServiceIdentity` / `ServiceIdentity`         | Config           | Maps env (`OTEL_SERVICE_NAME`, `NODE_ENV`, `OTEL_SERVICE_VERSION`) to a `ServiceIdentity` `{ service, environment, version }`, which `createLoggerOptions` stamps as the base fields `service`/`env`/`version` | `src/config/service-identity.ts`                                                                          |
| `correlationIdPlugin` / `CORRELATION_ID_HEADER` | Presentation     | Fastify plugin that assigns and propagates the per-request correlation id                                                                                                                                      | `src/presentation/http/plugins/correlation-id.ts`                                                         |
| `buildApp`                                      | Presentation     | Hands `container.cradle.baseLogger` to Fastify as `loggerInstance`; sets `requestIdHeader`/`genReqId` and the `LogController`                                                                                  | `src/presentation/http/app.ts`                                                                            |
| Alloy pipeline                                  | Ops              | Scrapes container stdout, parses JSON, promotes `level`/`service` to labels, keeps `trace_id` as metadata, pushes to Loki                                                                                      | `docker/alloy/config.alloy`                                                                               |
| Loki store                                      | Ops              | Log store: filesystem backend, 7-day retention, structured metadata enabled                                                                                                                                    | `docker/loki/loki-config.yaml`                                                                            |
| Grafana datasources                             | Ops              | Bidirectional trace↔log links (Loki `TraceID` derived field; Tempo `tracesToLogsV2`)                                                                                                                           | `docker/grafana/provisioning/datasources/loki.yaml`, `docker/grafana/provisioning/datasources/tempo.yaml` |
| Compose services                                | Ops              | `loki` (`grafana/loki:3.7.6`) and `alloy` (`grafana/alloy:v1.18.1`) services; `alloy` `depends_on` `loki`                                                                                                      | `docker-compose.yml`                                                                                      |

## Public surface

This is a cross-cutting infrastructure feature. Application code programs against one port; entry
points and the HTTP layer program against the two cradle keys.

**`Logger`** — resolve as `logger` from the container (constructor injection by name). All methods
return `void` (fire-and-forget); the optional `data` object is merged into the structured output.

```ts
interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}
```

Note the shape of the error path. `data` is a plain `Record<string, unknown>`, so a port consumer
flattens the error itself and logs a string under an `error` key
(`error instanceof Error ? error.message : String(error)`, as in `in-process-domain-event-dispatcher.ts`,
`outbox-relay.ts`, and `job-worker.ts`), whereas code holding `baseLogger` passes the `Error` object
under Pino's `err` serializer key (`logger.error({ err }, 'message')`, as in `src/worker.ts` and
`graceful-shutdown.ts`), which Pino expands into a serialized `err` object with type, message, and
stack. The asymmetry follows from the port's shape rather than a stylistic preference: `err` is a Pino
serializer key, and the four-method port has no way to reach it. See
[Usage & extension](#usage--extension) for the port-side snippet.

**`ContextProvider`** — an injected dependency of the logger adapter (feature code rarely calls it
directly, since the correlation id is read implicitly through the logger).

```ts
interface ContextData {
  correlationId: string;
}

interface ContextProvider {
  getAll(): Partial<ContextData>;
}
```

**The two cradle keys.** Declared on the Awilix `Cradle` in `src/composition/platform.ts`; resolve
whichever one your consumer's type demands:

```ts
declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    baseLogger: FastifyBaseLogger;
    logger: Logger;
    clock: Clock;
    idGenerator: IdGenerator;
  }
}
```

Use `logger` from application-layer code (use cases, event handlers) and from infrastructure adapters.
Use `baseLogger` only where a Fastify/Pino-shaped logger is required, or when you genuinely need
`fatal`/`trace`, which the port deliberately omits. Three call sites require it today — and two of them
**name the option `logger`**, which makes the ES shorthand `{ logger }` a trap: it would resolve the
cradle's `Logger` port, the wrong key and a type error. Always spell the value out:

| Call site                                            | Option name      | Option type                                  | Pass                                          |
| ---------------------------------------------------- | ---------------- | -------------------------------------------- | --------------------------------------------- |
| `fastify(…)` inside `buildApp`                       | `loggerInstance` | `FastifyBaseLogger`                          | `loggerInstance: container.cradle.baseLogger` |
| [`buildHealthApp`](./health-checks.md)               | `logger`         | `FastifyBaseLogger`                          | `logger: container.cradle.baseLogger`         |
| [`registerGracefulShutdown`](./graceful-shutdown.md) | `logger`         | `Pick<FastifyBaseLogger, 'info' \| 'error'>` | `logger: container.cradle.baseLogger`         |

`buildApp` is the only code that actually reads the cradle key: `src/worker.ts` passes its module-level
root instance into the other two directly, and `src/main.ts` passes `app.log`. All three are the same
object.

**`createAppContainer`** — the single factory for the container, and the reason the two keys can never
disagree: the root logger is a required argument.

```ts
export function createAppContainer(baseLogger: FastifyBaseLogger): AwilixContainer<Cradle>;
```

**`BuildAppOptions`** — note what is _not_ here: `buildApp` accepts no logger, no logger options, and no
level. It reads the already-built instance out of the container it is given.

```ts
export interface BuildAppOptions {
  container: AwilixContainer<Cradle>;
  disableRequestLogging?: boolean;
  rateLimit?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance>;
```

**`createBaseLogger`** and **`toServiceIdentity`** — the pair every entry point uses to build the root
instance before the container exists:

```ts
export function createBaseLogger(level: string, identity?: ServiceIdentity): FastifyBaseLogger;

export interface ServiceIdentity {
  service: string;
  environment: string;
  version: string;
}
export function toServiceIdentity(config: {
  OTEL_SERVICE_NAME: string;
  NODE_ENV: string;
  OTEL_SERVICE_VERSION: string;
}): ServiceIdentity;
```

**`createLoggerOptions`** — the factory that produces the Pino configuration `createBaseLogger` uses.
`buildApp` does not take it; production code reaches it only through `createBaseLogger`, while tests
call it directly to assert the options it returns. Its exported redaction registry is the contract for
"what counts as sensitive":

```ts
export const REDACT_CENSOR = '[Redacted]';

export const REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
] as const;

export function createLoggerOptions(level: string, identity?: ServiceIdentity): LoggerOptions;
export function traceCorrelationMixin(): Record<string, string>;
```

Each entry is a Pino redaction path. A leading `*.` matches the field one level under any top-level key
(so `req.headers.authorization`, `body.password`, `res.refreshToken`, etc. are all covered), while the
bare form (`password`, `token`) covers the same key at the top level.

**`correlationIdPlugin`** exports the header constant it reads and writes:

```ts
export const CORRELATION_ID_HEADER = 'x-request-id' as const;
```

`buildApp` reuses this same constant as Fastify's `requestIdHeader`, so the header a client sends, the
id stored in context, and the header echoed on the response are all the same value. Two bounds of that
contract are worth stating explicitly:

- **The inbound header is client-supplied and unvalidated.** `genReqId` mints a `randomUUID()` only for
  the _absent_-header case; when a client does send `x-request-id`, Fastify adopts it verbatim. Ids can
  therefore be spoofed, repeated across requests, or arbitrary strings. Treat `correlationId` as a
  grouping hint, never as a trusted identifier or a uniqueness guarantee.
- **A browser client cannot read the echoed header cross-origin.** `fastifyCors` is registered as
  `{ origin: env.WEB_ORIGIN, credentials: true }` with no `exposedHeaders`, so `x-request-id` is not in
  the CORS-exposed set. A same-origin caller or a server-side client reads it fine; a cross-origin
  browser client must send its own id to know it.

## Configuration

This feature reads five env vars, validated by `envalid` in `src/config/env.ts`. There is **no
Loki-specific env var** — the collector's Docker socket and Loki's push endpoint
(`http://loki:3100/loki/api/v1/push`) are configured in the `docker/` infra files, not the app.

| Variable               | Default                       | Meaning                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`            | `info`                        | Minimum level Pino emits. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                                                                                                                                                                                                           |
| `APP_NAME`             | `app`                         | Identity prefix for the whole service. It derives `OTEL_SERVICE_NAME`'s default (`${APP_NAME}-api`) and therefore the `service` label on every line. Alloy's keep rule matches the compose **project** name literally (`regex = "app"`), so renaming the project means editing that regex too. |
| `OTEL_SERVICE_NAME`    | `app-api` (`${APP_NAME}-api`) | Stamped as `service` on every line and promoted to Loki's indexed `service` label. Shared with the tracing feature. **`docker-compose.yml` overrides it per service**: the `app` container gets `${APP_NAME:-app}-api`, the `worker` container `${APP_NAME:-app}-worker`.                      |
| `NODE_ENV`             | `development`                 | Stamped as `env` on every line. One of `development`, `test`, `production`. `main.ts` also derives Fastify's `disableRequestLogging` from it (`env.isDevelopment`), so the framework's automatic request lines are suppressed in development.                                                  |
| `OTEL_SERVICE_VERSION` | `0.0.0`                       | Stamped as `version` on every line.                                                                                                                                                                                                                                                            |

Because of the per-service `OTEL_SERVICE_NAME` override, **a running compose stack emits two `service`
values** — `app-api` and `app-worker` — under two `compose_service` labels, `app` and `worker`. A query
written against one of them silently misses the other half of the system; see the LogQL examples in
[Usage & extension](#usage--extension).

`LOG_LEVEL` accepts all six values — including `fatal` and `trace` — and sets the minimum threshold on
the root Pino instance. The `Logger` port itself intentionally exposes only the four middle levels
(`info`/`warn`/`error`/`debug`), so `fatal` and `trace` tune what Pino lets through rather than adding
methods a port consumer can invoke; code holding `baseLogger` can still call them.

All five values are read **once per process, at the entry point**, and turned into the root logger,
which then travels through the container. In `src/main.ts`:

```ts
const container = createAppContainer(createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env)));

const app = await buildApp({
  container,
  disableRequestLogging: env.isDevelopment,
});
```

`src/worker.ts` builds its own the same way and passes it to the same `createAppContainer`. Because
every path funnels through `createBaseLogger` → `createLoggerOptions`, redaction, identity stamping, the
string level, and the trace mixin are active everywhere — there is no way to obtain an un-redacted or
un-stamped logger from a real entry point. (The `identity` argument is optional purely so tests can call
`createBaseLogger('silent')` or `createLoggerOptions('info')` without a `base`. Note also that
`createBaseLogger` takes a plain `string` level, not the `LOG_LEVEL` union, which is what lets the
integration harness pass Pino's `'silent'` — a value `envalid` would reject.)

Whether `trace_id`/`span_id` actually appear on a line depends on whether an OpenTelemetry span is
active, which is governed by the `OTEL_*` variables (`OTEL_ENABLED` defaults to `false`). Those knobs
belong to the tracing feature; see [Tracing](./tracing.md). When tracing is off, the mixin contributes
nothing, and Loki's `trace_id` structured-metadata field is absent for those lines.

Two related knobs are code options rather than env vars:

- **Request access logging** is controlled by `buildApp`'s `disableRequestLogging` option (default
  `false`), which is passed straight into Fastify's `new LogController({ disableRequestLogging })`.
  `main.ts` sets it to `env.isDevelopment`, so Fastify's automatic `incoming request` /
  `request completed` / `request errored` lines are suppressed in development and enabled elsewhere.
  This does not affect logs your code emits through the `Logger` port. The worker's health app
  ([`buildHealthApp`](./health-checks.md)) hard-codes it to `true`, since liveness probes would
  otherwise flood the log.
- **Output format** is Pino's default sink: newline-delimited JSON to **stdout**. No pretty-printer
  (`pino-pretty`) and no network transport are configured, so shipping to Loki is a scraping concern
  (Alloy reads stdout via the Docker socket), not something the app does directly. Pipe stdout through a
  formatter locally if you want it colorized.

**Enabling / disabling Loki aggregation.** The app is unconditional: it always writes structured,
identity-stamped JSON to stdout, whether or not anything is collecting it. Aggregation is "on" when the
observability stack is running — `docker compose up` starts the `loki` and `alloy` services, and Alloy
auto-discovers the `app` containers over the Docker socket. It is "off" when those services are not
running (e.g. `npm run dev` on the host); the application is entirely unaffected and keeps logging to
stdout. Nothing in the app process needs to change to toggle it.

## Usage & extension

**Resolve and use the logger from a use case.** Feature classes receive `logger` by constructor
injection: the container runs in Awilix's `PROXY` mode, which hands the constructor a stand-in for the
cradle, so a class declares its dependencies simply by destructuring them by name. For that to happen at
all the class must itself be registered in one of the `src/composition/*.ts` modules — this handler is
bound with `asClass(UserCreatedLogHandler).singleton()` in `src/composition/events.ts`. Log a message
with structured fields; the correlation id — and, when a span is active, the trace/span id — are attached
for you. This is exactly what `UserCreatedLogHandler` does
(`src/application/user/events/user-created-log-handler.ts`):

```ts
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

interface UserCreatedLogHandlerDeps {
  logger: Logger;
}

export class UserCreatedLogHandler implements DomainEventHandler<UserCreatedEvent> {
  readonly eventName = UserCreatedEvent.EVENT_NAME;
  private readonly logger: Logger;

  constructor({ logger }: UserCreatedLogHandlerDeps) {
    this.logger = logger;
  }

  handle(event: UserCreatedEvent): Promise<void> {
    this.logger.info('User created', {
      aggregateId: event.aggregateId,
      email: event.email,
      occurredAt: event.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}
```

When this runs inside a traced HTTP request, the emitted line carries the caller's fields plus the
ambient identity, level string, Pino's `time`, the correlation id, and the trace ids automatically:

```json
{
  "level": "info",
  "time": 1755943200123,
  "service": "app-api",
  "env": "development",
  "version": "0.0.0",
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "b7ad6b7169203331",
  "aggregateId": "01J8Z2K9V1S5J1Q0S3H8W7N4M2",
  "email": "ada@example.com",
  "occurredAt": "2026-08-23T10:15:30.000Z",
  "correlationId": "8f3f9d0e-3b3f-4a3a-9b0e-2c1f5a7d9e11",
  "msg": "User created"
}
```

**Log a failure through the port.** The port takes no `Error` object, so flatten it at the call site
under an `error` key — the convention every port consumer in the repo follows
(`src/infrastructure/events/in-process-domain-event-dispatcher.ts`,
`src/infrastructure/events/outbox-relay.ts`, `src/infrastructure/jobs/job-worker.ts`):

```ts
try {
  await handler.handle(event);
} catch (error) {
  this.logger.error('Domain event handler failed', {
    eventName: event.eventName,
    aggregateId: event.aggregateId,
    error: error instanceof Error ? error.message : String(error),
  });
}
```

Code that holds `baseLogger` instead of the port uses Pino's `err` key, which serializes type, message,
and stack: `logger.error({ err }, 'shutting down after fatal error')`.

**Find those lines in Loki.** Once aggregation is running, query by the indexed labels and, if needed,
filter on the `trace_id` structured metadata — the last form is the same shape the Tempo→logs link uses:

```logql
{service="app-api", level="error"}
{service=~"app-.*", level="error"}
{compose_service="worker"} |= "Job dead-lettered"
{compose_service="app"} | trace_id = `0af7651916cd43dd8448eb211c80319c`
```

The first query covers the API process only. Because the compose stack runs the worker under
`OTEL_SERVICE_NAME=app-worker`, use the second form when you want both processes; worker lines also
carry `compose_service="worker"` rather than `"app"`, so any `compose_service`-scoped query must name
the process you mean. Grafana renders a **View Trace** link on each line (the Loki datasource's `TraceID`
derived field), so you can jump straight from a log to its Tempo trace and back.

**Redact a newly sensitive field.** If a new field could carry a secret or PII (personally identifiable
information) — say a `pin` on a request body — append both forms of its Pino path to `REDACT_PATHS` in
`src/infrastructure/logging/logger-options.ts`: the top-level form and the one-level-deep `*.` form, so
in this case `'pin', '*.pin'` after the existing `'*.secret'` entry (the full current array is listed in
[Public surface](#public-surface)). Nothing else changes: `createLoggerOptions` spreads `REDACT_PATHS`
into `redact.paths`, so every process starts censoring the field on its next line. Add a case to
`logger-options.test.ts` to lock the behaviour in.

**Add a new field to the request context.** To carry another piece of ambient data (e.g. an
authenticated `userId`) on every log line:

1. Extend `ContextData` in `src/application/shared/ports/context-provider.ts`:

   ```ts
   export interface ContextData {
     correlationId: string;
     userId: string;
   }
   ```

   Declaring the field as required here is safe, because the context slot is typed
   `Partial<ContextData>` (`src/infrastructure/logging/request-context-data.d.ts`) and
   `ContextProvider.getAll()` returns `Partial<ContextData>` too. A request that never sets `userId`
   simply logs without it; nothing is forced to populate the field.

2. Populate it where the value becomes known. The correlation id is set for every request in
   `correlationIdPlugin`'s `onRequest` hook. A value known only after authentication belongs in the
   `authenticate` decorator in `src/presentation/http/plugins/authenticate.ts`, immediately after the
   token verifies (or in a `preHandler` hook that runs after it) — merging into the existing object
   rather than replacing it:

   ```ts
   request.user = await accessTokenService.verify(token);
   requestContext.set('contextData', {
     ...requestContext.get('contextData'),
     userId: request.user.sub,
   });
   ```

3. Nothing else changes: `RequestContextProvider.getAll()` returns the whole object and `PinoLogger`
   spreads every field, so the new key appears on all subsequent log lines in that request. (To make it
   an _indexed_ Loki label rather than a plain field, also add it to `stage.labels` in
   `docker/alloy/config.alloy` — but only for low-cardinality values; a user id is not one.)

**Log from a new non-HTTP entry point (CLI script, standalone process).** There is no Fastify instance
to borrow `app.log` from, so build the root logger yourself and let the container publish both views of
it. `src/worker.ts` is the shape to copy; `src/scripts/sync-auth.ts` is not (it prints through
`console.*` and its output is neither structured nor redacted). Never construct a second `PinoLogger` by
hand:

```ts
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { env } from '@/config/env';
import { toServiceIdentity } from '@/config/service-identity';

const baseLogger = createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env));

async function main(): Promise<void> {
  const container = createAppContainer(baseLogger);

  try {
    container.cradle.logger.info('backfill started', { batchSize: 500 });
  } finally {
    await container.dispose();
  }
}

void main().catch((error: unknown) => {
  baseLogger.fatal({ err: error }, 'backfill failed');
  process.exit(1);
});
```

`container.cradle.logger` is the `Logger` port (four levels, `(message, data)` order); `baseLogger` is
the Pino instance itself, which is where `fatal` lives and which takes Pino's `(object, message)` order.
Both write to the same stream with the same redaction, identity, level, and trace mixin as the HTTP
server — so this process's stdout is Loki-ingestible on the same terms.

**Silence logging in a test.** Build the container with a silent root logger; everything resolved from
it — including the Fastify instance `buildApp` returns — inherits the level. That is what the
integration harness does (`test/integration/support/harness.ts`, with
`SILENT_LOG_LEVEL = 'silent'` from `test/integration/support/log-level.ts`):

```ts
const container = createAppContainer(createBaseLogger(SILENT_LOG_LEVEL));

const app = await buildApp({
  container,
  disableRequestLogging: true,
  rateLimit: false,
});
```

In a unit test, hand `createAppContainer` a `mock<FastifyBaseLogger>()` from `vitest-mock-extended`
instead, then assert on the mock's calls.

## Design decisions & trade-offs

- **One root Pino instance per process, owned by the container.** The entry point builds exactly one
  logger and hands it to `createAppContainer`; `buildApp` reads it back out as
  `container.cradle.baseLogger`. The alternative — `buildApp` accepting a `loggerOptions` object and
  constructing Fastify's logger itself, while the container built its own from the same factory — would
  mean two construction sites for the same concern. Nothing would type-check the two into agreement, so
  a level, a redaction path, or a service identity applied to one and not the other would be a silent,
  plausible bug: application logs redacted while framework logs were not, or two `service` values in
  Loki for one process. Making the instance a _required argument_ of `createAppContainer` turns "there is
  exactly one logger" into something the compiler enforces, and `src/container.test.ts` pins it. The cost
  is that building a container requires a logger first — every entry point and every test must produce
  one (a mock or `'silent'` in tests) — and that the container depends on a Fastify type.
- **Two cradle keys (`baseLogger` and `logger`), not one.** They are the same stream but different
  contracts. Registering only the port would leave Fastify, `buildHealthApp`, and
  `registerGracefulShutdown` without the Fastify-shaped logger they require, forcing each to rebuild a
  logger and reintroducing divergence. Registering only the raw logger would drag Pino's whole surface —
  and its `(object, message)` argument order — into the application layer, breaking the Dependency Rule.
  Publishing both, from one instance, at one place, lets each consumer take the narrowest type it can
  use; `registerGracefulShutdown` narrows furthest, declaring only
  `Pick<FastifyBaseLogger, 'info' | 'error'>`. The cost is a second key a reader must learn to
  distinguish; the rule of thumb is that `logger` is for code inside a layer and `baseLogger` is for
  framework plumbing.
- **Port-based logger so inner layers never import Pino.** `Logger` is a four-method interface in the
  application layer; only `PinoLogger` (infrastructure) and `src/composition/platform.ts` (composition
  root) know about Pino. This keeps the Dependency Rule intact — swapping the logging backend, or
  logging to a different sink in tests, is a one-line change in `src/composition/platform.ts` with no
  edits to application code, and the domain never sees a logger at all. The cost is a thin indirection
  layer and a deliberately minimal API (no child loggers, no per-call level, no bindings, no `err`
  serializer key) versus Pino's richer surface directly.
- **Scrape stdout with Alloy rather than push to Loki with a Pino transport.** The app writes only to
  stdout; a sidecar collector (Alloy) reads that stream off the Docker socket and forwards it to Loki.
  This keeps the application free of any Loki dependency, endpoint config, buffering, or back-pressure
  handling — if Loki is down or absent, the app is unaffected and its logs still go to stdout (the
  canonical place for a containerized process to log). The alternative, a `pino-loki` transport, would
  couple the process to Loki's availability and address, add a network path on the hot logging path, and
  break the "just write stdout" contract that also lets local `npm run dev` work with no observability
  stack at all. The cost is that aggregation only happens where a collector runs (compose/prod), not on
  a bare host.
- **`ContextProvider` (`AsyncLocalStorage`) instead of threading a logger through every call.** The
  correlation id is ambient request state; passing a request-bound logger (or the id itself) as a
  parameter through every use case, repository, and event handler would pollute signatures across the
  whole call graph purely for logging. Storing it in `AsyncLocalStorage` via `@fastify/request-context`
  lets any code — however deep — obtain it implicitly, so a single application-scoped `logger` singleton
  produces correctly-correlated lines. This is also why the port instance wraps the _root_ logger rather
  than Fastify's per-request child: correlation comes from the context, not from a binding, which is
  what lets the same singleton serve HTTP requests, worker jobs, and CLI scripts. The trade-off is the
  usual `AsyncLocalStorage` one: the enrichment is invisible in the call signature (a reader must know
  the mechanism exists), and code that escapes the async context — a `setTimeout`, or a job handler on a
  fresh execution — logs without a `correlationId`. That degradation is safe: `getAll()` returns `{}`
  rather than throwing, and across the worker boundary the trace context carried in the job payload
  takes over as the correlation key.
- **Redact at the Pino layer, from a shared registry, rather than sanitizing at call sites.** Secrets
  leak into logs most often through _automatic_ logging — Fastify serializing a request's `authorization`
  header, an error dump including a token — not through a developer deliberately logging a password.
  Configuring Pino's `redact` with a central `REDACT_PATHS` list censors those fields for **every**
  producer (framework and application alike) in one place, and the value never even reaches the JSON
  serializer, so it cannot reach stdout or, therefore, Loki. The alternative — trusting each caller to
  strip secrets before logging — fails the moment one caller forgets, and cannot cover Fastify's built-in
  logs at all. The cost is maintaining the path list as payload shapes evolve; `logger-options.test.ts`
  guards it, including a test that the raw secret value never appears anywhere in the serialized line.
- **`*.`-prefixed redaction paths to catch one level of nesting.** Sensitive fields appear both at the
  top level (`{ password }`) and nested under a container (`req.headers.authorization`, `body.password`,
  `res.headers['set-cookie']`). Listing both the bare and `*.`-prefixed forms covers the shapes the
  framework and use cases actually log without a deep wildcard, which Pino does not support and which
  would be more expensive to evaluate per line.
- **Inject trace context via a Pino `mixin` instead of stamping it in the adapter.** A `mixin` runs for
  every line the instance emits — including Fastify's automatic request logs — so trace correlation is
  uniform and the `PinoLogger` adapter stays ignorant of OpenTelemetry. The mixin reads the _active_ span
  (`trace.getActiveSpan()`) and validates its context, so it is a no-op when tracing is disabled or no
  span is in scope, adding `{}` rather than bogus zero ids. This is the seam that lets an operator jump
  from a log line to the distributed trace and back; see [Tracing](./tracing.md).
- **`level`/`service` as indexed labels; `trace_id` as structured metadata.** Loki charges for label
  cardinality: a label with unbounded distinct values (like a trace id, one per request) explodes the
  index and degrades the store. So the Alloy pipeline promotes only the low-cardinality `level` and
  `service` to indexed labels — the dimensions you routinely slice by — and keeps the high-cardinality
  `trace_id` as structured metadata, which is still queryable (`| trace_id = …`) for the trace↔log jump
  without paying the index cost. This is also why the level had to become a string (`formatters.level`):
  a numeric `30` is a poor label value.
- **Stamp identity via Pino `base` rather than per-call.** `service`/`env`/`version` are constant for the
  process lifetime, so putting them in `base` writes them once per line with zero per-call code and
  guarantees they are present on framework logs too. Deriving them from the existing `OTEL_SERVICE_NAME`
  / `NODE_ENV` / `OTEL_SERVICE_VERSION` (via `toServiceIdentity`) reuses the tracing feature's identity
  instead of inventing parallel `LOG_SERVICE_*` vars, so a service names itself once for both traces and
  logs — and the compose file's per-container override of `OTEL_SERVICE_NAME` splits API and worker
  logs apart for free.
- **Context fields win over caller data on key collision.** `withContext` spreads
  `this.context.getAll()` after the caller's `data`, so a value like `correlationId` cannot be
  accidentally (or maliciously) overwritten by a caller passing the same key. Ambient truth beats local
  input. Verified by the `context value wins over caller data` test.
- **`createLoggerOptions` kept as a separate function from `createBaseLogger`.** The options factory is
  pure data — a `LoggerOptions` object — which lets `logger-options.test.ts` assert level, redaction, and
  mixin wiring, and pipe real Pino output into an in-memory sink, without any process-level side effect.
  `createBaseLogger` is the one-line impure step (`pino(...)`) that production code calls.
- **`x-request-id` as the correlation header, reusing Fastify's request id.** Rather than inventing a
  parallel id, the plugin adopts Fastify's `request.id` — configured via `requestIdHeader` and `genReqId`
  to come from the client's `x-request-id` header or a fresh UUID. One id flows end to end: accepted from
  the client if present, generated otherwise, echoed on the response, stamped on every application log
  line as `correlationId`, and carried on Fastify's own lines as `reqId`, which makes correlation across
  an upstream proxy straightforward. The accepted-from-the-client half is what makes the id untrusted;
  that trade is spelled out in [Public surface](#public-surface).

## Testing

Unit tests live alongside the sources and run under Vitest:

- `src/infrastructure/logging/pino-logger.test.ts` — verifies the adapter calls the base logger in
  Pino's `(object, message)` argument order for every level; enriches `data` with context fields when a
  context is active; passes `data` through unchanged when the context is empty; lets context values win
  over caller data on key collision; and returns the context fields when `data` is `undefined`. It uses a
  mocked `FastifyBaseLogger` and a stub `ContextProvider`.
- `src/infrastructure/logging/logger-options.test.ts` — asserts `createLoggerOptions` sets the given
  level, wires `redact` from `REDACT_PATHS`/`REDACT_CENSOR`, and sets `mixin` to `traceCorrelationMixin`;
  drives `traceCorrelationMixin` through a real `AsyncLocalStorageContextManager` to confirm it returns
  `{}` with no active span, `{ trace_id, span_id }` for a valid span context, and `{}` for an
  all-zero/invalid span context; and pipes real Pino output to an in-memory sink to confirm that nested
  and top-level authorization headers, `set-cookie`, and `password`/`token`/`secret` fields are censored,
  that the raw secret never appears in the serialized line, and that non-sensitive fields are left
  untouched.
- `src/infrastructure/logging/request-context-provider.test.ts` — boots a real Fastify instance with
  `@fastify/request-context` and asserts `getAll()` returns the `ContextData` set in the current request
  scope, and `{}` when called outside any request context.
- `src/presentation/http/plugins/correlation-id.test.ts` — registers the plugin on a bare Fastify
  instance and asserts the `x-request-id` response header echoes `request.id`, that the same value is
  readable as `contextData.correlationId` inside the handler, and that two requests get distinct ids.
- `src/container.test.ts` — covers the composition guarantee this feature depends on. The case
  **"exposes the base logger it was built from"** asserts
  `createAppContainer(baseLogger).cradle.baseLogger` is the _same object_ that was passed in, which is
  what makes the root instance a single source of truth: since `buildApp` reads `cradle.baseLogger` into
  Fastify's `loggerInstance` and `PinoLogger` wraps that same object, Fastify's logger and the
  application's `Logger` provably cannot diverge. Sibling cases pin container isolation, override
  locality, and the shared container options.
- `src/composition/compose.test.ts` — builds every registration module (passing a
  `mock<FastifyBaseLogger>()` into `createPlatformRegistrations`) and asserts each cradle key is claimed
  exactly once and that the module key set matches the container's, so `baseLogger`/`logger` cannot be
  double-registered or silently dropped.

Integration tests (`test/integration/**`, run against real Docker-backed dependencies) exercise the
wiring end to end: `test/integration/support/harness.ts` and
`test/integration/app-bootstrap.int.test.ts` build the app through
`createAppContainer(createBaseLogger(SILENT_LOG_LEVEL))`, which is both the recommended way to silence
logs in tests and a standing check that `buildApp` works with a container-supplied logger and no logging
options of its own.

The Loki aggregation path is infrastructure configuration (Docker Compose, Alloy, Loki, and Grafana
provisioning under `docker/`), exercised by running the stack rather than by unit tests.

Run the whole unit suite:

```bash
npm test
```

Run only the logging suite:

```bash
npx vitest run src/infrastructure/logging
```

Run the integration suite (requires Docker):

```bash
npm run test:integration
```
