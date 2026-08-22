# Structured Logging

> **Status:** Complete · **Layers:** application, infrastructure, presentation, config (+ ops/Docker for aggregation) · **Verified against:** `329a35a`

## Purpose

Structured logging emits each entry as a machine-parseable record of key/value fields — here one JSON
object per line — instead of a free-form text string, so entries can be filtered, correlated, and
indexed by field. Inner layers need to emit these diagnostic logs without depending on a concrete
logging library; every line produced while handling a request must be correlatable back to that request
(and, when tracing is active, back to the distributed trace it belongs to); and sensitive values must
never reach the log sink (the destination logs are written to — here, the container's stdout). This
feature satisfies those needs and ships the result to centralised search, completing the
metrics/traces/logs trio alongside the existing Tempo setup.

Concretely, it provides:

- a framework-agnostic `Logger` port that inner layers program against, implemented by a Pino-backed
  adapter — so the domain and application layers never import Pino;
- a per-request correlation id transparently attached to every line, so an operator can pivot from a
  single request id to every entry it produced;
- automatic injection of the active OpenTelemetry trace/span id, so an operator can jump from a Loki
  log line to the trace it belongs to and back;
- automatic redaction of sensitive fields, so secrets and PII (personally identifiable information)
  never leave the process in cleartext;
- a _service identity_ — the running process's name, environment, and version — stamped on every line,
  and the log level emitted as a string, so a Grafana Alloy collector can scrape the container's stdout
  and ship the lines into Grafana Loki for centralised search.

## How it works

The runtime flow has five concerns. The first four meet inside the Pino configuration and the logger
adapter, inside the process; the fifth ships the resulting stdout lines to Loki, out of process.

**1. Establishing the correlation id (per HTTP request).** Fastify is configured in `buildApp` to treat
the `x-request-id` header as the request id (`requestIdHeader: CORRELATION_ID_HEADER`) and to mint a
`randomUUID()` when the header is absent (`genReqId`). The `correlationIdPlugin` registers
`@fastify/request-context` and adds an `onRequest` hook that runs early, before route handlers and the
code that reads the id: it builds a `ContextData` object `{ correlationId: request.id }`, stores it in
the request-scoped context under the key `contextData`, and echoes the id back to the client in the
`x-request-id` response header. Because the hook runs first, the id is available to everything
downstream in that request. (The Fastify instance and plugin ordering are covered by
[HTTP Infrastructure](./http-infrastructure.md).)

**2. Making the id available deep in the call stack.** `@fastify/request-context` is backed by Node's
`AsyncLocalStorage`, so the stored `contextData` is visible anywhere within the same asynchronous
execution — a use case, a repository, a domain-event handler — without being passed as an argument.
`RequestContextProvider` (the `ContextProvider` adapter) reads it back with
`requestContext.get('contextData') ?? {}`.

**3. Emitting an enriched log line.** When any layer calls `logger.info(message, data)` on the injected
`Logger`, the `PinoLogger` adapter merges the caller's `data` with the current context via
`withContext`, which returns `{ ...data, ...this.context.getAll() }` — spreading `getAll()` last so
context fields (e.g. `correlationId`) win on key collision — then forwards to the underlying Pino logger
in Pino's `(mergingObject, message)` argument order. Pino serializes the result as one JSON line to
stdout.

**4. Cross-cutting enrichment applied by Pino itself.** The Pino instance is built from
`createLoggerOptions(level, identity?)`, which wires four behaviours that run on _every_ line regardless
of who emitted it:

- **`base` (service identity)** — when a `ServiceIdentity` is supplied, `{ service, env, version }` is
  stamped onto every line as base fields. Both real entry points supply one, so lines always carry
  `service` (e.g. `app-api`), `env` (e.g. `development`), and `version` (e.g. `0.0.0`). This is what
  lets Loki tell one service's logs apart and lets an operator filter by environment or release.
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

**5. Aggregating stdout into Loki (out of process).** The application never opens a socket to Loki —
there is no Pino transport or `pino-loki` target. It only writes newline-delimited JSON to stdout, and
Docker captures that stream. A **Grafana Alloy** collector (`docker/alloy/config.alloy`) does the rest:
it discovers every container over the Docker socket (`unix:///var/run/docker.sock`), keeps only this
compose project's containers (`com.docker.compose.project == app`) while dropping the observability
tools' own logs (`alloy|loki|grafana|tempo`, to avoid a self-feeding loop). That same
`discovery.relabel` stage also promotes each container's Docker compose service name to a
`compose_service` label and its container name to a `container` label — Docker-metadata labels, distinct
from the `service` value parsed out of the JSON body below. Alloy then tails their stdout/stderr and
runs a processing pipeline: `stage.json` extracts `level`, `service`, and `trace_id`; `stage.labels`
promotes the low-cardinality `level` and `service` to **indexed labels** (a label's _cardinality_ is the
number of distinct values it takes); `stage.structured_metadata` keeps the high-cardinality `trace_id`
as **structured metadata** (never a label, to avoid label explosion); then `loki.write` pushes the batch
to `http://loki:3100/loki/api/v1/push`. Non-JSON lines
(from mariadb, redis) pass through untouched. **Loki** (`docker/loki/loki-config.yaml`) stores the lines
on a filesystem backend with a 168h (7-day) retention window and `allow_structured_metadata: true`.
Finally, Grafana provisioning wires **bidirectional correlation**: the Loki datasource declares a
derived field `TraceID` (regex `"trace_id":"(\w+)"`) that links a log line out to its Tempo trace, and
the Tempo datasource's `tracesToLogsV2` links a trace back to its logs via the LogQL query
`{compose_service="app"} | trace_id = <traceId>` — selecting the app container by the Docker-derived
`compose_service` label (distinct from the `service="app-api"` label parsed from the JSON), then
filtering on the `trace_id` structured metadata.

Outside an HTTP request (for example the `sync-auth` CLI script), there is no active request context:
`getAll()` returns `{}`, so `withContext` passes the caller's `data` through unchanged and the line
carries no `correlationId`. Redaction, identity stamping, the string level, and the trace mixin still
apply, because the non-HTTP entry point builds its logger from the same `createLoggerOptions`. Nothing
throws.

## Architecture

The `Logger` and `ContextProvider` **ports** live in the application layer; their **adapters**
(`PinoLogger`, `RequestContextProvider`) live in infrastructure, and the request-scoped correlation id
is seeded in the presentation layer by `correlationIdPlugin`. Dependencies point inward: application and
domain code depend only on the `Logger` interface, never on Pino, `@fastify/request-context`, or
`@opentelemetry/api`. The concrete `PinoLogger` — wrapping a base Pino instance and a
`RequestContextProvider` — is bound to the `logger` port in exactly one place, `src/composition/platform.ts`. That
is what lets `UserCreatedLogHandler` (application layer) log without importing a logging library. The
Loki aggregation path is entirely outside the TypeScript process: the app only writes JSON to stdout,
and the Docker/Grafana layer (Alloy, Loki, Grafana datasources) scrapes and stores it, so no application
code depends on Loki either.

| Component                                       | Layer          | Responsibility                                                                                                                                                                                                 | File                                                                                                      |
| ----------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Logger`                                        | Application    | Port: the `info`/`warn`/`error`/`debug` logging contract inner layers call                                                                                                                                     | `src/application/shared/ports/logger.ts`                                                                  |
| `ContextProvider`                               | Application    | Port: exposes the current request's `ContextData` (`getAll()`)                                                                                                                                                 | `src/application/shared/ports/context-provider.ts`                                                        |
| `ContextData`                                   | Application    | Shape of the per-request context carried alongside logs (`correlationId`)                                                                                                                                      | `src/application/shared/ports/context-provider.ts`                                                        |
| `PinoLogger`                                    | Infrastructure | `Logger` adapter: enriches each call with context, forwards to Pino in `(object, message)` order                                                                                                               | `src/infrastructure/logging/pino-logger.ts`                                                               |
| `RequestContextProvider`                        | Infrastructure | `ContextProvider` adapter over `@fastify/request-context` (`AsyncLocalStorage`)                                                                                                                                | `src/infrastructure/logging/request-context-provider.ts`                                                  |
| `createLoggerOptions`                           | Infrastructure | Builds the Pino `LoggerOptions` — level, optional identity `base`, string-level formatter, redaction, trace mixin                                                                                              | `src/infrastructure/logging/logger-options.ts`                                                            |
| `REDACT_PATHS` / `REDACT_CENSOR`                | Infrastructure | The sensitive-field redaction registry and its censor string                                                                                                                                                   | `src/infrastructure/logging/logger-options.ts`                                                            |
| `traceCorrelationMixin`                         | Infrastructure | Pino `mixin` that injects `trace_id`/`span_id` from the active OTel span                                                                                                                                       | `src/infrastructure/logging/logger-options.ts`                                                            |
| `createBaseLogger`                              | Infrastructure | Builds a standalone Pino base logger (same options) for non-HTTP entry points                                                                                                                                  | `src/infrastructure/logging/create-base-logger.ts`                                                        |
| `RequestContextData` augmentation               | Infrastructure | Types the `contextData` slot on `@fastify/request-context`                                                                                                                                                     | `src/infrastructure/logging/request-context-data.d.ts`                                                    |
| `toServiceIdentity` / `ServiceIdentity`         | Config         | Maps env (`OTEL_SERVICE_NAME`, `NODE_ENV`, `OTEL_SERVICE_VERSION`) to a `ServiceIdentity` `{ service, environment, version }`, which `createLoggerOptions` stamps as the base fields `service`/`env`/`version` | `src/config/service-identity.ts`                                                                          |
| `correlationIdPlugin` / `CORRELATION_ID_HEADER` | Presentation   | Fastify plugin that assigns and propagates the per-request correlation id                                                                                                                                      | `src/presentation/http/plugins/correlation-id.ts`                                                         |
| Alloy pipeline                                  | Ops (Docker)   | Scrapes container stdout, parses JSON, promotes `level`/`service` to labels, keeps `trace_id` as metadata, pushes to Loki                                                                                      | `docker/alloy/config.alloy`                                                                               |
| Loki store                                      | Ops (Docker)   | Log store: filesystem backend, 7-day retention, structured metadata enabled                                                                                                                                    | `docker/loki/loki-config.yaml`                                                                            |
| Grafana datasources                             | Ops (Docker)   | Bidirectional trace↔log links (Loki `TraceID` derived field; Tempo `tracesToLogsV2`)                                                                                                                           | `docker/grafana/provisioning/datasources/loki.yaml`, `docker/grafana/provisioning/datasources/tempo.yaml` |
| Compose services                                | Ops (Docker)   | `loki` (`grafana/loki:3.3.0`) and `alloy` (`grafana/alloy:v1.5.0`) services; `alloy` `depends_on` `loki`, and `grafana` `depends_on` `tempo` and `loki`                                                        | `docker-compose.yml`                                                                                      |

## Public surface

This is a cross-cutting infrastructure feature; consumers program against two ports.

**`Logger`** — resolve as `logger` from the container. All methods return `void` (fire-and-forget); the
optional `data` object is merged into the structured output.

```ts
interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}
```

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

**`createLoggerOptions`** — the single factory that produces the Pino configuration used by both the
HTTP server and non-HTTP entry points. The optional `identity` adds the service `base`; its exported
redaction registry is the contract for "what counts as sensitive":

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

**`createBaseLogger`** and **`toServiceIdentity`** — the pair non-HTTP entry points use to build a
Pino logger with the same options and identity the server gets:

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

**`correlationIdPlugin`** exports the header constant it reads and writes:

```ts
export const CORRELATION_ID_HEADER = 'x-request-id' as const;
```

`buildApp` reuses this same constant as Fastify's `requestIdHeader`, so the header a client sends, the
id stored in context, and the header echoed on the response are all the same value.

## Configuration

This feature reads four env vars, validated by `envalid` in `src/config/env.ts`. There is **no
Loki-specific env var** — the collector's Docker socket and Loki's push endpoint
(`http://loki:3100/loki/api/v1/push`) are configured in the `docker/` infra files, not the app.

