# Distributed Tracing

> **Status:** Complete · **Layers:** infrastructure, config · **Verified against:** `5156995`

## Purpose

Operators need to follow a single request as it fans out across process boundaries — through the HTTP
handler, the Prisma queries it triggers, and any background job it enqueues into the separate worker
process — and to pivot from a log line straight to the trace that produced it. This feature boots the
OpenTelemetry SDK in both the API and worker processes so that HTTP and Prisma are auto-instrumented
into spans (a span is a timed record of one operation, such as a single HTTP request or Prisma query)
that together form a trace (the tree of spans for one end-to-end request), exports those spans to an
OTLP (OpenTelemetry Protocol) collector, stamps every log line with the active `trace_id`/`span_id`,
and carries the trace across the asynchronous BullMQ job boundary. It is deliberately opt-in (off by
default) and, like the codebase's other process-lifecycle utilities, is **not** registered in
`src/container.ts` — the reasons for that are the heart of the design and are explained below.

## How it works

**Bootstrap (before anything else loads).** `src/instrumentation.ts` is a two-statement module whose
sole job is to call `startTracing()`. It is imported on the very first line of **both** process
entry points — `src/main.ts` (the API) and `src/worker.ts` (the job worker) — via
`import './instrumentation';`, ahead of every application module. In production the `start` and
`start:worker` npm scripts additionally preload the compiled module with
`node --import ./dist/instrumentation.js` before `dist/main.js` / `dist/worker.js`, so the SDK starts
before any module of the bundle is evaluated (`tsup.config.ts` builds `src/instrumentation.ts` as its
own entry for exactly this). `startTracing()` first checks its guards and returns early if the SDK is
already running, if `OTEL_ENABLED` is false, or if `env.isTest` is true. Otherwise it constructs a
`NodeSDK` with a resource describing the service (`service.name`, `service.version`, and
`deployment.environment.name` from `NODE_ENV`), an `OTLPTraceExporter` pointed at `/v1/traces` on
the origin of `OTEL_EXPORTER_OTLP_ENDPOINT` (see [Configuration](#configuration) — any path on the
configured value is replaced, not appended to), and an instrumentation set of
`getNodeAutoInstrumentations()` — with the `fs`, `net`, `dns`, and `pino` instrumentations explicitly
disabled — plus `new PrismaInstrumentation()`. It then calls `sdk.start()`, which monkey-patches the
relevant Node modules so that subsequent HTTP requests and Prisma queries emit spans automatically.
The started SDK is stashed in a process-global registry keyed by
`Symbol.for('finflow.observability.tracing')` so a second call is a no-op.

**Log correlation (every log line).** `createLoggerOptions(level, identity?)` in
`src/infrastructure/logging/logger-options.ts` sets `traceCorrelationMixin` as the Pino `mixin`. Pino
invokes the mixin on every log call; it reads `trace.getActiveSpan()` and, when the span context
passes `isSpanContextValid`, returns `{ trace_id, span_id }`, which Pino merges into the emitted
JSON. Both processes get it: `main.ts` builds the app with
`loggerOptions: createLoggerOptions(env.LOG_LEVEL, toServiceIdentity(env))` (which `buildApp` hands
to Fastify, so request logs are annotated too), and `worker.ts` logs through
`createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env))`, which wraps the same options. When
tracing is disabled or no span is active, the mixin returns `{}` and log lines are un-annotated —
nothing throws. The mixin is only one part of the logger setup; see
[Structured Logging](./structured-logging.md) for the identity fields, redaction rules, and Fastify
wiring it sits alongside.

**Job-boundary propagation (across the async hop).** BullMQ serializes a job's payload to Redis, and
the in-memory trace context does not survive that hop — least of all into a different process. So on
the producer side `BullMqJobQueue.enqueue` wraps the payload with `injectTraceContext(payload)`,
which serializes the active context into a W3C Trace Context carrier (the standard `traceparent`
string that conveys trace identity across a process boundary) and attaches it under the reserved
`__otelCarrier` key. On the consumer side `JobWorker.process` wraps the handler call in
`runWithExtractedContext(job.data, …)`, which re-establishes that context so the handler's spans
(and its logs) join the originating trace, and passes `stripTraceContext(job.data)` to the handler
so it never sees the transport key. See [Background Jobs](./background-jobs.md) for the queue and
worker that apply these helpers.

**Shutdown (both processes).** Neither entry point calls `shutdownTracing()` directly. Instead each
hands it to `registerGracefulShutdown` (in `src/infrastructure/lifecycle/graceful-shutdown.ts`) as
the optional `flushTelemetry` hook — `main.ts` alongside `dispose: () => app.close()`, `worker.ts`
alongside `dispose: createWorkerShutdown({ healthApp, container })`. On a termination signal or a
fatal error, `close-with-grace` runs the handler: it awaits `dispose()` first (so in-flight requests
and jobs finish and their spans end), then awaits `flushTelemetry()`, catching and logging any flush
error (`'telemetry flush failed'`) rather than letting it block shutdown — all within a 10-second
default grace window. `shutdownTracing()` flushes and stops the SDK and clears the registry; if the
SDK was never started it resolves immediately. See
[Graceful Shutdown](./graceful-shutdown.md) for the signal handling and timeout mechanics.

## Architecture

This feature is intentionally atypical for the codebase's clean-architecture layering: it defines
**no application-layer port and is not registered in `src/container.ts`**. There is no abstraction to
bind because nothing in the domain or application layers ever calls it — tracing is ambient
infrastructure that observes those layers from underneath rather than a dependency they invoke. It
initializes through a direct side-effecting import (`src/instrumentation.ts`) instead of through
dependency injection, because OpenTelemetry auto-instrumentation must patch modules like `http` and
Prisma **at load time**, before the container is even constructed (see Design decisions). Its two
correlation touch-points — the logging mixin and the job carrier — are plain functions imported
where they are used, not injected services; its shutdown rides the shared graceful-shutdown
lifecycle as an optional hook.

| Component                     | Layer          | Responsibility                                                                         | File                                                |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `startTracing()`              | Infrastructure | Boots the OTEL `NodeSDK` once, gated by `OTEL_ENABLED` and the test guard              | `src/infrastructure/observability/tracing.ts`       |
| `shutdownTracing()`           | Infrastructure | Flushes and stops the SDK; clears the registry; passed as `flushTelemetry` on shutdown | `src/infrastructure/observability/tracing.ts`       |
| `instrumentation.ts` (module) | Infrastructure | First import in `main.ts` and `worker.ts` (preloaded via `--import` in production)     | `src/instrumentation.ts`                            |
| `traceCorrelationMixin`       | Infrastructure | Pino `mixin` that adds `trace_id`/`span_id` to every log line                          | `src/infrastructure/logging/logger-options.ts`      |
| `injectTraceContext`          | Infrastructure | Producer side: envelopes a job payload with the active trace carrier                   | `src/infrastructure/jobs/job-trace-context.ts`      |
| `runWithExtractedContext`     | Infrastructure | Consumer side: restores the trace context around the job handler                       | `src/infrastructure/jobs/job-trace-context.ts`      |
| `stripTraceContext`           | Infrastructure | Consumer side: removes the carrier before the handler sees the payload                 | `src/infrastructure/jobs/job-trace-context.ts`      |
| `registerGracefulShutdown`    | Infrastructure | Runs `flushTelemetry` (i.e. `shutdownTracing`) after `dispose()` on shutdown           | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `OTEL_*` env keys             | Config         | Feature gate, resource identity, and exporter endpoint                                 | `src/config/env.ts`                                 |

## Public surface

There is no port and no container registration; consumers call these module functions directly.

**Bootstrap lifecycle** — `src/infrastructure/observability/tracing.ts`. `startTracing` is invoked
only from `instrumentation.ts`; `shutdownTracing` runs only as the `flushTelemetry` hook that
`main.ts` and `worker.ts` pass to `registerGracefulShutdown`. You should not normally call either
yourself.

```ts
export function startTracing(): void;
export function shutdownTracing(): Promise<void>;
```

**Log correlation** — `src/infrastructure/logging/logger-options.ts`. Wired as Pino's `mixin` by
`createLoggerOptions`; you consume it implicitly by logging through either process's logger.

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

The feature's own gate and identity are parsed by `envalid` in `src/config/env.ts`. Two additional
standard OpenTelemetry variables appear in `.env.example` and are read **natively by the SDK**, not
through `env.ts`.

| Variable                      | Default                 | Meaning                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_ENABLED`                | `false`                 | Master switch. When false, `startTracing()` returns early and no SDK is created. Parsed in `env.ts`.                                                                                                                                                                                                                                       |
| `OTEL_SERVICE_NAME`           | `finflow-api`           | Value of the `service.name` resource attribute on every span; also the `service` field on log lines. Parsed in `env.ts`.                                                                                                                                                                                                                   |
| `OTEL_SERVICE_VERSION`        | `0.0.0`                 | Value of the `service.version` resource attribute. Parsed in `env.ts`.                                                                                                                                                                                                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector endpoint. Only its **origin** is used: the exporter resolves `new URL('/v1/traces', endpoint)`, an absolute-path join, so `/v1/traces` replaces any path on the value (`http://collector:4318/otlp` → `http://collector:4318/v1/traces`). Set it to a bare origin such as `http://localhost:4318`. Parsed in `env.ts`. |
| `OTEL_TRACES_SAMPLER`         | _none in this repo_     | Sampler selection, read directly by the OTEL SDK from the environment. Absent from `env.ts`; `.env.example` ships `parentbased_traceidratio`, but nothing in this repo defaults it — left unset, the SDK applies its own spec default, `parentbased_always_on`.                                                                            |
| `OTEL_TRACES_SAMPLER_ARG`     | _none in this repo_     | Sampler argument — for a ratio sampler, the sample rate: `1.0` samples everything (dev); lower it in prod, e.g. `0.1`. Read directly by the OTEL SDK. Absent from `env.ts`; `1.0` is only the value shipped in `.env.example`.                                                                                                             |
| `NODE_ENV`                    | `development`           | Shared variable; its value populates the `deployment.environment.name` resource attribute. Parsed in `env.ts`.                                                                                                                                                                                                                             |

`env.isTest` (derived from `NODE_ENV === 'test'` by `envalid`) is also honored: even with
`OTEL_ENABLED=true`, `startTracing()` is a no-op under test so the SDK never starts during Vitest
runs.

## Usage & extension

**Turn tracing on.** Point a collector at the process and flip the gate:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=finflow-api
OTEL_SERVICE_VERSION=1.4.0
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=1.0
```

Restart both processes. Incoming HTTP requests and Prisma queries now produce spans automatically,
every log line gains `trace_id`/`span_id`, and jobs enqueued during a request continue the same
trace inside the worker — no code changes required. The `fs`, `net`, `dns`, and `pino`
auto-instrumentations are intentionally disabled in `startTracing()`, so those do not emit spans.

**Add a custom span around your own work.** Use the OpenTelemetry API directly; nested HTTP/Prisma
calls are captured as child spans automatically:

```ts
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('finflow');

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

**Add a new process entry point.** Follow the pattern both existing ones share: make
`import './instrumentation';` the first line, add the file to the `entry` array in `tsup.config.ts`,
start it in production with `node --import ./dist/instrumentation.js`, and pass
`flushTelemetry: shutdownTracing` to `registerGracefulShutdown`.

## Design decisions & trade-offs

- **No application port and no Awilix registration — on purpose.** Tracing has no consumer in the
  domain or application layers to inject into: it observes those layers from beneath rather than
  being called by them. Inventing a port would be an abstraction with exactly zero call sites. So
  the SDK is started by a direct side-effecting import instead of by the DI container, and the two
  correlation helpers are imported where used. This is the shape the codebase's other
  process-lifecycle utilities take too: `src/container.ts` imports nothing from
  `src/infrastructure/observability/tracing.ts`, and equally nothing from
  `src/infrastructure/lifecycle/` — `registerGracefulShutdown` (see
  [Graceful Shutdown](./graceful-shutdown.md)) and the `createLoggerOptions` / `createBaseLogger`
  factories are all wired by the entry points rather than by the container.
- **Load order is the real reason it bypasses the container.** OpenTelemetry auto-instrumentation
  works by monkey-patching module exports (the `http` module, the Prisma client) at import time — it
  can only instrument a module that has not been loaded yet. The Awilix container is built inside
  `buildApp` (API) or directly in `worker.ts`, which transitively imports the entire application
  graph (and thus `http` and Prisma) before any wiring runs. If tracing were a container service it
  would initialize _after_ those modules were already loaded and could no longer patch them. Making
  `instrumentation.ts` the first import in each entry file guarantees `sdk.start()` runs before the
  app graph loads in dev (`tsx watch`); in production the `start`/`start:worker` scripts go one step
  further and preload `dist/instrumentation.js` via `node --import`, which removes any dependence on
  import evaluation order inside the compiled bundle. The cost is a bare, side-effecting import that
  must be kept first; the benefit is correct instrumentation.
- **Idempotent process-global registry, keyed by a global symbol.** The started SDK is stored under
  `Symbol.for('finflow.observability.tracing')` on `globalThis` rather than in a module-level
  variable. This matters because the module can be evaluated more than once per process — the
  production `--import` preload and the bundle each carry their own copy of the module, and
  `tsx watch` reloads modules in dev — and separate module instances would each have their own
  module-level state, but they all share `globalThis`. A second `startTracing()` therefore returns
  early instead of starting a second SDK. `shutdownTracing()` clears the slot so a clean restart is
  possible.
- **Off by default (`OTEL_ENABLED=false`), and always off under test.** Most environments (local
  dev, CI) have no OTLP collector; starting the SDK there would mean failed export attempts and
  needless overhead. Opt-in per environment keeps the default path clean. The additional
  `env.isTest` guard ensures the SDK never starts during Vitest, keeping the test suite hermetic and
  free of background exporters — asserted directly by `tracing.test.ts`.
- **Noisy auto-instrumentations disabled.** `getNodeAutoInstrumentations` would by default emit a
  span for every filesystem call, socket connection, and DNS lookup; `startTracing()` turns off
  `@opentelemetry/instrumentation-fs`, `-net`, and `-dns` so traces stay at the level operators
  reason about (HTTP, Redis, Prisma), not syscall noise.
- **Manual log correlation via a Pino mixin, with the OTEL Pino instrumentation disabled.** Rather
  than let `@opentelemetry/instrumentation-pino` inject fields, that instrumentation is turned off
  and correlation is done by our own `traceCorrelationMixin`. This keeps the field names
  deterministic (`trace_id`, `span_id`), keeps ownership of the log shape in application code, and
  degrades cleanly: with tracing off the mixin returns `{}` instead of depending on an SDK that is
  not running. The shared Pino-mixin concern is covered from the logging side in
  [Structured Logging](./structured-logging.md).
- **In-payload carrier for the job boundary.** BullMQ persists job data to Redis, so the in-memory
  `AsyncLocalStorage` trace context cannot survive the enqueue→dequeue hop into the worker process.
  Serializing a W3C carrier into the payload under a reserved `__otelCarrier` key and re-extracting
  it on the worker is what lets a trace span the async boundary. The trade-off is one reserved key
  in the envelope; it is added only when a context is active and stripped before the handler runs,
  so handlers keep their clean payload and non-object payloads pass through untouched.
- **Shutdown rides the shared graceful-shutdown hook, and flushes last.** Both entry points pass
  `shutdownTracing` as `registerGracefulShutdown`'s optional `flushTelemetry` — they never call it
  directly. The ordering is deliberate: `dispose()` runs first so in-flight requests and jobs
  complete and their spans end before the SDK's final flush; a flush failure is caught and logged
  (`'telemetry flush failed'`), because losing the last batch of spans must never stall or fail a
  shutdown. Centralizing this in one lifecycle utility means a future entry point cannot forget the
  flush ordering. Details of the signal handling live in
  [Graceful Shutdown](./graceful-shutdown.md).
- **OTLP/HTTP exporter to a configurable endpoint.** The exporter URL is built as
  `new URL('/v1/traces', env.OTEL_EXPORTER_OTLP_ENDPOINT)` — an absolute-path join, so only the
  endpoint's origin is used and `/v1/traces` replaces any path the value carries
  (`http://collector:4318/otlp` resolves to `http://collector:4318/v1/traces`, not
  `.../otlp/v1/traces`, which diverges from the OTLP specification's append semantics). Configure
  the variable as a bare origin; the default `http://localhost:4318` (the OTLP/HTTP port) is exactly
  that, so any standard collector — the OpenTelemetry Collector, Jaeger, Tempo — works by pointing
  `OTEL_EXPORTER_OTLP_ENDPOINT` at it, with no code change. Sampling is likewise delegated to the
  SDK's native `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` environment variables rather than
  parsed in `env.ts` at all: they follow the OpenTelemetry specification exactly, and duplicating
  them would only invite drift.

## Testing

Unit tests run under Vitest; the SDK boot itself is verified only through its guards, because the
test environment deliberately never starts it. An integration test proves the trace survives a real
Redis round trip.

- `src/infrastructure/observability/tracing.test.ts` — asserts the environment guard holds
  (`env.isTest === true`) and that both `startTracing()` and `shutdownTracing()` are no-ops under
  test: `startTracing()` neither throws nor registers an SDK, and `shutdownTracing()` resolves
  cleanly even when the SDK was never started.
- `src/infrastructure/jobs/job-trace-context.test.ts` — installs a real
  `AsyncLocalStorageContextManager` and `W3CTraceContextPropagator`, then verifies the full
  inject/extract/strip cycle: `injectTraceContext` envelopes an object payload with a carrier whose
  `traceparent` contains the active trace id, returns the payload unchanged when no span is active,
  and leaves primitives untouched; `runWithExtractedContext` restores a context whose active-span
  trace id equals the injected one and runs the callback directly when there is no carrier;
  `stripTraceContext` removes the carrier, leaves a carrier-less payload by reference, tolerates a
  `null` carrier, and passes primitives through.
- `src/infrastructure/logging/logger-options.test.ts` — covers the correlation mixin: it returns
  `{ trace_id, span_id }` matching the active span context, `{}` when no span is active, and `{}`
  for an invalid all-zero span context; and confirms `createLoggerOptions` wires
  `traceCorrelationMixin` as the Pino `mixin`.
- `test/integration/jobs/job-tracing.int.test.ts` — starts a real Redis via Testcontainers, enqueues
  through `BullMqJobQueue` inside an active span, and asserts the handler run by `JobWorker` observes
  the same `traceId` and receives the payload with the carrier already stripped.

Run the unit suite:

```bash
npm test
```

Run just this feature's unit tests:

```bash
npx vitest run src/infrastructure/observability/tracing.test.ts src/infrastructure/jobs/job-trace-context.test.ts src/infrastructure/logging/logger-options.test.ts
```

Run the integration suite (requires Docker for Testcontainers):

```bash
npm run test:integration
```
