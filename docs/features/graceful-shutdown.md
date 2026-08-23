# Graceful Shutdown

> **Status:** Complete · **Layers:** infrastructure, presentation, composition root · **Verified against:** `7150871`

## Purpose

Both deployable processes hold long-lived resources — a Prisma connection pool, several `ioredis`
connections, a BullMQ queue, worker and scheduler — and both are constantly mid-flight: the API is
answering HTTP requests, the worker is processing jobs. When an orchestrator rolls a deployment it
sends `SIGTERM` and then, after a grace period, `SIGKILL`. Without a shutdown path the process dies
at the first signal: in-flight requests are cut off, a job in progress is left `active` until its
lock expires, and sockets are dropped rather than closed. This feature gives the two long-running
entry points a single, shared way to react to that signal — quiesce, release every resource, flush
telemetry, and exit under their own power before the orchestrator resorts to `SIGKILL`. The
short-lived CLI scripts in `src/scripts/` deliberately opt out (see
[Design decisions](#design-decisions--trade-offs)).

It is deliberately one utility used twice rather than two hand-rolled handlers, so a future entry
point cannot forget a step. This document is the authority on the shutdown sequence itself; see
[HTTP Infrastructure](./http-infrastructure.md) for `buildApp` and the transport options it sets,
[Tracing](./tracing.md) for what `shutdownTracing` does internally,
[Background Jobs](./background-jobs.md) for the queue/worker teardown it triggers, and
[Health Checks](./health-checks.md) for the probes that drive draining.

## How it works

### Container ownership comes first

Every process builds its own Awilix container by calling `createAppContainer(baseLogger)`
(`src/container.ts`) — `src/main.ts`, `src/worker.ts` and the `src/scripts/sync-auth.ts` CLI all do
this, and so does every integration test, most via `createHarness`
(`test/integration/support/harness.ts`), a few calling `createAppContainer` directly. There is no
process-wide singleton container: `createAppContainer` calls
`createContainer<Cradle>(APP_CONTAINER_OPTIONS)` and returns a fresh instance each time, so _who
built the container_ is also _who is responsible for disposing it_. Everything below is about how
that responsibility is discharged.

`Cradle` is the Awilix **cradle**: the typed object whose properties are the container's
registrations, resolved on access (`container.cradle.prisma` constructs the Prisma client the first
time it is read, then returns the cached singleton). A "cradle key" is therefore a registration
name — `prisma`, `jobQueue`, `rateLimitRedis` — and it is the vocabulary the rest of this document
uses. `Cradle` itself is the interface `@fastify/awilix` exposes and this codebase augments; the
composition modules under `src/composition/**` declare the keys.

### Registration

Each entry point calls `registerGracefulShutdown`
(`src/infrastructure/lifecycle/graceful-shutdown.ts`) **once during bootstrap, before the process
starts accepting work** — in `src/main.ts` before `app.listen(...)`, in `src/worker.ts` before
`startWorker(container)`. The call takes a `logger`, a `dispose` callback, an optional
`flushTelemetry` hook, and an optional `timeoutMs`. It installs process listeners and returns
immediately; nothing else happens until a signal arrives.

Registration covers the **post-start** lifetime only. If bootstrap itself fails — `app.listen`
throwing in `src/main.ts`, `bootstrap()` rejecting in `src/worker.ts` — both entry points log and
call `process.exit(1)` directly. `process.exit()` emits no `beforeExit`, so the handler installed a
few lines earlier never runs and the partially built container is never disposed. The process is
about to die anyway and the OS reclaims its sockets, but no `shutting down` line appears and no
disposer executes; do not read a bootstrap crash as a clean teardown.

### Signal handling

Registration delegates to [`close-with-grace`](https://github.com/mcollina/close-with-grace)
(`^2.5.0`), invoked as `closeWithGrace({ delay: timeoutMs }, handler)`. The library installs
`process.once` listeners for eleven signals — `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGILL`, `SIGTRAP`,
`SIGABRT`, `SIGBUS`, `SIGFPE`, `SIGSEGV`, `SIGUSR2`, `SIGTERM` — for the two error events
`uncaughtException` and `unhandledRejection`, and for `beforeExit` (a normal exit once the event
loop empties). Any of them runs the same handler exactly once; the listeners are removed as soon as
shutdown starts, so a **second** signal or error during teardown short-circuits to `process.exit(1)`
instead of re-entering the handler.

`closeWithGrace` returns a `{ close, uninstall }` handle, and `registerGracefulShutdown` discards
it on purpose: registration is once-per-process and permanent, so there is no caller who could
legitimately un-install the handlers mid-life. That is also why the unit suite mocks the library
rather than driving it — with no handle to trigger, capturing the callback passed to the mock is the
only way to exercise the handler in-process.

### The handler

The callback registered by `registerGracefulShutdown` logs the reason, awaits `dispose()`, then
awaits `flushTelemetry()` if one was supplied — strictly in that order. The reason is logged at
error level with `'shutting down after fatal error'` when `err !== undefined` (an
`uncaughtException` / `unhandledRejection`), and otherwise at info level as
`logger.info({ signal }, 'shutting down')`.

Only the telemetry step is special: it is wrapped in a `.catch(...)` that logs
`'telemetry flush failed'`. A rejecting flush is swallowed on purpose — telemetry export is the last
thing that should be able to turn a clean shutdown into a failed one.

### Exit and the forced-exit timer

`close-with-grace` races the handler against a `delay` timer seeded from `timeoutMs`, which defaults
to the module constant `DEFAULT_SHUTDOWN_TIMEOUT_MS` (`10_000` ms). If the handler wins, the library
exits `0` — or `1` when shutdown was triggered by an error. If the **timer** wins, the library logs
`killed by timeout (10000ms)` and calls `process.exit(1)`: a stuck teardown cannot hang the process
forever. If the handler _rejects_ — which it can only do via `dispose()`, since the telemetry flush
is caught — the library logs the error and exits `1`.

### API process teardown (`src/main.ts`)

`bootstrap()` builds the container, passes it to `buildApp({ container, disableRequestLogging })`,
and registers `dispose: () => app.close()`. Fastify's own close sequence runs first: it marks the
instance closing, closes the router, runs `preClose` hooks, and — because `buildApp` sets
`forceCloseConnections: true` ([HTTP Infrastructure](./http-infrastructure.md)) — calls the HTTP
server's `closeAllConnections()`, destroying open sockets rather than waiting on them, before
`server.close()` stops accepting new connections. Only then do the application's own `onClose` hooks
run, and the relevant one belongs to `fastifyAwilixPlugin`. `buildApp` registers that plugin with
the **injected** container:

```ts
await app.register(fastifyAwilixPlugin, {
  container,
  disposeOnClose: true,
  disposeOnResponse: true,
  strictBooleanEnforced: true,
});
```

With `container` supplied, the plugin decorates the instance as `app.diContainer` with _that_ object
(it never falls back to the module-global container `@fastify/awilix` exports) and its
`disposeOnClose` hook calls `app.diContainer.dispose()` — i.e. it disposes the container the caller
built. Per-request scopes need no attention here: `disposeOnResponse: true` disposes each
`request.diScope` when its response is sent.

### The ownership contract this creates

Because `buildApp` requires the container as an argument and registers `fastifyAwilixPlugin` with
`disposeOnClose: true`, **a caller that builds a container and hands it to `buildApp` hands over its
lifecycle too — `app.close()` disposes it.** The rule generalises past `buildApp`: a container
handed to **any** Fastify app registered with `fastifyAwilixPlugin` and `disposeOnClose: true` is
owned by that app. The unit-test kit `registerTestContainer` (`test/unit/support/container.ts`)
takes exactly that shape — it builds its own container with
`createContainer<Cradle>(APP_CONTAINER_OPTIONS)`, bypassing `createAppContainer`, and registers it
on a bare Fastify instance with the same four plugin options — so a unit test that registers it also
tears down with nothing more than `app.close()`.

That is the whole shutdown story for the API process, and it is the reason every integration test
tears down with `await app.close()` in its `afterAll`: closing the app releases the Prisma pool and
every Redis client the test resolved. The corollary is two-sided — a container given to such an app
must not be disposed a second time by its builder, and a container that is _not_ given to one must
be disposed by its builder. That is exactly what `src/scripts/sync-auth.ts` does, wrapping its work
in `try { … } finally { await container.dispose(); }`.

### Worker process teardown (`src/worker.ts`)

The worker builds its container the same way the API does. What differs is its HTTP surface: the
health app from `buildHealthApp` (`src/presentation/http/health-app.ts`), a plain Fastify instance
with no Awilix plugin on it, so nothing disposes the container on its own. The worker therefore
composes teardown explicitly as `createWorkerShutdown({ healthApp, container })`
(`src/worker-shutdown.ts`). The returned closure awaits `healthApp.close()` inside a `try` and
`container.dispose()` inside the `finally`. The order is the point: the health app stops answering
`/health/ready` **before** the Redis and database connections that probe depends on are torn down,
and the `finally` guarantees the container is disposed even if closing the health app fails or
throws (the rejection still propagates, so `close-with-grace` exits `1` — a failed shutdown is
reported, not hidden).

### What container disposal actually releases

`AwilixContainer.dispose()` walks the container's resolution cache and runs the **disposers**
concurrently (`Promise.all`). A disposer is the callback attached to a registration with
`.disposer(fn)`; Awilix runs it, passing the resolved value, when the container that resolved it is
disposed. Only registrations that were resolved in that process are disposed, so the API never tries
to close a `jobWorker` it never created. Each disposer is declared next to its registration in the
composition module that owns it, and `createRegistrations` (`src/composition/compose.ts`) merges
those modules into the single map `createAppContainer` registers:

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

### Telemetry, last

Both entry points pass `flushTelemetry: shutdownTracing`
(`src/infrastructure/observability/tracing.ts`). Running it _after_ `dispose()` means spans produced
during teardown are still exported; `shutdownTracing` is a no-op when no SDK was started.

## Architecture

Shutdown is infrastructure with **no application-layer port**, and that is the design: nothing in
`domain/` or `application/` knows the process can stop. `registerGracefulShutdown` depends on no
framework and no container — its `logger` is the structural type `Pick<FastifyBaseLogger, 'info' | 'error'>`
and its teardown is an opaque `() => Promise<void>` — so it is a pure inward-facing utility that
neither Fastify nor Awilix leaks into. The composition root supplies the concrete meaning of
"dispose": `src/main.ts` hands it Fastify's `app.close()` (which cascades to
`app.diContainer.dispose()` through `fastifyAwilixPlugin`), `src/worker.ts` hands it a purpose-built
closure. Resource teardown itself lives where resources are constructed — as `.disposer(...)` clauses
in `src/composition/**`, the only place concretes bind to ports — so adding a resource and adding its
teardown are one edit, not two.

| Component                                      | Layer            | Responsibility                                                                                           | File                                                |
| ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `registerGracefulShutdown`                     | Infrastructure   | Installs the signal/error handlers and runs log → dispose → flush under a timeout                        | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `GracefulShutdownOptions`                      | Infrastructure   | The contract an entry point fills in: logger, `dispose`, optional `flushTelemetry`, optional `timeoutMs` | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `DEFAULT_SHUTDOWN_TIMEOUT_MS`                  | Infrastructure   | Module-private default grace window (`10_000` ms)                                                        | `src/infrastructure/lifecycle/graceful-shutdown.ts` |
| `createWorkerShutdown`                         | Composition root | Builds the worker's `dispose`: close the health app, then dispose the container in a `finally`           | `src/worker-shutdown.ts`                            |
| `WorkerShutdownDependencies`                   | Composition root | Structural types the worker teardown needs — anything with `close()` / `dispose()`                       | `src/worker-shutdown.ts`                            |
| `bootstrap` (API)                              | Composition root | Builds the container, hands it to `buildApp`, registers `dispose: () => app.close()`                     | `src/main.ts`                                       |
| `bootstrap` (worker)                           | Composition root | Builds the container, registers `createWorkerShutdown({ healthApp, container })` before starting work    | `src/worker.ts`                                     |
| `createAppContainer`                           | Composition root | The one entry point that builds a container: `createContainer` + `createRegistrations(baseLogger)`       | `src/container.ts`                                  |
| `APP_CONTAINER_OPTIONS`                        | Composition root | The container's `injectionMode` / `strict` settings, shared by every builder                             | `src/container-options.ts`                          |
| `createRegistrations`                          | Composition root | Merges the per-module maps that declare `.disposer(...)` for every disposable singleton                  | `src/composition/compose.ts`                        |
| `fastifyAwilixPlugin` (`disposeOnClose: true`) | Presentation     | Bridges `app.close()` to `app.diContainer.dispose()` on the **injected** container                       | `src/presentation/http/app.ts`                      |
| `shutdownTracing`                              | Infrastructure   | The `flushTelemetry` hook: flushes and stops the OpenTelemetry SDK                                       | `src/infrastructure/observability/tracing.ts`       |
| `buildHealthApp`                               | Presentation     | The worker's health app — the first thing `createWorkerShutdown` closes                                  | `src/presentation/http/health-app.ts`               |

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

The container side of the contract — build one, then either hand it to `buildApp` (which disposes it
on close) or dispose it yourself. `APP_CONTAINER_OPTIONS` is exported too, for the rare builder that
must construct a container without `createAppContainer` and still match production's resolution
semantics:

```ts
export const APP_CONTAINER_OPTIONS: {
  readonly injectionMode: typeof InjectionMode.PROXY;
  readonly strict: true;
};

export function createAppContainer(baseLogger: FastifyBaseLogger): AwilixContainer<Cradle>;

export interface BuildAppOptions {
  container: AwilixContainer<Cradle>;
  disableRequestLogging?: boolean;
  rateLimit?: boolean;
}

export function buildApp(options: BuildAppOptions): Promise<FastifyInstance>;
```

Observable behaviour a caller can rely on:

| Trigger                                    | Log line                                                                       | Exit code | Effect                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------- |
| `SIGTERM` / `SIGINT` / any handled signal  | `shutting down` (info, with `{ signal }`)                                      | `0`       | `dispose()` then `flushTelemetry()` run to completion                                        |
| `beforeExit` (event loop empty)            | `shutting down` (info, `signal` undefined)                                     | `0`       | The same handler, with no signal attached                                                    |
| `uncaughtException` / `unhandledRejection` | `shutting down after fatal error` (error, with `{ err }`)                      | `1`       | Teardown still runs in full before the exit                                                  |
| Telemetry flush rejects                    | `telemetry flush failed` (error)                                               | unchanged | Shutdown continues and completes normally                                                    |
| Teardown exceeds the grace window          | `killed by timeout (10000ms)` (from `close-with-grace`)                        | `1`       | Teardown is abandoned mid-flight                                                             |
| A second signal while shutting down        | `second <signal>, exiting` (from `close-with-grace`)                           | `1`       | Teardown is abandoned mid-flight                                                             |
| `await app.close()` (no signal involved)   | none from this feature                                                         | n/a       | The injected container is disposed by `fastifyAwilixPlugin`                                  |
| Bootstrap fails before serving             | `worker bootstrap failed` (fatal), or the raw listen error via `app.log.error` | `1`       | The handler is **not** run — `process.exit()` emits no `beforeExit`, so no disposer executes |

## Configuration

**None.** This feature reads no environment variable — there is no `SHUTDOWN_*` key in
`src/config/env.ts` or `.env.example`. The grace window is a code-level constant,
`DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000` in `src/infrastructure/lifecycle/graceful-shutdown.ts`, and
neither entry point passes `timeoutMs`, so both processes run with the 10-second default.

Two deployment-side settings pair with it, both set on the `app` and `worker` services in
`docker-compose.yml`:

- `stop_grace_period: 15s` — the window Docker allows between `SIGTERM` and `SIGKILL`. It is
  deliberately **longer** than the 10-second internal timeout, so the process always exits under its
  own control (and logs why) rather than being killed mid-teardown.
- `init: true` — runs an init process as PID 1 that forwards signals to Node. Without it, a Node
  process running as PID 1 would need to opt into default signal semantics itself.

## Usage & extension

**Adding a new entry point.** Build a container, build whatever network surface the process serves,
register shutdown during bootstrap before that surface starts listening, and dispose whatever the
framework will not dispose for you. This is `src/worker.ts` with its teardown inlined:

```ts
import './instrumentation';
import { env } from '@/config/env';
import { httpLimits } from '@/config/http-transport';
import { toServiceIdentity } from '@/config/service-identity';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { registerGracefulShutdown } from '@/infrastructure/lifecycle/graceful-shutdown';
import { shutdownTracing } from '@/infrastructure/observability/tracing';
import { buildHealthApp } from '@/presentation/http/health-app';

const logger = createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env));

async function bootstrap(): Promise<void> {
  const container = createAppContainer(logger);

  const healthApp = await buildHealthApp({
    healthCheck: container.cradle.healthCheck,
    metricsExposition: container.cradle.metricsExposition,
    metricsEnabled: env.METRICS_ENABLED,
    logger,
    hardening: { ...httpLimits, trustProxy: false },
  });

  registerGracefulShutdown({
    logger,
    dispose: async () => {
      try {
        await healthApp.close();
      } finally {
        await container.dispose();
      }
    },
    flushTelemetry: shutdownTracing,
  });

  await healthApp.listen({ host: env.HOST, port: env.WORKER_PORT });
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'bootstrap failed');
  process.exit(1);
});
```

That inline `dispose` is exactly what `createWorkerShutdown({ healthApp, container })` returns, so
in practice call the factory rather than re-writing the closure. Two rules make either form correct:
put the network surface's `close()` **before** container disposal (stop accepting work before
removing what serves it), and make disposal unconditional — a `try`/`finally` — so a failing close
still releases connections.

**If the new entry point is a full Fastify app**, use `buildApp` instead and let the ownership
contract do the work — `app.close()` already disposes the container, so disposing it again in your
own `dispose` would double-dispose:

```ts
const container = createAppContainer(logger);
const app = await buildApp({ container, disableRequestLogging: env.isDevelopment });

registerGracefulShutdown({
  logger: app.log,
  dispose: () => app.close(),
  flushTelemetry: shutdownTracing,
});
```

**Adding a disposable resource.** Declare the teardown on the registration itself, in whichever
`src/composition/*.ts` module owns it; nothing else needs to change, because `container.dispose()`
already runs whatever is registered:

```ts
searchIndexClient: asFunction(() => createSearchIndexClient({ url: env.SEARCH_URL }))
  .singleton()
  .disposer((client) => client.close()),
```

Then add its registration name (its cradle key) to `DISPOSABLE_KEYS` in
`src/composition/compose.test.ts`, which is the test that stops a connection-owning registration from
silently shipping without a disposer. Because disposers run concurrently, a disposer must not depend
on another one having finished. If a resource is _owned_ by an adapter that already closes it (the
`redisConnection` / `BullMqJobQueue` case), leave the connection registration without a disposer and
let the owner close it.

**Tearing down in a test.** A test that hands its container to a Fastify app owns nothing extra —
closing the app is the whole cleanup. In an integration suite that means the harness app:

```ts
const harness = await createHarness();

afterAll(async () => {
  await harness.app.close();
});
```

In a unit suite that needs a container behind a route handler, `registerTestContainer`
(`test/unit/support/container.ts`) builds one and registers it with the same `disposeOnClose: true`,
so the same single call cleans up:

```ts
const app = fastify({ logger: false });
await registerTestContainer(app, { metricsExposition: asValue(metricsExposition) });

afterEach(async () => {
  await app.close();
});
```

`src/presentation/http/routes/metrics-routes.test.ts` is the worked example.

A test or script that builds a container **without** an app must dispose it itself, the way
`src/scripts/sync-auth.ts` does.

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
  cost is a dependency and two unstructured log lines. `close-with-grace` accepts `logger`,
  `onTimeout` and `onSecondSignal` options that would route its own diagnostics anywhere we like;
  `registerGracefulShutdown` passes `{ delay: timeoutMs }` alone and takes the default
  `logger: console`, so `killed by timeout (…)` and `second <signal>, exiting` bypass
  [Structured Logging](./structured-logging.md) and appear as plain text. The alternative — wiring
  the Pino logger into all three — buys structured output for two lines that only ever appear on a
  failed shutdown, at the price of three more options to keep in sync. Our handler's own messages do
  go through the injected logger.
- **The `{ close, uninstall }` handle is discarded.** `closeWithGrace` returns one; nothing keeps it.
  Registration happens once per process during bootstrap and is meant to be permanent, so there is no
  legitimate caller for `uninstall()`, and `close()` would only duplicate what a real signal does.
  The consequence is that the handler cannot be triggered or removed from inside the process — which
  is precisely why `graceful-shutdown.test.ts` mocks the module and captures the callback instead of
  driving the real library.
- **The caller builds the container; the app it is handed to disposes it.** `buildApp` takes the
  container as a required `BuildAppOptions` field and sets `disposeOnClose: true`, so one object has
  one owner and `app.close()` is the single teardown verb for an API-shaped process. The alternative
  — the module-global `diContainer` that `@fastify/awilix` exports — would make every app in a
  process share one container, so parallel tests could not isolate their overrides. The cost is a
  rule a reader must know: never dispose a container you have already handed to such an app, and
  never forget to dispose one you have not. `src/container.test.ts` pins the isolation this buys (an
  override applied to one container does not leak into another).
- **Injection mode lives in `createContainer`, not in the plugin options.** `@fastify/awilix` rejects
  a registration that passes both `container` and `injectionMode` ("If you are passing pre-created
  container explicitly, you cannot specify injection mode") — a runtime error, not a type error. The
  settings therefore sit in one shared constant, `APP_CONTAINER_OPTIONS` in
  `src/container-options.ts`, so production and test containers cannot drift apart on
  `InjectionMode.PROXY` / `strict`.
- **`dispose` is an opaque callback, not a container or app reference.** The two processes have
  genuinely different teardowns (`app.close()` cascades through Fastify's hooks; the worker has to
  order a health app against a container it owns). Passing a closure keeps
  `registerGracefulShutdown` free of both Fastify and Awilix, which is what makes it unit-testable
  with plain mocks and reusable by a third entry point. The trade-off is that ordering correctness
  lives at the call site, so it is asserted there — `src/worker-shutdown.test.ts` pins the order.
- **Telemetry flushes last, and its failure is swallowed.** Flushing after `dispose()` captures spans
  emitted during teardown; catching the rejection means an unreachable OTLP collector cannot consume
  the grace window and get the process killed by the timeout instead of exiting cleanly. The cost is
  that the final spans of a shutdown may be silently lost — an acceptable trade for not blocking a
  deployment on the observability backend.
- **Awilix disposers as the single teardown registry, rather than a bespoke shutdown list.** Each
  resource's cleanup sits beside its construction in its composition module, and only what was
  resolved is disposed — so the API process disposes exactly its own working set. The cost is that
  Awilix runs disposers with `Promise.all`, giving **no ordering guarantee**; teardown must therefore
  be order-independent. Ordering that genuinely matters is expressed outside the container, in
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
  `SIGTERM`. The option itself belongs to [HTTP Infrastructure](./http-infrastructure.md), which owns
  every other Fastify server setting.
- **The worker closes its health app before disposing.** Once the health app is closed,
  `/health/ready` stops answering and the orchestrator drains the instance
  ([Health Checks](./health-checks.md)) — no window exists in which a probe reports ready while its
  Redis client is already disconnected. Note that neither process flips a "draining" flag _while_
  still serving: shutdown closes the surface outright, so a rolling deploy relies on the orchestrator
  removing the endpoint, not on a 503 phase.
- **Short-lived CLI scripts opt out.** `src/scripts/sync-auth.ts` and
  `src/scripts/purge-verification-jobs.ts` never call `registerGracefulShutdown`. They do a bounded
  unit of work and exit, releasing their resources in a `finally` — `container.dispose()` in the
  first, `queue.close()` and `connection.quit()` in the second. Installing signal handlers would add
  a second, redundant teardown path for a process whose whole lifetime is shorter than the grace
  window; the trade-off is that interrupting one with `Ctrl-C` mid-run leaves the `finally` unrun,
  which is acceptable for an operator-invoked script and would not be for a served process.
- **Not environment-configurable.** A grace window is a deployment invariant that must stay in sync
  with the platform's own kill timer; splitting it across an env var and `stop_grace_period` invites a
  configuration where the process is killed before it can finish. Keeping it in code means the two
  numbers are changed together, in one review.

## Testing

The unit suites (Vitest) mock the library, the container and the servers, so shutdown behaviour is
asserted without actually killing a process. The integration suites exercise the ownership contract
for real: each one builds a container, hands it to `buildApp`, and tears down with `app.close()` —
against a live database and Redis, so a missing or broken disposer shows up as a hanging suite. The
same contract is exercised at unit scale by `test/unit/support/container.ts`, whose
`registerTestContainer` helper is used by the plugin and route suites listed below.

- **Unit — `src/infrastructure/lifecycle/graceful-shutdown.test.ts`.** Mocks `close-with-grace` and
  captures the callback the module registers with it. Asserts the library is configured as
  `{ delay: 7_000 }` when `timeoutMs` is passed; that a signal runs `dispose` and then
  `flushTelemetry`; that a fatal `err` still logs via `logger.error` and still disposes; that a
  **rejecting** `flushTelemetry` leaves the shutdown resolved; and that a missing `flushTelemetry` is
  skipped.

- **Unit — `src/worker-shutdown.test.ts`.** Records call order to prove `healthApp.close()` precedes
  `container.dispose()`, and that a rejecting `healthApp.close()` still disposes the container while
  propagating the rejection.

- **Unit — `src/composition/compose.test.ts`.** The test named
  `keeps a disposer on every registration that owns a connection` builds a real container via
  `createAppContainer` and asserts its registrations carry a `dispose` for each key in
  `DISPOSABLE_KEYS` (`dashboardQueue`, `healthCheckRedisConnection`, `idempotencyRedis`, `jobQueue`,
  `jobScheduler`, `jobWorker`, `prisma`, `rateLimitRedis`). Sibling tests in the same file pin that
  every module claims its cradle keys exactly once and that the merged map matches the container's
  registrations.

- **Unit — `src/container.test.ts`.** That `createAppContainer` returns a **new** container per call,
  that a registration override stays local to the container it was applied to, that the container's
  `options` equal `{ injectionMode: InjectionMode.PROXY, strict: true }`, and that the base logger
  passed in is the one on the cradle.

- **Unit — `src/start-worker.test.ts`.** The counterpart start path: `jobWorker` is resolved and both
  recurring jobs (`OUTBOX_RELAY_JOB`, `DATA_RETENTION_JOB`) are scheduled with their interval
  constants — the resources whose teardown the disposers above are responsible for.

- **Integration — `test/integration/app-bootstrap.int.test.ts`.** Boots the real app from a real
  container and closes it in `afterAll`, so a disposer that fails to release the Prisma pool or a
  Redis client surfaces as a suite that will not exit.

- **Integration — `test/integration/harness-overrides.int.test.ts`.** That a cradle override applied
  to a harness-built container reaches the app — the isolation the per-caller container exists to
  provide — and that `harness.app.close()` is sufficient cleanup.

Unit suites:

```bash
npm test
```

Just this feature's unit suites:

```bash
npx vitest run \
  src/infrastructure/lifecycle/graceful-shutdown.test.ts \
  src/worker-shutdown.test.ts \
  src/composition/compose.test.ts \
  src/container.test.ts \
  src/start-worker.test.ts
```

Integration suites (requires a running Docker daemon — `test/integration/global-setup.ts` provisions
MariaDB and Redis with Testcontainers):

```bash
npm run test:integration
```
