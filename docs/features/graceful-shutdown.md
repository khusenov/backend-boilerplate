# Graceful Shutdown

> **Status:** Complete · **Layers:** infrastructure, presentation, composition root · **Verified against:** `5156995`

## Purpose

Both deployable processes hold long-lived resources — a Prisma connection pool, several `ioredis`
connections, a BullMQ queue, worker and scheduler — and both are constantly mid-flight: the API is
answering HTTP requests, the worker is processing jobs. When an orchestrator rolls a deployment it
sends `SIGTERM` and then, after a grace period, `SIGKILL`. Without a shutdown path the process dies
at the first signal: in-flight requests are cut off, a job in progress is left `active` until its
lock expires, and sockets are dropped rather than closed. This feature gives both entry points a
single, shared way to react to that signal — quiesce, release every resource, flush telemetry, and
exit under its own power before the orchestrator resorts to `SIGKILL`.

It is deliberately one utility used twice rather than two hand-rolled handlers, so a future entry
point cannot forget a step. This document is the authority on the shutdown sequence itself; see
[Tracing](./tracing.md) for what `shutdownTracing` does internally, [Background Jobs](./background-jobs.md)
for the queue/worker teardown it triggers, and [Health Checks](./health-checks.md) for the probes
that drive draining.

## How it works

**Registration.** Each entry point calls `registerGracefulShutdown`
(`src/infrastructure/lifecycle/graceful-shutdown.ts`) **once during bootstrap, before the process
starts accepting work** — in `src/main.ts` before `app.listen(...)`, in `src/worker.ts` before
`startWorker(container)`. The call takes a `logger`, a `dispose` callback, an optional
`flushTelemetry` hook, and an optional `timeoutMs`. It installs process listeners and returns
immediately; nothing else happens until a signal arrives.