| Variable               | Default                     | Meaning                                                                                                               |
| ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`            | `info`                      | Minimum level Pino emits. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                                  |
| `OTEL_SERVICE_NAME`    | `app-api` (from `APP_NAME`) | Stamped as `service` on every line (and promoted to Loki's indexed `service` label). Shared with the tracing feature. |
| `NODE_ENV`             | `development`               | Stamped as `env` on every line. One of `development`, `test`, `production`.                                           |
| `OTEL_SERVICE_VERSION` | `0.0.0`                     | Stamped as `version` on every line.                                                                                   |

`LOG_LEVEL` accepts all six values — including `fatal` and `trace` — and sets the minimum threshold on
the underlying Pino instance. The `Logger` port itself intentionally exposes only the four middle levels
(`info`/`warn`/`error`/`debug`), so `fatal` and `trace` tune what Pino lets through rather than adding
methods a caller can invoke.

`LOG_LEVEL` and the three identity fields are read in `src/main.ts` and turned into a full Pino
configuration: `buildApp({ loggerOptions: createLoggerOptions(env.LOG_LEVEL, toServiceIdentity(env)) })`,
which becomes Fastify's `logger: opts.loggerOptions`. The same values flow to
`createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))` for non-HTTP entry points. Because both paths
call `createLoggerOptions`, redaction, identity stamping, the string level, and the trace mixin are
active everywhere — there is no way to obtain an un-redacted or un-stamped logger from a real entry
point. (The `identity` argument is optional purely so unit tests can call `createLoggerOptions('info')`
without a `base`.)

Whether `trace_id`/`span_id` actually appear on a line depends on whether an OpenTelemetry span is
active, which is governed by the `OTEL_*` variables (`OTEL_ENABLED` defaults to `false`). Those knobs
belong to the tracing feature; see [Tracing](./tracing.md). When tracing is off, the mixin contributes
nothing, and Loki's `trace_id` structured-metadata field is absent for those lines.

Two related knobs are code options rather than env vars:

- **Request access logging** is controlled by `buildApp`'s `disableRequestLogging` option. `main.ts`
  sets it to `env.isDevelopment`, so Fastify's automatic per-request `incoming request` /
  `request completed` lines are suppressed in development and enabled elsewhere. This does not affect
  logs your code emits through the `Logger` port.
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
injection (Awilix `PROXY` mode injects the `Cradle` object). Log a message with structured fields; the
correlation id — and, when a span is active, the trace/span id — are attached for you. This is exactly
what `UserCreatedLogHandler` does (`src/application/user/events/user-created-log-handler.ts`):

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
ambient identity, level string, correlation id, and trace ids automatically:

```json
{
  "level": "info",
  "service": "app-api",
  "env": "development",
  "version": "0.0.0",
  "msg": "User created",
  "aggregateId": "…",
  "email": "…",
  "occurredAt": "…",
  "correlationId": "…",
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "span_id": "b7ad6b7169203331"
}
```

**Find those lines in Loki.** Once aggregation is running, query by the indexed labels and, if needed,
filter on the `trace_id` structured metadata — this is the same shape the Tempo→logs link uses:

```logql
{service="app-api", level="error"}
{compose_service="app"} | trace_id = `0af7651916cd43dd8448eb211c80319c`
```

Grafana renders a **View Trace** link on each line (the Loki datasource's `TraceID` derived field), so
you can jump straight from a log to its Tempo trace and back.

**Redact a newly sensitive field.** If a new field could carry a secret or PII (say a `pin` on a request
body), add its Pino path to `REDACT_PATHS` in `src/infrastructure/logging/logger-options.ts` — the
top-level form and the one-level-deep `*.` form:

```ts
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
  'pin',
  '*.pin',
] as const;
```

Nothing else changes: `createLoggerOptions` spreads `REDACT_PATHS` into `redact.paths`, so both the HTTP
server and the CLI logger start censoring the field on their next line. Add a case to
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
2. Populate it where the value becomes known. The correlation id is set in `correlationIdPlugin`'s
   `onRequest` hook; a field known only after authentication would be merged in later, e.g.
   `requestContext.set('contextData', { ...requestContext.get('contextData'), userId })`.
3. Nothing else changes: `RequestContextProvider.getAll()` returns the whole object and `PinoLogger`
   spreads every field, so the new key appears on all subsequent log lines in that request. (To make it
   an _indexed_ Loki label rather than a plain field, also add it to `stage.labels` in
   `docker/alloy/config.alloy` — but only for low-cardinality values.)

**Log from a non-HTTP entry point (CLI script, standalone worker).** There is no Fastify instance to
supply `app.log`, so build a base logger from the same options and identity and wrap it in the same
adapters — this is what `src/scripts/sync-auth.ts` relies on through `registerDependencies`:

```ts
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { PinoLogger } from '@/infrastructure/logging/pino-logger';
import { RequestContextProvider } from '@/infrastructure/logging/request-context-provider';
import { toServiceIdentity } from '@/config/service-identity';
import { env } from '@/config/env';

