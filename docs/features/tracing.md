# Distributed Tracing

> **Status:** Complete · **Layers:** infrastructure, composition root, config · **Verified against:** `7150871`

## Purpose

Operators need to follow a single request as it fans out across process boundaries — through the HTTP
handler, the Prisma queries it triggers, and any background job it enqueues into the separate worker
process — and to pivot from a log line straight to the trace that produced it. A **span** is a timed
record of one operation, such as a single HTTP request or one Prisma query; a **trace** is the tree of
spans belonging to one end-to-end request. This feature boots the OpenTelemetry SDK in both the API
and worker processes so that HTTP, Redis, and Prisma work is auto-instrumented into spans, exports
those spans to an OTLP (OpenTelemetry Protocol) collector, stamps every log line with the active
`trace_id`/`span_id`, and carries the trace across the asynchronous BullMQ job boundary. It is
deliberately opt-in (off by default) and, unlike ordinary services, its bootstrap is **not** owned by
the composition root — the reasons for that are the heart of the design and are explained below.

## How it works

**Bootstrap, step 1 — load order.** `src/instrumentation.ts` is a two-statement module whose sole job
is to call `startTracing()`. `import './instrumentation';` must be the **first statement** of the
entry file — as it is in both `src/main.ts` (the API) and `src/worker.ts` (the job worker) — because
OpenTelemetry can only patch a module that has not been imported yet. If that import is moved down the
file, or an editor's "Organize Imports" re-sorts it, **nothing throws and nothing warns**: the process
boots normally and simply stops producing HTTP and Prisma spans. Nothing in the toolchain protects the
position either — `eslint.config.js` registers no import-order rule and `.prettierrc.json` has no
sorting plugin. In production the `start` and `start:worker` npm scripts remove the dependence on
source order altogether by preloading the compiled module —
`node --import ./dist/instrumentation.js dist/main.js`, and the same shape in the `Dockerfile` `CMD`
and in the `worker` service's `command` in `docker-compose.yml` — so the SDK starts before any module
of the bundle is evaluated. `tsup.config.ts` lists `src/instrumentation.ts` in its `entry` array for
exactly this reason.

**Bootstrap, step 2 — the guards.** `startTracing()` returns immediately, creating nothing, in three
cases: an SDK is already registered for this process, `OTEL_ENABLED` is false, or `env.isTest` is
true. The last one is unconditional — even with `OTEL_ENABLED=true`, the SDK never starts during a
Vitest run.