**Signal handling.** Registration delegates to [`close-with-grace`](https://github.com/mcollina/close-with-grace)
(`^2.5.0`), invoked as `closeWithGrace({ delay: timeoutMs }, handler)`. The library installs
`process.once` listeners for eleven signals — `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGILL`, `SIGTRAP`,
`SIGABRT`, `SIGBUS`, `SIGFPE`, `SIGSEGV`, `SIGUSR2`, `SIGTERM` — for the two error events
`uncaughtException` and `unhandledRejection`, and for `beforeExit` (a normal exit once the event
loop empties). Any of them runs the same handler exactly once; the listeners are removed as soon as
shutdown starts, so a **second** signal or error during teardown short-circuits to `process.exit(1)`
instead of re-entering the handler.

**The handler.** The callback registered by `registerGracefulShutdown` does three things, in order:

1. **Log the reason.** With `err !== undefined` (an `uncaughtException` / `unhandledRejection`) it
   logs at error level: `'shutting down after fatal error'`. Otherwise it logs at info level with the
   signal attached: `logger.info({ signal }, 'shutting down')`.
2. **`await dispose()`** — the process-specific teardown, described below. This is the step that
   actually drains and releases resources, and it is awaited, so nothing after it runs until the
   process is quiet.
3. **`await flushTelemetry()`, if supplied** — wrapped in `.catch(...)` that logs
   `'telemetry flush failed'`. A rejecting flush is swallowed on purpose: telemetry export is the
   last thing that should be able to turn a clean shutdown into a failed one.

**Exit and the forced-exit timer.** `close-with-grace` races the handler against a `delay` timer
seeded from `timeoutMs`, which defaults to the module constant `DEFAULT_SHUTDOWN_TIMEOUT_MS`
(`10_000` ms). If the handler wins, the library exits `0` — or `1` when shutdown was triggered by an
error. If the **timer** wins, the library logs `killed by timeout (10000ms)` and calls
`process.exit(1)`: a stuck teardown cannot hang the process forever. If the handler _rejects_ — which
it can only do via `dispose()`, since the telemetry flush is caught — the library logs the error and
exits `1`.

**API process teardown** (`src/main.ts`). `dispose` is `() => app.close()`. Fastify's own close
sequence runs first: it marks the instance closing, closes the router, runs `preClose` hooks, and —
because `buildApp` sets `forceCloseConnections: true` (`src/presentation/http/app.ts`) — calls the
HTTP server's `closeAllConnections()`, destroying open sockets rather than waiting on them, before
`server.close()` stops accepting new connections. Only then do
the application's own `onClose` hooks run, and the relevant one belongs to `fastifyAwilixPlugin`,
registered with `disposeOnClose: true`: it calls `diContainer.dispose()`, which executes the
`.disposer(...)` of every singleton the process actually resolved. (Per-request scopes need no
attention here — `disposeOnResponse: true` already disposes each one when its response is sent.)

**Worker process teardown** (`src/worker.ts`). The worker owns its own Awilix container rather than
the shared `diContainer`, and has no business HTTP surface, so its teardown is written explicitly as
`createWorkerShutdown({ healthApp, container })` (`src/worker-shutdown.ts`). The returned closure
awaits `healthApp.close()` inside a `try` and `container.dispose()` inside the `finally`. The order
is the point: the probe app stops answering `/health/ready` **before** the Redis and database
connections that probe depends on are torn down, and the `finally` guarantees the container is
disposed even if closing the probe server fails or throws (the rejection still propagates, so
`close-with-grace` exits `1` — a failed shutdown is reported, not hidden).

**What container disposal actually releases.** Awilix runs the disposers of the resolved singletons
concurrently (`Promise.all`); only registrations that were resolved in that process are disposed, so
the API never tries to close a `jobWorker` it never created. Each disposer is declared next to its
registration in the composition module that owns it (`src/composition/**`):

| Registration                 | Disposer                  | Effect                                                                                                                          |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `prisma`                     | `client.$disconnect()`    | Closes the Prisma connection pool                                                                                               |
| `healthCheckRedisConnection` | `connection.disconnect()` | Drops the probe's dedicated Redis client                                                                                        |
| `rateLimitRedis`             | `connection.disconnect()` | Drops the rate-limiter's Redis client                                                                                           |
| `idempotencyRedis`           | `connection.disconnect()` | Drops the idempotency store's Redis client                                                                                      |
| `jobQueue`                   | `queue.close()`           | `BullMqJobQueue.close()` closes the BullMQ `Queue`, then quits the shared `redisConnection`                                     |
| `jobWorker`                  | `worker.close()`          | `JobWorker.close()` closes the BullMQ `Worker` — which waits for jobs currently being processed — then quits `workerConnection` |
| `jobScheduler`               | `scheduler.close()`       | `BullMqJobScheduler.close()` closes its `Queue` (it shares `redisConnection`)                                                   |
| `dashboardQueue`             | `queue.close()`           | Closes the `Queue` instance that backs Bull Board (it too shares `redisConnection`)                                             |

`redisConnection` and `workerConnection` are registered **without** a disposer on purpose: the
adapters that own them (`BullMqJobQueue`, `JobWorker`) call `connection.quit()` themselves, so adding
a disposer would quit an already-quit client.

**Telemetry, last.** Both entry points pass `flushTelemetry: shutdownTracing`
(`src/infrastructure/observability/tracing.ts`). Running it _after_ `dispose()` means spans produced
during teardown are still exported; `shutdownTracing` is a no-op when no SDK was started.

## Architecture

Shutdown is infrastructure with **no application-layer port**, and that is the design: nothing in
`domain/` or `application/` knows the process can stop. `registerGracefulShutdown` depends on no
framework and no container — its `logger` is the structural type `Pick<FastifyBaseLogger, 'info' | 'error'>`
and its teardown is an opaque `() => Promise<void>` — so it is a pure inward-facing utility that
neither Fastify nor Awilix leaks into. The composition root supplies the concrete meaning of "dispose":
`main.ts` hands it Fastify's `app.close()`, `worker.ts` hands it a purpose-built closure. Resource
teardown itself lives where resources are constructed — as `.disposer(...)` clauses in
`src/composition/**`, the only place concretes bind to ports — so adding a resource and adding its
teardown are one edit, not two.

| Component                                      | Layer            | Responsibility                                                                                           | File                                                |
| ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `registerGracefulShutdown`                     | Infrastructure   | Installs the signal/error handlers and runs log → dispose → flush under a timeout                        | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `GracefulShutdownOptions`                      | Infrastructure   | The contract an entry point fills in: logger, `dispose`, optional `flushTelemetry`, optional `timeoutMs` | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `DEFAULT_SHUTDOWN_TIMEOUT_MS`                  | Infrastructure   | Module-private default grace window (`10_000` ms)                                                        | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `createWorkerShutdown`                         | Composition root | Builds the worker's `dispose`: close the probe app, then dispose the container in a `finally`            | `src/worker-shutdown.ts`                            |
| `WorkerShutdownDependencies`                   | Composition root | Structural types the worker teardown needs — anything with `close()` / `dispose()`                       | `src/worker-shutdown.ts`                            |
| `bootstrap` (API)                              | Composition root | Registers shutdown with `dispose: () => app.close()` and `flushTelemetry: shutdownTracing`               | `src/main.ts`                                       |
| `bootstrap` (worker)                           | Composition root | Registers shutdown with `createWorkerShutdown({ healthApp, container })` before starting the worker      | `src/worker.ts`                                     |
| `registerDependencies`                         | Composition root | Declares the `.disposer(...)` for every disposable singleton                                             | `src/composition/**`, `src/container.ts`            |
| `fastifyAwilixPlugin` (`disposeOnClose: true`) | Presentation     | Bridges `app.close()` to `diContainer.dispose()` in the API process                                      | `src/presentation/http/app.ts`                      |
| `shutdownTracing`                              | Infrastructure   | The `flushTelemetry` hook: flushes and stops the OpenTelemetry SDK                                       | `src/infrastructure/observability/tracing.ts`       |
| `buildHealthApp`                               | Presentation     | The worker's probe server — the first thing `createWorkerShutdown` closes                                | `src/presentation/http/health-app.ts`               |

## Public surface

The contract another engineer programs against is one function plus its options type:

```ts
export interface GracefulShutdownOptions {
  logger: Pick<FastifyBaseLogger, 'info' | 'error'>;
  dispose: () => Promise<void>;
  flushTelemetry?: () => Promise<void>;
  timeoutMs?: number;
}

export function registerGracefulShutdown(options: GracefulShutdownOptions): void;
```

| Option           | Required | Meaning                                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `logger`         | yes      | Anything with `info` and `error` — a Fastify `app.log`, or the base Pino logger from `createBaseLogger` |
| `dispose`        | yes      | The process's teardown. Awaited; a rejection makes the process exit `1`                                 |
| `flushTelemetry` | no       | Run after `dispose`; its rejection is logged and swallowed                                              |
| `timeoutMs`      | no       | Grace window before a forced `process.exit(1)`. Defaults to `DEFAULT_SHUTDOWN_TIMEOUT_MS` (`10_000`)    |

The worker's teardown factory:

```ts
export interface WorkerShutdownDependencies {
  healthApp: { close(): Promise<unknown> };
  container: { dispose(): Promise<void> };
}

export function createWorkerShutdown(deps: WorkerShutdownDependencies): () => Promise<void>;
```

Observable behaviour a caller can rely on:

| Trigger                                    | Log line                                                  | Exit code |
| ------------------------------------------ | --------------------------------------------------------- | --------- |
| `SIGTERM` / `SIGINT` / any handled signal  | `shutting down` (info, with `{ signal }`)                 | `0`       |
| `beforeExit` (event loop empty)            | `shutting down` (info, `signal` undefined)                | `0`       |
| `uncaughtException` / `unhandledRejection` | `shutting down after fatal error` (error, with `{ err }`) | `1`       |
| Telemetry flush rejects                    | `telemetry flush failed` (error), shutdown continues      | unchanged |
| Teardown exceeds the grace window          | `killed by timeout (10000ms)` (from `close-with-grace`)   | `1`       |
| A second signal while shutting down        | `second <signal>, exiting` (from `close-with-grace`)      | `1`       |

## Configuration

**None.** This feature reads no environment variable — there is no `SHUTDOWN_*` key in
`src/config/env.ts` or `.env.example`. The grace window is a code-level constant,
`DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000` in `src/infrastructure/lifecycle/graceful-shutdown.ts`, and
neither entry point passes `timeoutMs`, so both processes run with the 10-second default.

Two deployment-side settings pair with it, both in `docker-compose.yml` on the `app` and `worker`
services:

- `stop_grace_period: 15s` — the window Docker allows between `SIGTERM` and `SIGKILL`. It is
  deliberately **longer** than the 10-second internal timeout, so the process always exits under its
  own control (and logs why) rather than being killed mid-teardown.
- `init: true` — runs an init process as PID 1 that forwards signals to Node. Without it, a Node
  process running as PID 1 would need to opt into default signal semantics itself.

## Usage & extension

**Adding a new entry point.** Register shutdown during bootstrap, before the process starts serving:

```ts
import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';
import { shutdownTracing } from '@/infrastructure/observability/tracing';

registerGracefulShutdown({
  logger,
  dispose: async () => {
    await server.close();
    await container.dispose();
  },
  flushTelemetry: shutdownTracing,
});
```

Two rules make this correct: put the network surface's `close()` **before** container disposal (stop
accepting work before removing what serves it), and make disposal unconditional — a `try`/`finally`,
as `createWorkerShutdown` does — so a failing close still releases connections.