const baseLogger = createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env));
const logger = new PinoLogger(baseLogger, new RequestContextProvider());
logger.info('worker started');
```

Because `createBaseLogger` routes through `createLoggerOptions`, this logger redacts sensitive fields,
stamps the service identity, emits the string level, and injects trace ids exactly like the HTTP
server's logger — so its stdout is Loki-ingestible on the same terms.

## Design decisions & trade-offs

- **Port-based logger so inner layers never import Pino.** `Logger` is a four-method interface in the
  application layer; only `PinoLogger` (infrastructure) and `src/composition/platform.ts` (composition root) know about
  Pino. This keeps the Dependency Rule intact — swapping the logging backend, or logging to a different
  sink in tests, is a one-line change in `src/composition/platform.ts` with no edits to domain or application code. The
  cost is a thin indirection layer and a deliberately minimal API (no child loggers, no per-call level,
  no bindings) versus Pino's richer surface directly.
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
  produces correctly-correlated lines. The trade-off is the usual `AsyncLocalStorage` one: the enrichment
  is invisible in the call signature (a reader must know the mechanism exists), and code that escapes the
  async context — e.g. a `setTimeout` or a job handler on a fresh execution — logs without a
  `correlationId`. That degradation is safe: `getAll()` returns `{}` rather than throwing.
- **Redact at the Pino layer, from a shared registry, rather than sanitising at call sites.** Secrets
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
  logs.
- **Context fields win over caller data on key collision.** `withContext` spreads
  `this.context.getAll()` after the caller's `data`, so a value like `correlationId` cannot be
  accidentally (or maliciously) overwritten by a caller passing the same key. Ambient truth beats local
  input. Verified by the `context value wins over caller data` test.
- **One `createLoggerOptions` for HTTP and non-HTTP.** Inside the server the `PinoLogger` wraps `app.log`
  (built from `opts.loggerOptions`); the `sync-auth` script wraps `createBaseLogger(level, identity)`.
  Both funnel through `createLoggerOptions(level, identity)`, guaranteeing identical level, redaction,
  identity, and trace correlation whether a line is emitted by a route handler or a CLI job.
  `createBaseLogger` exists only because entry points outside Fastify have no `app.log` to borrow.
- **`x-request-id` as the correlation header, reusing Fastify's request id.** Rather than inventing a
  parallel id, the plugin adopts Fastify's `request.id` — configured via `requestIdHeader` and `genReqId`
  to come from the client's `x-request-id` header or a fresh UUID. One id flows end to end: accepted from
  the client if present, generated otherwise, echoed on the response, and stamped on every log line,
  which makes correlation across an upstream proxy straightforward.

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

The Loki aggregation path is infrastructure configuration (Docker Compose, Alloy, Loki, and Grafana
provisioning under `docker/`), exercised by running the stack rather than by unit tests.

Run the whole suite:

```bash
npm test
```

Run only the logging suite:

```bash
npx vitest run src/infrastructure/logging
```