**Bootstrap, step 3 — what the SDK is configured with.** Past the guards, `startTracing()` constructs
a `NodeSDK` with three things. A **resource** — OpenTelemetry's term for the set of attributes
identifying the emitting service, stamped on every span it produces — built from `service.name`
(`OTEL_SERVICE_NAME`), `service.version` (`OTEL_SERVICE_VERSION`), and `deployment.environment.name`
(`NODE_ENV`). An `OTLPTraceExporter` pointed at `/v1/traces` on the origin of
`OTEL_EXPORTER_OTLP_ENDPOINT` (see [Configuration](#configuration) — any path on the configured value
is replaced, not appended to). And an instrumentation set of `getNodeAutoInstrumentations()` — with
`@opentelemetry/instrumentation-fs`, `-net`, `-dns`, and `-pino` explicitly disabled — plus
`new PrismaInstrumentation()`. Of the auto-instrumentations that remain, four actually fire against
this stack: `-http` (every Fastify request and outbound `http`/`https` call), `-ioredis` (the client
behind BullMQ, rate limiting, and idempotency — the source of the Redis spans in a trace), `-undici`
(global `fetch`), and `-runtime-node`, whose output is runtime metrics rather than spans;
`PrismaInstrumentation` supplies the database spans. The rest of the catalogue (`-express`, `-koa`,
`-pg`, `-mysql2`, `-mongodb`, …) is enabled but matches no module this service loads, so it costs a
patch attempt and emits nothing. `startTracing()` then calls `sdk.start()`, which monkey-patches the
relevant modules so that subsequent requests and queries emit spans automatically, and stashes the
SDK in a process-global registry keyed by `Symbol.for(appIdentity.tracingRegistryKey)` —
`app.observability.tracing` under the default `APP_NAME` — so a second call is a no-op.

**Export is asynchronous, so an unreachable collector is invisible.** `NodeSDK`'s default
`BatchSpanProcessor` buffers finished spans and exports them on a background interval, off the request
path. A refused or timed-out OTLP POST is therefore retried or dropped inside the exporter and
surfaces only on OpenTelemetry's `diag` channel: request handling, job processing, and log correlation
are unaffected. Spans still exist in-process, so `trace_id`/`span_id` keep appearing on log lines even
while nothing is being received — a correlated log line is not evidence that the collector is up. The
one place the failure becomes visible is shutdown, where `shutdownTracing()`'s final flush against a
dead collector is bounded by `registerGracefulShutdown`'s 10-second `close-with-grace` delay and its
rejection is caught and logged as `'telemetry flush failed'`.

**Log correlation (every log line).** `createLoggerOptions(level, identity?)` in
`src/infrastructure/logging/logger-options.ts` sets `traceCorrelationMixin` as the Pino `mixin`. Pino
invokes the mixin on every log call; it reads `trace.getActiveSpan()` and, when the span context
passes `isSpanContextValid`, returns `{ trace_id, span_id }`, which Pino merges into the emitted
JSON. Both processes get it, through a single mixin-bearing Pino instance each. `src/main.ts` builds
that instance with `createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))` — a thin
`pino(createLoggerOptions(level, identity))` wrapper — and passes it to `createAppContainer(baseLogger)`,
which registers it as the `baseLogger` **cradle** value in `createPlatformRegistrations` (the cradle is
Awilix's proxy of resolved registrations, read as `container.cradle.<key>`). `buildApp` then reads it
back out as `loggerInstance: container.cradle.baseLogger`, so Fastify's own request logs, `app.log`,
and the application-layer `Logger` port (`PinoLogger`, constructed over that same `baseLogger`) all
emit through the one instance that carries the mixin. `src/worker.ts` follows the same shape with a
module-level `logger` built by `createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))`, handed to
both `createAppContainer(logger)` and `buildHealthApp({ logger, … })`. When tracing is disabled or no
span is active, the mixin returns `{}` and log lines are un-annotated — nothing throws. The mixin is
only one part of the logger setup; see [Structured Logging](./structured-logging.md) for the identity
fields, redaction rules, and Fastify wiring it sits alongside.

**Job-boundary propagation (across the async hop).** BullMQ serializes a job's payload to Redis, and
the in-memory trace context does not survive that hop — least of all into a different process. So on
the producer side `BullMqJobQueue.enqueue` wraps the payload with `injectTraceContext(payload)`,
which serializes the active context into a W3C Trace Context carrier (the standard `traceparent`
string that conveys trace identity across a process boundary) and attaches it under the reserved
`__otelCarrier` key. On the consumer side `JobWorker.process` wraps the handler call in
`runWithExtractedContext(job.data, …)`, which re-establishes that context so the handler's spans
(and its logs) join the originating trace, and passes `stripTraceContext(job.data)` to the handler so
it never sees the transport key. See [Background Jobs](./background-jobs.md) for the queue and worker
that apply these helpers.

**Shutdown (both processes).** Neither entry point calls `shutdownTracing()` directly. Instead each
hands it to `registerGracefulShutdown` (in `src/infrastructure/lifecycle/graceful-shutdown.ts`) as
the optional `flushTelemetry` hook — `main.ts` alongside `dispose: () => app.close()`, `worker.ts`
alongside `dispose: createWorkerShutdown({ healthApp, container })`. On a termination signal or a
fatal error, `close-with-grace` runs the handler: it awaits `dispose()` first (so in-flight requests
and jobs finish and their spans end), then awaits `flushTelemetry()`, catching and logging any flush
error (`'telemetry flush failed'`) rather than letting it block shutdown — all within a 10-second
default grace window. `shutdownTracing()` flushes and stops the SDK and clears the registry; if the
SDK was never started it resolves immediately. See [Graceful Shutdown](./graceful-shutdown.md) for
the signal handling and timeout mechanics.

## Architecture

This feature is intentionally atypical for the codebase's clean-architecture layering: it defines
**no application-layer port, and its bootstrap and shutdown are not container registrations**. There
is no abstraction to bind because nothing in the domain or application layers ever calls it — tracing
is ambient infrastructure that observes those layers from underneath rather than a dependency they
invoke. It initializes through a direct side-effecting import (`src/instrumentation.ts`) instead of
through dependency injection, because OpenTelemetry auto-instrumentation must patch modules like
`http` and Prisma **at load time**, before the container is constructed (see Design decisions). Its
job-boundary helpers are plain functions imported where they are used, not injected services, and its
shutdown rides the shared graceful-shutdown lifecycle as an optional hook. The one place tracing does
touch the composition root is indirect: the entry point builds the mixin-bearing Pino instance and
registers it as the `baseLogger` value, which is what makes `trace_id`/`span_id` appear on Fastify's
logs and on every `Logger`-port call alike.

| Component                        | Layer            | Responsibility                                                                                 | File                                                |
| -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `startTracing()`                 | Infrastructure   | Boots the OpenTelemetry `NodeSDK` once, gated by `OTEL_ENABLED` and the test guard             | `src/infrastructure/observability/tracing.ts`       |
| `shutdownTracing()`              | Infrastructure   | Flushes and stops the SDK; clears the registry; passed as `flushTelemetry` on shutdown         | `src/infrastructure/observability/tracing.ts`       |
| `instrumentation.ts` (module)    | Composition root | First import in `main.ts` and `worker.ts` (preloaded via `--import` in production)             | `src/instrumentation.ts`                            |
| `traceCorrelationMixin`          | Infrastructure   | Pino `mixin` that adds `trace_id`/`span_id` to every log line                                  | `src/infrastructure/logging/logger-options.ts`      |
| `createBaseLogger`               | Infrastructure   | Builds the single mixin-bearing Pino instance each process shares                              | `src/infrastructure/logging/create-base-logger.ts`  |
| `createPlatformRegistrations`    | Composition root | Registers that instance as the `baseLogger` cradle value, so Fastify and `PinoLogger` share it | `src/composition/platform.ts`                       |
| `injectTraceContext`             | Infrastructure   | Producer side: envelopes a job payload with the active trace carrier                           | `src/infrastructure/jobs/job-trace-context.ts`      |
| `runWithExtractedContext`        | Infrastructure   | Consumer side: restores the trace context around the job handler                               | `src/infrastructure/jobs/job-trace-context.ts`      |
| `stripTraceContext`              | Infrastructure   | Consumer side: removes the carrier before the handler sees the payload                         | `src/infrastructure/jobs/job-trace-context.ts`      |
| `registerGracefulShutdown`       | Infrastructure   | Runs `flushTelemetry` (i.e. `shutdownTracing`) after `dispose()` on shutdown                   | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `toServiceIdentity`              | Config           | Maps `OTEL_SERVICE_NAME` / `NODE_ENV` / `OTEL_SERVICE_VERSION` to the logger's identity fields | `src/config/service-identity.ts`                    |
| `appIdentity.tracingRegistryKey` | Config           | `APP_NAME`-derived key for the process-global SDK registry symbol                              | `src/config/app-identity.ts`                        |
| `OTEL_*` env keys                | Config           | Feature gate, resource identity, and exporter endpoint                                         | `src/config/env.ts`                                 |

## Public surface

There is no port and no container registration for tracing itself; consumers call these module
functions directly.

**Bootstrap lifecycle** — `src/infrastructure/observability/tracing.ts`. `startTracing` is invoked
only from `instrumentation.ts`; `shutdownTracing` runs only as the `flushTelemetry` hook that
`main.ts` and `worker.ts` pass to `registerGracefulShutdown`. You should not normally call either
yourself.

```ts
export function startTracing(): void;
export function shutdownTracing(): Promise<void>;
```

**Log correlation** — `src/infrastructure/logging/logger-options.ts`. Wired as Pino's `mixin` by
`createLoggerOptions`; you consume it implicitly by logging through either process's logger — the
injected `Logger` port, `app.log`, or the `baseLogger` cradle value itself.

```ts
export function traceCorrelationMixin(): Record<string, string>; // {} or { trace_id, span_id }
```

**Job-boundary propagation** — `src/infrastructure/jobs/job-trace-context.ts`. Already applied by
`BullMqJobQueue` (producer) and `JobWorker` (consumer); call these directly only when you build a new
transport that crosses an async boundary BullMQ does not cover.

```ts
export function injectTraceContext<TPayload>(payload: TPayload): TPayload;
export function runWithExtractedContext<TResult>(
  data: unknown,
  run: () => Promise<TResult>,
): Promise<TResult>;
export function stripTraceContext<TPayload>(data: TPayload): TPayload;
```

`injectTraceContext` returns primitives and `null` unchanged and only adds the `__otelCarrier` key
when a context is actually propagated; `runWithExtractedContext` runs the callback directly when the
payload carries no carrier; `stripTraceContext` returns a carrier-less payload by reference and
tolerates a `null` carrier.

## Configuration

The feature's own gate and identity are parsed by `envalid` in `src/config/env.ts`. The remaining
variables are standard OpenTelemetry ones, read **natively by the SDK** rather than through `env.ts`.
The "compose value" notes give what `docker-compose.yml` sets, since the compose stack is the one
environment in this repo where tracing actually runs.

| Variable                              | Default                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_ENABLED`                        | `false`                     | Master switch. When false, `startTracing()` returns early and no SDK is created. Parsed in `env.ts`. **Compose value:** `'true'`, set once on the shared `x-app-environment` anchor, so both `app` and `worker` trace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OTEL_SERVICE_NAME`                   | `app-api` (from `APP_NAME`) | Value of the `service.name` resource attribute on every span; also the `service` field on log lines, via `toServiceIdentity`. Parsed in `env.ts`. **Compose value:** `<APP_NAME>-api` from the anchor, overridden to `<APP_NAME>-worker` on the `worker` service so the two deployables are distinguishable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `OTEL_SERVICE_VERSION`                | `0.0.0`                     | Value of the `service.version` resource attribute, and the `version` field on log lines. Parsed in `env.ts`. **Compose value:** `'1.0.0'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | `http://localhost:4318`     | OTLP/HTTP collector endpoint. **Must include a scheme.** `env.ts` parses it with envalid's `str()`, not `url()`, so nothing validates it; `startTracing()` then evaluates `new URL('/v1/traces', env.OTEL_EXPORTER_OTLP_ENDPOINT)`, and a scheme-less value (`localhost:4318`, `tempo:4318`, `//tempo:4318`, or an empty string) throws `TypeError: Invalid URL`. Because `src/instrumentation.ts` calls `startTracing()` unguarded at import time — before the container, before `createBaseLogger` — that kills the process at startup with a bare stack trace and no structured log line. Only the **origin** of a valid value is used: `/v1/traces` is an absolute-path join, so it replaces any path the value carries (`http://collector:4318/otlp` → `http://collector:4318/v1/traces`). Parsed in `env.ts`. **Compose value:** `http://tempo:4318`. |
| `OTEL_TRACES_SAMPLER`                 | _none in this repo_         | Sampler selection, read directly by the SDK from the environment. Absent from `env.ts`; `.env.example` ships `parentbased_traceidratio`, but nothing in this repo defaults it — left unset, the SDK applies its own spec default, `parentbased_always_on`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OTEL_TRACES_SAMPLER_ARG`             | _none in this repo_         | Sampler argument — for a ratio sampler, the sample rate: `1.0` samples everything (dev); lower it in prod, e.g. `0.1`. Read directly by the SDK. Absent from `env.ts`; `1.0` is only the value shipped in `.env.example`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OTEL_NODE_DISABLED_INSTRUMENTATIONS` | _unset_                     | Comma-separated package suffixes (`express,pg`) read natively by `getNodeAutoInstrumentations`, turning off auto-instrumentations **beyond** the four disabled in code. Not in `env.ts` or `.env.example`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OTEL_NODE_ENABLED_INSTRUMENTATIONS`  | _unset_                     | Setting it converts the default set into an **allow-list**: only the named suffixes load, and the library's own `defaultExcludedInstrumentations` (`-fs`, `-host-metrics`) stops being applied. Programmatic configuration wins over both `OTEL_NODE_*` variables, so the four entries `startTracing()` disables (`-fs`, `-net`, `-dns`, `-pino`) can never be re-enabled from the environment. Not in `env.ts` or `.env.example`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NODE_ENV`                            | `development`               | Shared variable; its value populates the `deployment.environment.name` resource attribute and the `env` field on log lines. Parsed in `env.ts`. **Compose value:** `production` for both processes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `APP_NAME`                            | `app`                       | Shared variable; supplies the default `OTEL_SERVICE_NAME` (`<APP_NAME>-api`) and the process-global registry key `<APP_NAME>.observability.tracing`. Parsed in `env.ts`, resolved eagerly in `src/config/app-identity.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                           | `info`                      | Not read by tracing, but it sits on the correlation path: `createBaseLogger(env.LOG_LEVEL, …)` fixes the root logger's level, and a call below that level is never emitted, so its `trace_id`/`span_id` never appears anywhere. Owned by [Structured Logging](./structured-logging.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`env.isTest` (derived from `NODE_ENV === 'test'` by `envalid`) is also honored: even with
`OTEL_ENABLED=true`, `startTracing()` is a no-op under test so the SDK never starts during Vitest
runs.

## Usage & extension

**See traces locally.** `docker compose up` already runs both processes with tracing on: the shared
`x-app-environment` anchor sets `OTEL_ENABLED: 'true'` and points `OTEL_EXPORTER_OTLP_ENDPOINT` at
`http://tempo:4318`, and the stack ships a `grafana/tempo:3.0.2` service — OTLP/HTTP receiver on
`4318`, query API on `3200`, configured by `docker/tempo/tempo.yaml` with 48-hour block retention —
that both `app` and `worker` `depends_on`. For `npm run dev`, bring the compose stack up (Tempo
publishes `4318` on the host), then set `OTEL_ENABLED=true` and keep the default
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Either way, open Grafana at
`http://localhost:3000` → **Explore** → **Tempo** — provisioned as the default datasource by
`docker/grafana/provisioning/datasources/tempo.yaml` — and search by `service.name = <APP_NAME>-api`
(or `<APP_NAME>-worker`). That same datasource configures `tracesToLogsV2` against Loki, so a span
links straight to the log lines carrying its `trace_id`; the log half of that jump is described in
[Structured Logging](./structured-logging.md).

**Turn tracing on elsewhere.** Point the process at a collector and flip the gate:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=app-api
OTEL_SERVICE_VERSION=1.4.0
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
```

Restart both processes. Incoming HTTP requests, Redis commands, and Prisma queries now produce spans
automatically, every log line gains `trace_id`/`span_id`, and jobs enqueued during a request continue
the same trace inside the worker — no code changes required. The `fs`, `net`, `dns`, and `pino`
auto-instrumentations are intentionally disabled in `startTracing()`, so those do not emit spans.

**Add a custom span around your own work.** Use the OpenTelemetry API directly; nested HTTP/Prisma
calls are captured as child spans automatically:

```ts
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('app');

export async function reconcileLedger(runReconciliation: () => Promise<void>): Promise<void> {
  await tracer.startActiveSpan('reconcileLedger', async (span) => {
    try {
      await runReconciliation();
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
```

**Propagate the trace across a new async boundary.** The BullMQ queue and worker already apply the
helpers, so ordinary jobs need nothing. If you build a _different_ transport that serializes a
payload and resumes it elsewhere (a custom Redis stream, an outbound webhook you later process,
etc.), mirror the same three calls:

```ts
import {
  injectTraceContext,
  runWithExtractedContext,
  stripTraceContext,
} from '@/infrastructure/jobs/job-trace-context';

// producer: attach the active context before serializing
await transport.send(injectTraceContext(payload));

// consumer: restore the context, then hand the clean payload to your handler
await runWithExtractedContext(received, () => handler(stripTraceContext(received)));
```

**Add a new process entry point.** Follow the pattern both existing ones share — first the
side-effecting import, then a base logger that carries the mixin, then the container built from it,
then the shutdown hook.

> **`import './instrumentation';` must stay the first statement of the file.** OpenTelemetry can only
> patch a module that has not been imported yet, and the imports below it pull in the application
> graph — `createAppContainer` alone drags in `http` and the Prisma client. Move the line, or let an
> editor's "Organize Imports" re-sort it, and nothing throws and no warning is logged: the process
> boots and silently stops producing HTTP and Prisma spans. No lint rule enforces the position —
> `eslint.config.js` has no import-order rule and `.prettierrc.json` no sorting plugin.

```ts
import './instrumentation';
import { env } from '@/config/env';
import { toServiceIdentity } from '@/config/service-identity';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { createAppContainer } from '@/container';
import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';
import { shutdownTracing } from '@/infrastructure/observability/tracing';

const logger = createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env));
const container = createAppContainer(logger);

registerGracefulShutdown({
  logger,
  dispose: () => container.dispose(),
  flushTelemetry: shutdownTracing,
});
```

Then add the file to the `entry` array in `tsup.config.ts` and start it in production with
`node --import ./dist/instrumentation.js dist/<name>.js`. Note the deliberate counter-example:
`src/scripts/sync-auth.ts` builds a base logger and container the same way but does **not** import
`./instrumentation`, because a short-lived one-shot CLI script has no trace worth exporting.

## Design decisions & trade-offs

- **No application port and no Awilix registration for tracing itself — on purpose.** Tracing has no
  consumer in the domain or application layers to inject into: it observes those layers from beneath
  rather than being called by them. Inventing a port would be an abstraction with exactly zero call
  sites. So the SDK is started by a direct side-effecting import instead of by the DI container, and
  the job-context helpers are imported where used. No file under `src/composition/` imports
  `src/infrastructure/observability/tracing.ts` or anything from `src/infrastructure/lifecycle/` — in
  production code only `main.ts`, `worker.ts`, and `instrumentation.ts` do.
- **The correlation-bearing logger, by contrast, _is_ a container value.** `createBaseLogger` is
  still called by the entry point (a logger must exist before the container that logs through it),
  but the resulting instance is registered as `baseLogger` in `createPlatformRegistrations` and
  consumed from the cradle by both `buildApp` (`loggerInstance: container.cradle.baseLogger`) and
  `PinoLogger`. One instance means one mixin: Fastify's request logs and application-layer
  `logger.info(...)` calls carry the same `trace_id`/`span_id` without a second configuration path
  that could drift.
- **Load order is the real reason the SDK bypasses the container.** OpenTelemetry
  auto-instrumentation works by monkey-patching module exports (the `http` module, the Prisma client)
  at import time — it can only instrument a module that has not been loaded yet. `createAppContainer`
  transitively imports the entire application graph (and thus `http` and Prisma) the moment the entry
  point calls it. If tracing were a container service it would initialize _after_ those modules were
  already loaded and could no longer patch them. Making `instrumentation.ts` the first import in each
  entry file guarantees `sdk.start()` runs before the app graph loads in dev (`tsx watch`); in
  production the `start`/`start:worker` scripts and the container images go one step further and
  preload `dist/instrumentation.js` via `node --import`, which removes any dependence on import
  evaluation order inside the compiled bundle. The cost is a bare, side-effecting import whose
  position is load-bearing but unenforced; the benefit is correct instrumentation.
- **Idempotent process-global registry, keyed by a global symbol.** The started SDK is stored under
  `Symbol.for(appIdentity.tracingRegistryKey)` on `globalThis` rather than in a module-level
  variable. This matters because the module can be evaluated more than once per process — the
  production `--import` preload and the bundle each carry their own copy of the module, and
  `tsx watch` reloads modules in dev — and separate module instances would each have their own
  module-level state, but they all share `globalThis`. A second `startTracing()` therefore returns
  early instead of starting a second SDK. `shutdownTracing()` clears the slot so a clean restart is
  possible.
- **Off by default (`OTEL_ENABLED=false`), and always off under test.** Most environments (local dev,
  CI) have no OTLP collector; starting the SDK there would mean failed export attempts and needless
  overhead. Opt-in per environment keeps the default path clean. The additional `env.isTest` guard
  ensures the SDK never starts during Vitest, keeping the test suite hermetic and free of background
  exporters — asserted directly by `tracing.test.ts`.
- **Noisy auto-instrumentations disabled, the rest left alone.** `getNodeAutoInstrumentations` would
  otherwise emit a span for every socket connection and DNS lookup, so `startTracing()` turns off
  `@opentelemetry/instrumentation-net` and `-dns` (and `-fs`, which
  `@opentelemetry/auto-instrumentations-node` already lists in its own
  `defaultExcludedInstrumentations` — belt and braces against a future version changing that
  default). Traces then sit at the level operators reason about: HTTP, Redis, Prisma. The remaining
  entries in the catalogue are left enabled rather than pruned to an explicit allow-list, because a
  patch that matches no loaded module costs nothing at runtime and an allow-list would need editing
  every time a dependency is added.
- **Manual log correlation via a Pino mixin, with the OpenTelemetry Pino instrumentation disabled.**
  Rather than let `@opentelemetry/instrumentation-pino` inject fields, that instrumentation is turned
  off and correlation is done by `traceCorrelationMixin`. This keeps the field names deterministic
  (`trace_id`, `span_id`), keeps ownership of the log shape in application code, and degrades
  cleanly: with tracing off the mixin returns `{}` instead of depending on an SDK that is not
  running. The `isSpanContextValid` check additionally suppresses the all-zero placeholder context,
  so a disabled or non-recording pipeline never writes meaningless ids. The shared Pino-mixin concern
  is covered from the logging side in [Structured Logging](./structured-logging.md).
- **In-payload carrier for the job boundary.** BullMQ persists job data to Redis, so the active trace
  context cannot survive the enqueue→dequeue hop into the worker process: OpenTelemetry keeps it in
  Node's `AsyncLocalStorage`, which is scoped to one process and one call chain. Serializing a W3C
  carrier into the payload under a reserved `__otelCarrier` key and re-extracting it on the worker is
  what lets a trace span the async boundary. The trade-off is one reserved key in the envelope; it is
  added only when a context is active and stripped before the handler runs, so handlers keep their
  clean payload and non-object payloads pass through untouched.
- **Shutdown rides the shared graceful-shutdown hook, and flushes last.** Both entry points pass
  `shutdownTracing` as `registerGracefulShutdown`'s optional `flushTelemetry` — they never call it
  directly. The ordering is deliberate: `dispose()` runs first so in-flight requests and jobs
  complete and their spans end before the SDK's final flush; a flush failure is caught and logged
  (`'telemetry flush failed'`), because losing the last batch of spans must never stall or fail a
  shutdown. Centralizing this in one lifecycle utility means a future entry point cannot forget the
  flush ordering. Details of the signal handling live in [Graceful Shutdown](./graceful-shutdown.md).
- **OTLP/HTTP exporter to a configurable endpoint.** The exporter URL is built as
  `new URL('/v1/traces', env.OTEL_EXPORTER_OTLP_ENDPOINT)` — an absolute-path join, so only the
  endpoint's origin is used and `/v1/traces` replaces any path the value carries
  (`http://collector:4318/otlp` resolves to `http://collector:4318/v1/traces`, not
  `.../otlp/v1/traces`, which diverges from the OTLP specification's append semantics). Configure the
  variable as a bare origin; the default `http://localhost:4318` (the OTLP/HTTP port) is exactly
  that, so any standard collector — the OpenTelemetry Collector, Jaeger, the Tempo instance in
  `docker-compose.yml` — works by pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at it, with no code change.
  Sampling is likewise delegated to the SDK's native `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`
  environment variables rather than parsed in `env.ts` at all: they follow the OpenTelemetry
  specification exactly, and duplicating them would only invite drift.

## Testing

Unit tests run under Vitest; the SDK boot itself is verified only through its guards, because the
test environment deliberately never starts it. An integration test proves the trace survives a real
Redis round trip.

- **Unit — `src/infrastructure/observability/tracing.test.ts`.** Asserts the environment guard holds
  (`env.isTest === true`) and that both `startTracing()` and `shutdownTracing()` are no-ops under
  test: `startTracing()` neither throws nor registers an SDK, and `shutdownTracing()` resolves
  cleanly even when the SDK was never started.

- **Unit — `src/infrastructure/jobs/job-trace-context.test.ts`.** Installs a real
  `AsyncLocalStorageContextManager` and `W3CTraceContextPropagator`, then verifies the full
  inject/extract/strip cycle: `injectTraceContext` envelopes an object payload with a carrier whose
  `traceparent` contains the active trace id, returns the payload unchanged when no span is active,
  and leaves primitives untouched; `runWithExtractedContext` restores a context whose active-span
  trace id equals the injected one and runs the callback directly when there is no carrier;
  `stripTraceContext` removes the carrier, leaves a carrier-less payload by reference, tolerates a
  `null` carrier, and passes primitives through.

- **Unit — `src/infrastructure/logging/logger-options.test.ts`.** Covers the correlation mixin: it
  returns `{ trace_id, span_id }` matching the active span context, `{}` when no span is active, and
  `{}` for an invalid all-zero span context; and confirms `createLoggerOptions` wires
  `traceCorrelationMixin` as the Pino `mixin`.

- **Unit — `src/infrastructure/lifecycle/graceful-shutdown.test.ts`.** The only suite exercising the
  `flushTelemetry` contract this feature's shutdown depends on. Mocking `close-with-grace` and
  capturing the registered callback, it asserts that a signal runs `dispose` and then
  `flushTelemetry`; that a **rejecting** `flushTelemetry` still leaves the shutdown resolved (the
  behaviour that stops a dead collector from blocking exit); that a missing `flushTelemetry` is
  skipped; and that the library is configured with the caller's `timeoutMs` as its `delay`.

- **Unit — `src/container.test.ts`.** Pins the wiring this feature depends on for log correlation:
  the container exposes the very `baseLogger` instance `createAppContainer` was built from, which is
  the instance `buildApp` hands to Fastify.

- **Integration — `test/integration/jobs/job-tracing.int.test.ts`.** Starts a real Redis via
  Testcontainers, enqueues through `BullMqJobQueue` inside an active span, and asserts the handler
  run by `JobWorker` observes the same `traceId` and receives the payload with the carrier already
  stripped.

Run the unit suite:

```bash
npm test
```

Run just this feature's unit tests:

```bash
npx vitest run \
  src/infrastructure/observability/tracing.test.ts \
  src/infrastructure/jobs/job-trace-context.test.ts \
  src/infrastructure/logging/logger-options.test.ts \
  src/infrastructure/lifecycle/graceful-shutdown.test.ts \
  src/container.test.ts
```

Run the integration suite (requires Docker for Testcontainers):

```bash
npm run test:integration
```