**Adding a disposable resource.** Declare the teardown on the registration itself, in whichever
`src/composition/*.ts` module owns it; nothing else needs to change, because `container.dispose()`
already runs whatever is registered:

```ts
searchIndexClient: asFunction(() => createSearchIndexClient({ url: env.SEARCH_URL }))
  .singleton()
  .disposer((client) => client.close()),
```

Because disposers run concurrently, a disposer must not depend on another one having finished. If a
resource is _owned_ by an adapter that already closes it (the `redisConnection` / `BullMqJobQueue`
case), leave the connection registration without a disposer and let the owner close it.

**Shortening or lengthening the grace window.** Pass it explicitly at the call site:

```ts
registerGracefulShutdown({
  logger: app.log,
  dispose: () => app.close(),
  flushTelemetry: shutdownTracing,
  timeoutMs: 20_000,
});
```

Keep `stop_grace_period` in `docker-compose.yml` (and the equivalent
`terminationGracePeriodSeconds` in any Kubernetes manifest) above the new value.

**Verifying it by hand.** With the stack running, `docker compose stop app` should produce a
`shutting down` log line with `signal: "SIGTERM"` and an exit well inside 15 seconds. Locally,
`Ctrl-C` on `npm run dev:worker` takes the same path via `SIGINT`.

