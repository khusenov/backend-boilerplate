# Background Jobs

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `329a35a`

## Purpose

Some work should not happen inside the HTTP request that triggers it: it may be slow, may fail transiently and need retrying, or should keep running on a schedule regardless of traffic. Background jobs move that work off the request path onto a durable, Redis-backed queue so it survives process restarts, retries automatically, and can be spread across multiple worker instances. This feature is the generic **transport**: two producer ports (`JobQueue` for one-off work, `JobScheduler` for recurring work), a consumer port (`JobHandler`), and the BullMQ adapters behind them. It also ships a guarded [Bull Board](https://github.com/felixmosh/bull-board) web dashboard for operational visibility, and any part of the application can use all of it without knowing that Redis or BullMQ is underneath.

## How it works

There are two sides: producers put jobs on the queue, and a single worker takes them off and runs the matching handler. Both talk to one BullMQ queue named `default` (namespaced by `QUEUE_PREFIX`) backed by Redis.

**At HTTP-app build time, in `buildApp` (`src/presentation/http/app.ts`):** when `BULL_BOARD_ENABLED` is true, `bullBoardPlugin` is registered, mounting the read-only queue dashboard under `BULL_BOARD_PATH` (see [Bull Board dashboard](#bull-board-dashboard--operational-visibility)). When the flag is false (the default) the dashboard is never wired at all.

**At bootstrap, in `src/main.ts`:**

1. **The worker starts.** `void app.diContainer.resolve('jobWorker')` resolves the `JobWorker` singleton. Constructing it calls `new Worker('default', …)`, which immediately opens a _blocking_ connection to Redis — a connection dedicated to parking until the next job arrives, so it can serve no other commands while it waits — and begins consuming jobs. The worker is built with a fixed list of handlers — `[exampleJobHandler, outboxRelay, dispatchDomainEventJobHandler, enforceDataRetentionJob]` (`container.ts`) — indexed into a `Map` keyed by each handler's `jobName`. That `Map` is built as `new Map(handlers.map((handler) => [handler.jobName, handler]))`, so each `jobName` must be unique across the handler list: a duplicate silently overwrites the earlier handler (last one wins), with no boot-time error.
2. **Two recurring jobs are scheduled.** `main.ts` resolves `jobScheduler` and calls `schedule` twice:
   - `jobScheduler.schedule(OUTBOX_RELAY_JOB, {}, { everyMs: OUTBOX_RELAY_INTERVAL_MS })` registers `outbox.relay` as a repeatable job that BullMQ re-enqueues every `5_000` ms.
   - `jobScheduler.schedule(DATA_RETENTION_JOB, {}, { everyMs: DATA_RETENTION_INTERVAL_MS })` registers `data.retention` as a repeatable job that fires hourly (`60 * 60 * 1000` ms).

**From then on, at runtime:**

3. **A producer enqueues.** Any component with the `jobQueue` dependency calls `jobQueue.enqueue(jobName, payload, options?)`. `BullMqJobQueue` translates that into `queue.add(jobName, injectTraceContext(payload), …)`, attaching the default retry, backoff, and retention policy. BullMQ persists the job in Redis.
4. **The worker picks it up.** `JobWorker.process(job)` looks up `this.handlers.get(job.name)`. If no handler is registered it throws `No handler registered for job "<name>"`; otherwise it awaits `handler.handle(stripTraceContext(job.data))`, passing the stored payload straight through.
5. **Success or failure.** On success BullMQ removes the job per the retention policy. On failure it retries with exponential backoff — 3 total attempts (the initial try plus 2 retries), spaced roughly 1 s then 2 s. BullMQ emits its `failed` event after **every** failed attempt (not only the last), so on each failed attempt the worker's `failed` listener logs `'Job failed'` with the job's name, id, and error message — up to 3× for a default job; only the final emission coincides with the job coming to rest in BullMQ's failed set.

**Trace-context propagation across the queue.** A job is produced in one execution context (an HTTP request, or a scheduled job) and consumed later in a different one on the worker — potentially in a different process — joined only by a row in Redis. To keep those two halves inside the same distributed trace, `BullMqJobQueue.enqueue` calls `injectTraceContext(payload)` before adding the job: if an OpenTelemetry span is active, it serialises the current context (the W3C `traceparent` header that identifies the current trace) into a carrier — a plain key/value object OpenTelemetry writes the context into — and envelopes the payload as `{ ...payload, __otelCarrier: carrier }`. On the consuming side, `JobWorker.process` runs the handler inside `runWithExtractedContext(job.data, …)`, which re-establishes that context so the handler's spans and logs continue the enqueuing trace, then hands the handler `stripTraceContext(job.data)` so it never sees the carrier key. Primitive payloads, and payloads enqueued with no active span, pass through untouched. This propagation lives entirely in `src/infrastructure/jobs/job-trace-context.ts` and plugs into the app-wide OpenTelemetry setup ([distributed tracing](./tracing.md)) bootstrapped by `src/instrumentation.ts` (imported first in `main.ts`); the request-scoped log correlation id is a sibling observability concern documented in [structured-logging.md](./structured-logging.md).

**Graceful shutdown.** On `SIGINT` or `SIGTERM`, `src/main.ts` calls `app.close()`, which runs the Awilix `.disposer`s registered in `container.ts` on `jobWorker`, `jobQueue`, `jobScheduler`, and `dashboardQueue`. `JobWorker.close()` closes the worker and quits its `workerConnection`; `BullMqJobQueue.close()` closes its queue and quits the shared `redisConnection`; the scheduler and dashboard queues close their queue objects (they share `redisConnection`, which the queue disposer quits). In-flight work drains and no socket is left dangling.

**Where the real traffic comes from.** Two scheduled producers are wired today, both via `jobScheduler`:

- **Outbox relay** — the domain-events outbox (see [domain-events.md](./domain-events.md)). Every 5 s the scheduled `outbox.relay` job runs `OutboxRelay.handle()` on the worker; for each unpublished outbox row it calls `jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, …)` (in `src/infrastructure/events/outbox-relay.ts`). Those `domain-event.dispatch` jobs are then consumed by `DispatchDomainEventJobHandler`, which deserialises and delivers the event to its in-process handlers. This is the only live `enqueue → process` path: a real `schedule → handle → enqueue → process` pipeline, and the sole runtime caller of `JobQueue.enqueue`.
- **Data retention** — the scheduled housekeeping sweep (see [data-retention.md](./data-retention.md)). Every hour the scheduled `data.retention` job runs `EnforceDataRetentionJob.handle()` on the worker, which prunes stale rows via its `RetentionTask` list (`refreshTokenRetentionTask`, `outboxRetentionTask`) older than a cutoff of `now − DATA_RETENTION_TTL`. This job does not enqueue further jobs; it is a scheduled maintenance handler that touches the database directly.

So this feature is the transport, and both scheduled jobs are live producers — the outbox relay is additionally the only producer that enqueues _ad-hoc_ jobs onto the queue.

**The example job is dormant scaffolding.** `ExampleJobHandler` (job name `example.ping`) is registered in the worker's handler list and unit-tested, but no production runtime path enqueues `EXAMPLE_JOB` — only the transport tests do (see [Testing](#testing)). It exists solely as a copy-paste template for adding new jobs (see [Usage & extension](#usage--extension)); it does not run in production.

## Architecture

The feature is split across the port/adapter boundary. The application layer owns three abstractions — `JobQueue` (enqueue one-off work), `JobScheduler` (register recurring work), and `JobHandler` (the contract a consumer implements) — expressed with no reference to BullMQ or Redis. The infrastructure layer holds the only code that knows the transport: `BullMqJobQueue`, `BullMqJobScheduler`, and `JobWorker`. The presentation layer adds `bullBoardPlugin`, a Fastify plugin that exposes the queue over an operational web UI. Dependencies point inward: a producer depends on the `JobQueue`/`JobScheduler` _interfaces_, a job handler implements the `JobHandler` _interface_, and the concrete BullMQ adapters are bound to those interfaces **only** in `src/container.ts`. Replacing BullMQ (e.g. with SQS or an in-memory fake for tests) means writing new adapters and rebinding a few registrations — no application code changes.

| Component                                                              | Layer              | Responsibility                                                                                                                                | File                                                             |
| ---------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `JobQueue`                                                             | Application (port) | Contract to enqueue a one-off (optionally delayed) job onto the queue                                                                         | `src/application/shared/ports/job-queue.ts`                      |
| `JobScheduler`                                                         | Application (port) | Contract to register a repeatable job that fires on a fixed interval                                                                          | `src/application/shared/ports/job-scheduler.ts`                  |
| `JobHandler`                                                           | Application (port) | Contract a consumer implements: a `jobName` to bind to and an async `handle(payload)`                                                         | `src/application/shared/ports/job-handler.ts`                    |
| `EXAMPLE_JOB` / `ExampleJobPayload`                                    | Application        | Demo job name (`example.ping`) and payload shape — a template, never enqueued by production code                                              | `src/application/jobs/example-job.ts`                            |
| `ExampleJobHandler`                                                    | Application        | Demo handler that logs its payload — the worked template for new jobs (dormant)                                                               | `src/application/jobs/example-job-handler.ts`                    |
| `EnforceDataRetentionJob`                                              | Application        | Scheduled handler (`data.retention`) that prunes stale rows via its `RetentionTask` list on an hourly cadence                                 | `src/application/retention/enforce-data-retention-job.ts`        |
| `OutboxRelay`                                                          | Infrastructure     | Scheduled handler (`outbox.relay`) that reads unpublished outbox rows and `enqueue`s a dispatch job for each — the only live `enqueue` caller | `src/infrastructure/events/outbox-relay.ts`                      |
| `DispatchDomainEventJobHandler`                                        | Infrastructure     | Consumes `domain-event.dispatch` and delivers each deserialized event to its in-process handlers (owned by domain-events)                     | `src/infrastructure/events/dispatch-domain-event-job-handler.ts` |
| `BullMqJobQueue`                                                       | Infrastructure     | `JobQueue` adapter: adds jobs to the `default` queue with retry/backoff, retention, and injected trace context                                | `src/infrastructure/jobs/bullmq-job-queue.ts`                    |
| `BullMqJobScheduler`                                                   | Infrastructure     | `JobScheduler` adapter: upserts a BullMQ job scheduler for repeatable jobs                                                                    | `src/infrastructure/jobs/bullmq-job-scheduler.ts`                |
| `JobWorker`                                                            | Infrastructure     | Consumes the `default` queue and routes each job to its registered `JobHandler` by name, inside the extracted trace context                   | `src/infrastructure/jobs/job-worker.ts`                          |
| `injectTraceContext` / `runWithExtractedContext` / `stripTraceContext` | Infrastructure     | Propagate the OpenTelemetry trace context across the enqueue → process boundary via a payload carrier                                         | `src/infrastructure/jobs/job-trace-context.ts`                   |
| `DEFAULT_QUEUE_NAME`                                                   | Infrastructure     | The single queue name (`'default'`) shared by every producer, the worker, and the dashboard                                                   | `src/infrastructure/jobs/queue-name.ts`                          |
| `createRedisConnection`                                                | Infrastructure     | Builds an ioredis client configured for BullMQ (`maxRetriesPerRequest: null`)                                                                 | `src/infrastructure/jobs/redis-connection.ts`                    |
| `createDashboardQueue`                                                 | Infrastructure     | Builds a read-side BullMQ `Queue` handle over the `default` queue for Bull Board to introspect                                                | `src/infrastructure/jobs/dashboard-queue.ts`                     |
| `bullBoardPlugin` / `createBasicAuthValidator`                         | Presentation       | Fastify plugin that mounts the Bull Board UI, guarded by HTTP basic auth and a CSP header                                                     | `src/presentation/http/plugins/bull-board.ts`                    |
| Container wiring                                                       | Composition root   | Binds the ports to the BullMQ adapters, provides the two Redis connections, assembles the handler list, registers the dashboard queue         | `src/container.ts`                                               |
| Bootstrap                                                              | Composition root   | Starts the worker and schedules the outbox relay and data-retention jobs                                                                      | `src/main.ts`                                                    |

## Public surface

This feature exposes a programmatic contract (three ports) plus one operational HTTP surface (the dashboard).

### Ports — the contract another engineer programs against

**1. `JobQueue` — enqueue one-off work (inject and call this from a producer).**

```ts
export interface JobOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
}

export interface JobQueue {
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>;
}
```

`jobName` selects which handler will run (it must match a handler's `jobName`); `payload` is any JSON-serializable value stored with the job. `options.attempts` overrides the default of 3 total attempts (the initial try plus 2 retries); `options.delayMs` postpones the first attempt by that many milliseconds. Retry backoff and retention are fixed by the adapter and are not caller-tunable.

**2. `JobScheduler` — register recurring work (typically once, at bootstrap).**

```ts
export interface ScheduleOptions {
  readonly everyMs: number;
}

export interface JobScheduler {
  schedule<TPayload>(jobName: string, payload: TPayload, options: ScheduleOptions): Promise<void>;
}
```

`schedule` registers a repeatable job that BullMQ re-enqueues every `everyMs` milliseconds with the given `payload`. It is idempotent per `jobName` (backed by BullMQ's `upsertJobScheduler`), so calling it again with the same name updates the schedule rather than creating a duplicate — safe to call on every boot. Note the division of labour: **recurring** work goes through `JobScheduler` (`everyMs`); a **one-off but delayed** job goes through `JobQueue.enqueue` with `delayMs`.

**3. `JobHandler` — implement this to consume a job.**

```ts
export interface JobHandler<TPayload = unknown> {
  readonly jobName: string;

  handle(payload: TPayload): Promise<void>;
}
```

A handler binds to exactly one `jobName` and receives the enqueued payload as `handle`'s argument. The `<TPayload>` generic is a compile-time convenience only — the worker passes BullMQ's stored `job.data` (with the trace carrier stripped) straight to `handle` with no runtime schema validation, so the producer and handler must agree on the payload shape. Delivery is **at-least-once** — BullMQ retries a failed attempt, and the outbox relay can re-enqueue a dispatch job after a crash — so `handle` may run more than once for the same logical job and **must be idempotent**: dedupe on a stable key rather than assuming exactly-once. A handler is only reachable once it is added to the worker's handler list in `container.ts` (see below), and its `jobName` must be unique within that list — the worker routes by name through a `Map`, so registering a second handler under a name already in use silently replaces the first.

The `jobName`s live today are: `example.ping` (dormant), `outbox.relay`, `domain-event.dispatch`, and `data.retention`.

### Bull Board dashboard — operational visibility

An operator-facing web UI for inspecting the `default` queue: pending, active, completed, delayed, and failed jobs. It is **off by default** and gated behind several guards (see [Design decisions](#design-decisions--trade-offs)).

| Method                                        | Path                                                         | Auth                                                                                                       | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET` (and Bull Board's own asset/API routes) | all routes under `BULL_BOARD_PATH` (default `/admin/queues`) | HTTP Basic (`Authorization: Basic …`), realm `Finflow Queues`; only mounted when `BULL_BOARD_ENABLED=true` | Browse and (unless `BULL_BOARD_READONLY`) act on queued jobs |

The route tree is mounted by `serverAdapter.registerPlugin()` under `basePath = env.BULL_BOARD_PATH`. Every response carries a restrictive `Content-Security-Policy` header stamped by an `onSend` hook. The queue it reads is `dashboardQueue`, a BullMQ `Queue` handle over the same `default` queue, wrapped in a `BullMQAdapter` whose `readOnlyMode` follows `BULL_BOARD_READONLY`.

## Configuration

Read from `src/config/env.ts` (`.env.example` lists the same keys):

| Variable              | Default                                  | Meaning                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIS_URL`           | `redis://127.0.0.1:6379` (dev/test only) | Connection string for the Redis instance that backs BullMQ. Declared with `devDefault`, so it has **no** production default — it is required when `NODE_ENV=production` and is only defaulted in development/test. |
| `QUEUE_PREFIX`        | `finflow`                                | Key prefix BullMQ applies to every queue key in Redis, namespacing this app's jobs.                                                                                                                                |
| `QUEUE_CONCURRENCY`   | `5`                                      | Maximum number of jobs the worker processes in parallel.                                                                                                                                                           |
| `DATA_RETENTION_TTL`  | `2592000` (30 days, in seconds)          | Age threshold for the `data.retention` job: rows older than `now − DATA_RETENTION_TTL` are pruned. Multiplied by 1000 in `container.ts` to form `dataRetentionWindowMs`.                                           |
| `BULL_BOARD_ENABLED`  | `false`                                  | Master switch for the dashboard. When false, `bullBoardPlugin` is never registered.                                                                                                                                |
| `BULL_BOARD_PATH`     | `/admin/queues`                          | Base path the dashboard UI (and its API/asset routes) is mounted under.                                                                                                                                            |
| `BULL_BOARD_USERNAME` | `admin`                                  | Basic-auth username for the dashboard.                                                                                                                                                                             |
| `BULL_BOARD_PASSWORD` | `''` (empty)                             | Basic-auth password. **Empty disables login fail-closed** — the validator rejects every request. In production, boot fails if the dashboard is enabled and this is shorter than 16 characters.                     |
| `BULL_BOARD_READONLY` | `true`                                   | When true, the dashboard can only view jobs; retry/remove/promote actions are disabled.                                                                                                                            |

The two scheduling intervals are code constants, not env vars: `OUTBOX_RELAY_INTERVAL_MS = 5_000` (in `outbox-relay.ts`) and `DATA_RETENTION_INTERVAL_MS = 60 * 60 * 1000` (in `enforce-data-retention-job.ts`).

## Usage & extension

Adding a new job follows the same four steps every time. The snippets below add an `email.send-welcome` job, mirroring the structure of `EXAMPLE_JOB` / `ExampleJobHandler`.

**Step 1 — Define the job name and payload (application).** Create `src/application/jobs/send-welcome-email-job.ts`:

```ts
export const SEND_WELCOME_EMAIL_JOB = 'email.send-welcome';

export interface SendWelcomeEmailPayload {
  userId: string;
  email: string;
}
```

**Step 2 — Implement the handler (application).** Create `src/application/jobs/send-welcome-email-job-handler.ts`:

```ts
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import {
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailPayload,
} from '@/application/jobs/send-welcome-email-job';

export interface SendWelcomeEmailJobHandlerDeps {
  logger: Logger;
}

export class SendWelcomeEmailJobHandler implements JobHandler<SendWelcomeEmailPayload> {
  readonly jobName = SEND_WELCOME_EMAIL_JOB;
  private readonly logger: Logger;

  constructor({ logger }: SendWelcomeEmailJobHandlerDeps) {
    this.logger = logger;
  }

  handle(payload: SendWelcomeEmailPayload): Promise<void> {
    this.logger.info('Sending welcome email', { userId: payload.userId });
    return Promise.resolve();
  }
}
```

**Step 3 — Register the handler and add it to the worker (`src/container.ts`).** Import it, declare it on the `Cradle` interface, register it, and — the step that actually makes it run — append it to the `jobWorker` factory's `handlers` array (and to that factory's `Pick<…>` destructure):

```ts
// import at the top
import { SendWelcomeEmailJobHandler } from '@/application/jobs/send-welcome-email-job-handler';

// on the Cradle interface, near exampleJobHandler
sendWelcomeEmailJobHandler: SendWelcomeEmailJobHandler;

// inside registerDependencies(...)
sendWelcomeEmailJobHandler: asClass(SendWelcomeEmailJobHandler).singleton(),

// extend the existing jobWorker factory
jobWorker: asFunction(
  ({
    workerConnection,
    exampleJobHandler,
    outboxRelay,
    dispatchDomainEventJobHandler,
    enforceDataRetentionJob,
    sendWelcomeEmailJobHandler,
    logger,
    queuePrefix,
    queueConcurrency,
  }: Pick<
    Cradle,
    | 'workerConnection'
    | 'exampleJobHandler'
    | 'outboxRelay'
    | 'dispatchDomainEventJobHandler'
    | 'enforceDataRetentionJob'
    | 'sendWelcomeEmailJobHandler'
    | 'logger'
    | 'queuePrefix'
    | 'queueConcurrency'
  >) =>
    new JobWorker({
      connection: workerConnection,
      queuePrefix,
      concurrency: queueConcurrency,
      handlers: [
        exampleJobHandler,
        outboxRelay,
        dispatchDomainEventJobHandler,
        enforceDataRetentionJob,
        sendWelcomeEmailJobHandler,
      ],
      logger,
    }),
)
  .singleton()
  .disposer((worker) => worker.close()),
```

If you skip adding the handler to that array, enqueuing the job makes the worker throw `No handler registered for job "email.send-welcome"` when it tries to process it.

**Step 4 — Enqueue it from a producer.** Any component that injects `jobQueue` (a use case, another job handler) enqueues work:

```ts
await this.jobQueue.enqueue<SendWelcomeEmailPayload>(SEND_WELCOME_EMAIL_JOB, {
  userId: user.id,
  email: user.email.toString(),
});
```

Pass options to override the defaults — `enqueue(SEND_WELCOME_EMAIL_JOB, payload, { attempts: 5, delayMs: 60_000 })` makes up to five attempts (the initial try plus four retries) and waits a minute before the first attempt. For a **recurring** job instead, register it once at bootstrap the way `src/main.ts` schedules the outbox relay and data-retention jobs:

```ts
await app.diContainer
  .resolve('jobScheduler')
  .schedule(SEND_WELCOME_EMAIL_JOB, {}, { everyMs: 60_000 });
```

**Viewing jobs in Bull Board.** To inspect the queue locally, set `BULL_BOARD_ENABLED=true` and a `BULL_BOARD_PASSWORD` in your `.env`, then browse to `http://localhost:8000/admin/queues` and authenticate with `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD`. Leave `BULL_BOARD_READONLY=true` unless you specifically need to retry or remove jobs from the UI.

## Design decisions & trade-offs

- **Durable, Redis-backed queue instead of in-process scheduling.** Jobs are persisted in Redis by BullMQ, so an enqueued job outlives the request that created it, survives a process restart or crash, and can be picked up by any worker instance. An in-process alternative (`setInterval`, an in-memory array) would lose all pending work on restart and could not be shared across horizontally scaled instances. This is a standing project decision: **all** background and scheduled work goes through BullMQ, never in-process. The accepted cost is that Redis becomes a required infrastructure dependency (the service cannot run without it) and payloads must be JSON-serializable.
- **Automatic retries with exponential backoff.** `BullMqJobQueue` defaults every job to `attempts: 3` and `backoff: { type: 'exponential', delay: 1000 }` — 3 total attempts, the initial try plus 2 retries, with exponential backoff of ~1 s then ~2 s before the job is marked failed — with no retry bookkeeping in application code. Callers that need different behaviour override `attempts` through `JobOptions`; the backoff curve itself is fixed in the adapter.
- **At-least-once delivery — handlers must be idempotent.** Because BullMQ retries a failed attempt and the outbox relay can re-enqueue a dispatch job after a crash, a job can execute more than once for the same logical unit of work. Handlers must therefore be idempotent: derive a stable key from the payload and dedupe on it — a `SEND_WELCOME_EMAIL_JOB` handler, for instance, should record that a given user has been emailed and skip a second send — rather than assuming exactly-once delivery. The transport deliberately does not chase exactly-once, which on a distributed queue costs far more than making individual handlers safe to re-run.
- **One shared queue with name-based routing, not a queue per job type.** Every job is added to the single `default` queue, and `JobWorker` dispatches by `job.name` through a `Map<string, JobHandler>` built once at construction. This keeps the wiring to exactly one queue and one worker, which is appropriate at the current low volume. The trade-off is no isolation between job types: a burst of one job competes for the same `QUEUE_CONCURRENCY` budget as every other. Splitting hot jobs onto dedicated queues is a later change if throughput or priority demands it.
- **Repeatable and delayed are deliberately separate concerns.** Recurring work is a `JobScheduler.schedule` (`everyMs`) call that maps to BullMQ's `upsertJobScheduler`; a one-off delayed job is a `JobQueue.enqueue` call with `delayMs`. Splitting them keeps a producer that only ever enqueues from having to see scheduling APIs, and `upsert` makes rescheduling idempotent — re-running bootstrap re-registers the same repeatable job under its `jobName` key rather than stacking duplicates.
- **Trace context rides the payload so async work stays inside the request's trace.** Rather than losing the causal link when work crosses the queue, `BullMqJobQueue` injects the active OpenTelemetry context into the job payload under a reserved `__otelCarrier` key, and `JobWorker` extracts it and runs the handler within that context, stripping the carrier before the handler sees the data. The alternative — treating each worker execution as a fresh, unlinked trace — would make it impossible to follow a slow request into the async work it spawned. The cost is a small, reserved key on object payloads (primitives and span-less enqueues are untouched); the mechanism is isolated in `job-trace-context.ts` (part of the app's [distributed tracing](./tracing.md)) so handlers and producers never deal with it directly.
- **Two separate Redis connections, one for producing and one for the worker.** `container.ts` registers `redisConnection` (used by `BullMqJobQueue`, `BullMqJobScheduler`, and the dashboard queue) and `workerConnection` (used by `JobWorker`) as distinct ioredis singletons. A BullMQ worker holds a _blocking_ connection while it waits for jobs; sharing that socket with the producer side would stall enqueues. Both are created via `createRedisConnection` with `maxRetriesPerRequest: null`, which BullMQ requires so its blocking commands are never aborted mid-wait.
- **Bounded retention so Redis does not grow without limit.** Completed jobs are trimmed to 1 hour / 1 000 entries and failed jobs to 7 days / 5 000 entries (`removeOnComplete` / `removeOnFail`). Successful jobs are discarded quickly since they carry no diagnostic value, while failures are kept long enough to inspect before they too are trimmed.
- **The queue dashboard is defence-in-depth, off by default.** Bull Board exposes queue internals, so it ships behind several layers rather than one: (1) it is only registered when `BULL_BOARD_ENABLED=true`, so production must opt in; (2) it sits behind HTTP basic auth whose validator compares credentials in **constant time** (SHA-256 digest + `timingSafeEqual`) to resist timing attacks, and **fails closed** — if the configured username or password is empty, every request is rejected rather than waved through; (3) `assertProductionSecrets` refuses to boot a production process that enables the board with a `BULL_BOARD_PASSWORD` shorter than 16 characters; (4) it defaults to `BULL_BOARD_READONLY=true` so viewing cannot mutate the queue; and (5) every response carries a restrictive `Content-Security-Policy`. The read side uses a dedicated `dashboardQueue` — a separate BullMQ `Queue` handle over the shared `redisConnection` — so the UI introspects the queue without reaching into the producer's or worker's internal `Queue`/`Worker` objects.
- **`EXAMPLE_JOB` ships as a dormant template, not a live job.** It is fully wired into the worker and unit-tested so the wiring is demonstrably correct, but no production path enqueues `example.ping` (only the transport tests do). It is included purely as a working, copy-pasteable starting point for real jobs — documented explicitly so a reader does not mistake it for production work.

## Testing

Coverage spans unit tests for the pieces that can be exercised in isolation and integration tests that stand up a real Redis (via testcontainers) to prove the transport end-to-end.

- **`src/application/jobs/example-job-handler.test.ts`** (unit) asserts that `ExampleJobHandler.jobName` equals `EXAMPLE_JOB` and that `handle` logs `'Example job processed'` with the payload's `message`. It exercises the demo handler, not the transport.
- **`src/infrastructure/jobs/job-trace-context.test.ts`** (unit) covers the trace-propagation helpers directly: `injectTraceContext` envelopes an object payload with a carrier carrying the `traceparent` when a span is active, and returns the payload untouched with no active span or for a primitive; `runWithExtractedContext` restores a context whose active span `traceId` equals the injected one, and runs the callback directly when the payload has no carrier; `stripTraceContext` removes the `__otelCarrier` envelope and leaves carrier-less, null-carrier, or primitive payloads intact.
- **`src/presentation/http/plugins/bull-board.test.ts`** (unit) covers the dashboard guard: `createBasicAuthValidator` rejects when credentials are unconfigured (empty password), rejects mismatched credentials, and accepts an exact match; wired into `@fastify/basic-auth` it passes a request through on valid credentials and challenges with `401` on wrong ones; and `bullBoardPlugin` itself, mounted on a bare Fastify app with a stubbed `dashboardQueue`, answers an unauthenticated `GET /admin/queues` with `401` while stamping the expected `Content-Security-Policy` header.
- **`src/application/retention/enforce-data-retention-job.test.ts`** (unit) covers the data-retention handler's orchestration over its `RetentionTask` list independently of Redis or the worker.
- **`test/integration/jobs/job-queue.int.test.ts`** (the `BullMQ job round-trip` block) is the dedicated transport test. It starts a real Redis via testcontainers (`redis:7.4-alpine`) and constructs `BullMqJobQueue` and `JobWorker` directly. Case one — _"routes an enqueued job to its registered handler"_ — enqueues `EXAMPLE_JOB` with `{ message: 'hello' }` and asserts the registered handler receives that exact payload, covering the enqueue → worker → handler delivery path. Case two — _"logs a failure when a job has no registered handler"_ — wires a worker with an empty handler list, enqueues `'unregistered.job'` with payload `{ message: 'x' }` and options `{ attempts: 1 }`, and asserts the worker's `failed` listener logs metadata matching `{ jobName: 'unregistered.job' }`. This case is the only coverage of `JobWorker`'s no-handler throw and its `failed` listener.
- **`test/integration/jobs/job-tracing.int.test.ts`** (the `BullMQ trace-context propagation` block) proves the trace crosses the real queue. Against a testcontainers Redis it enqueues `EXAMPLE_JOB` from within an active span and asserts that the handler, running on the worker, observes an active span whose `traceId` equals the enqueuing trace — end-to-end evidence that `injectTraceContext`/`runWithExtractedContext` stitch the two execution contexts together through Redis.
- **`test/integration/outbox.int.test.ts`** (the `relay (BullMQ)` block) also exercises `BullMqJobQueue` and `JobWorker` end-to-end, as a side effect of testing the outbox relay (see [domain-events.md](./domain-events.md)). It starts a real Redis via testcontainers, constructs a real `BullMqJobQueue` and `JobWorker`, and drives the full `create → relay → worker → handler` path, asserting a `UserCreatedEvent` is delivered to the registered handler.
- **`test/integration/data-retention.int.test.ts`** (the `data retention (outbox)` block) resolves `enforceDataRetentionJob` from the container and calls `handle()` directly against a real database, asserting that delivered outbox rows older than the retention window are deleted while recent and unpublished rows survive. It exercises the retention handler, not the scheduler that fires it.
- **No dedicated tests** exist for `BullMqJobScheduler` or `createRedisConnection`. The scheduler's `upsertJobScheduler` registration and the shared Redis-connection factory run only through the container wiring at runtime — no test schedules a repeatable job or builds its connections through `createRedisConnection`; integration tests construct their ioredis clients inline with `new Redis(...)` and invoke handlers directly rather than via the scheduler.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`); they require Docker for the Redis (and database) testcontainers the harness spins up.