## Design decisions & trade-offs

- **`close-with-grace` instead of hand-written `process.on('SIGTERM', …)` handlers.** The library
  supplies the parts that are easy to get wrong: once-only listeners across eleven signals plus the
  two error events, second-signal escalation, and the forced-exit timer that races the teardown. The
  cost is a dependency and the fact that its own diagnostics (`killed by timeout`, `second SIGTERM,
exiting`) go to its default `console` logger — those two lines bypass
  [Structured Logging](./structured-logging.md) and appear unstructured. Our handler's own messages
  do go through the injected logger.
- **`dispose` is an opaque callback, not a container or app reference.** The two processes have
  genuinely different teardowns (`app.close()` cascades through Fastify's hooks; the worker has to
  order a probe server against a container it owns). Passing a closure keeps
  `registerGracefulShutdown` free of both Fastify and Awilix, which is what makes it unit-testable
  with plain mocks and reusable by a third entry point. The trade-off is that ordering correctness
  lives at the call site, so it is asserted there — `src/worker-shutdown.test.ts` pins the order.
- **Telemetry flushes last, and its failure is swallowed.** Flushing after `dispose()` captures spans
  emitted during teardown; catching the rejection means an unreachable OTLP collector cannot consume
  the grace window and get the process killed by the timeout instead of exiting cleanly. The cost is
  that the final spans of a shutdown may be silently lost — an acceptable trade for not blocking a
  deployment on the observability backend.
- **Awilix disposers as the single teardown registry, rather than a bespoke shutdown list.** Each
  resource's cleanup sits beside its construction in its composition module, and only what was resolved is
  disposed — so the API process disposes exactly its own working set. The cost is that Awilix runs
  disposers with `Promise.all`, giving **no ordering guarantee**; teardown must therefore be
  order-independent. Ordering that genuinely matters is expressed outside the container, in
  `createWorkerShutdown`.
- **Connection ownership is explicit rather than uniform.** `redisConnection` and `workerConnection`
  carry no `.disposer` because `BullMqJobQueue.close()` and `JobWorker.close()` quit them, while
  connections with no owning adapter (`healthCheckRedisConnection`, `rateLimitRedis`,
  `idempotencyRedis`) get an explicit `disconnect()` disposer. A uniform "every connection gets a
  disposer" rule would double-quit. See [Background Jobs](./background-jobs.md) for the queue side of
  this.
- **`forceCloseConnections: true` on the API app — bounded close over a perfect drain.** On current
  Node this routes to `server.closeAllConnections()`, so open sockets are destroyed rather than waited
  on; behind a load balancer holding keep-alive connections, the alternative is an `app.close()` that
  never resolves and gets killed by the timeout instead. The cost is real: a request still in flight
  at that instant has its socket cut. The mitigation is upstream, not in-process — the orchestrator
  should stop routing to the instance (readiness failure or endpoint removal) before it sends
  `SIGTERM`.
- **The worker closes probes before disposing.** Once the probe app is closed, `/health/ready` stops
  answering and the orchestrator drains the instance ([Health Checks](./health-checks.md)) — no
  window exists in which a probe reports ready while its Redis client is already disconnected. Note
  that neither process flips a "draining" flag _while_ still serving: shutdown closes the surface
  outright, so a rolling deploy relies on the orchestrator removing the endpoint, not on a 503 phase.
- **Not environment-configurable.** A grace window is a deployment invariant that must stay in sync
  with the platform's own kill timer; splitting it across an env var and `stop_grace_period` invites a
  configuration where the process is killed before it can finish. Keeping it in code means the two
  numbers are changed together, in one review.

## Testing

All three suites are unit tests (Vitest) with no external dependencies — the library, the container,
and the servers are mocked, so shutdown behaviour is asserted without actually killing a process.

| File                                                     | Covers                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/lifecycle/graceful-shutdown.test.ts` | Mocks `close-with-grace` and captures the registered callback. Asserts the library is configured as `{ delay: 7_000 }` when `timeoutMs` is passed; that a signal runs `dispose` then `flushTelemetry`; that a fatal `err` still logs via `logger.error` and still disposes; that a **rejecting** `flushTelemetry` leaves the shutdown resolved; and that a missing `flushTelemetry` is simply skipped |
| `src/worker-shutdown.test.ts`                            | Records call order to prove `healthApp.close()` precedes `container.dispose()`, and that a rejecting `healthApp.close()` still disposes the container while propagating the rejection                                                                                                                                                                                                                 |
| `src/start-worker.test.ts`                               | The counterpart start path: `jobWorker` is resolved and both recurring jobs (`OUTBOX_RELAY_JOB`, `DATA_RETENTION_JOB`) are scheduled with their interval constants — the resources whose teardown the disposers above are responsible for                                                                                                                                                             |

Run them:

```bash
npm test
```

Or just this feature:

```bash
npx vitest run src/infrastructure/lifecycle/graceful-shutdown.test.ts src/worker-shutdown.test.ts src/start-worker.test.ts
```
