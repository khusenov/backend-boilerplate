# Background Jobs

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `329a35a`

## Purpose

Some work should not happen inside the HTTP request that triggers it: it may be slow, may fail transiently and need retrying, or should keep running on a schedule regardless of traffic. Background jobs move that work off the request path onto a durable, Redis-backed queue so it survives process restarts, retries automatically, and can be spread across multiple worker instances. This feature is the generic **transport**: two producer ports (`JobQueue` for one-off work, `JobScheduler` for recurring work), a consumer port (`JobHandler`), and the BullMQ adapters behind them. It also ships a guarded [Bull Board](https://github.com/felixmosh/bull-board) web dashboard for operational visibility, and any part of the application can use all of it without knowing that Redis or BullMQ is underneath.

## How it works

There are two sides: producers put jobs on the queue, and a single worker takes them off and runs the matching handler. Both talk to one BullMQ queue named `default` (namespaced by `QUEUE_PREFIX`) backed by Redis.

**At HTTP-app build time, in `buildApp` (`src/presentation/http/app.ts`):** when `BULL_BOARD_ENABLED` is true, `bullBoardPlugin` is registered, mounting the read-only queue dashboard under `BULL_BOARD_PATH` (see [Bull Board dashboard](#bull-board-dashboard--operational-visibility)). When the flag is false (the default) the dashboard is never wired at all.

**At bootstrap, in the worker process (`src/worker.ts` → `startWorker` in `src/start-worker.ts`):**

1. **The worker starts.** `void container.resolve('jobWorker')` resolves the `JobWorker` singleton. Constructing it calls `new Worker('default', …)`, which immediately opens a _blocking_ connection to Redis — a connection dedicated to parking until the next job arrives, so it can serve no other commands while it waits — and begins consuming jobs. The worker's handler list is assembled in `container.ts` by `toJobHandlerList`, which takes a record keyed by job name — `{ [EXAMPLE_JOB]: exampleJobHandler, [SEND_VERIFICATION_EMAIL_JOB]: sendVerificationEmailHandler, … }` — and returns its values. `JobWorker` then indexes those into a `Map` built as `new Map(handlers.map((handler) => [handler.jobName, handler]))`. Because that record's type `JobHandlersByName` (`src/job-catalogue.ts`) is a mapped type over the `JobName` union, every job name has exactly one slot: omitting a handler is a compile error, and a second handler under a name already in use is unrepresentable rather than a silent last-one-wins overwrite at boot.
2. **Two recurring jobs are scheduled.** `startWorker` resolves `jobScheduler` and calls `schedule` twice:
   - `jobScheduler.schedule(OUTBOX_RELAY_JOB, {}, { everyMs: OUTBOX_RELAY_INTERVAL_MS })` registers `outbox.relay` as a repeatable job that BullMQ re-enqueues every `5_000` ms.
   - `jobScheduler.schedule(DATA_RETENTION_JOB, {}, { everyMs: DATA_RETENTION_INTERVAL_MS })` registers `data.retention` as a repeatable job that fires hourly (`60 * 60 * 1000` ms).

**From then on, at runtime:**

3. **A producer enqueues.** Any component with the `jobQueue` dependency calls `jobQueue.enqueue(jobName, payload, options?)`. `BullMqJobQueue` translates that into `queue.add(jobName, injectTraceContext(payload), …)`, attaching the default retry, backoff, and retention policy. BullMQ persists the job in Redis.
4. **The worker picks it up.** `JobWorker.process(job)` looks up `this.handlers.get(job.name)`. If no handler is registered it throws `No handler registered for job "<name>"`; otherwise it awaits `handler.handle(stripTraceContext(job.data))`, passing the stored payload straight through.
5. **Success or failure.** On success BullMQ removes the job per the retention policy. On failure it retries with exponential backoff — 3 total attempts (the initial try plus 2 retries), spaced roughly 1 s then 2 s. BullMQ emits its `failed` event after **every** failed attempt (not only the last), so the worker's listener distinguishes the two cases rather than logging them alike: while a retry is still pending it logs `'Job attempt failed, retry pending'` at **warn**, and once BullMQ has decided against retrying it logs `'Job dead-lettered, no retry remains'` at **error**. It reads that decision off `job.finishedOn`, which BullMQ assigns only in the non-retry branch — so all four ways a job can stop retrying (attempts exhausted, `UnrecoverableError`, `job.discard()`, or a custom backoff returning `-1`) land in the dead-letter branch, where comparing `attemptsMade` against `opts.attempts` would catch only the first.
6. **Stalls.** If a worker dies mid-job its processing lock expires, and BullMQ's stalled check returns the job to the wait list entirely inside Lua — emitting only `'stalled'`, never `'failed'`. The worker's `stalled` listener logs `'Job stalled, its processing lock expired'` at **warn**, so that first stall is visible. Once a job exceeds `maxStalledCount` (default 1), BullMQ raises the next pickup as an `UnrecoverableError`, which lands in the dead-letter branch above.

**Trace-context propagation across the queue.** A job is produced in one execution context (an HTTP request, or a scheduled job) and consumed later in a different one on the worker — potentially in a different process — joined only by a row in Redis. To keep those two halves inside the same distributed trace, `BullMqJobQueue.enqueue` calls `injectTraceContext(payload)` before adding the job: if an OpenTelemetry span is active, it serialises the current context (the W3C `traceparent` header that identifies the current trace) into a carrier — a plain key/value object OpenTelemetry writes the context into — and envelopes the payload as `{ ...payload, __otelCarrier: carrier }`. On the consuming side, `JobWorker.process` runs the handler inside `runWithExtractedContext(job.data, …)`, which re-establishes that context so the handler's spans and logs continue the enqueuing trace, then hands the handler `stripTraceContext(job.data)` so it never sees the carrier key. Primitive payloads, and payloads enqueued with no active span, pass through untouched. This propagation lives entirely in `src/infrastructure/jobs/job-trace-context.ts` and plugs into the app-wide OpenTelemetry setup ([distributed tracing](./tracing.md)) bootstrapped by `src/instrumentation.ts` (imported first in both entrypoints, `main.ts` and `worker.ts`); the request-scoped log correlation id is a sibling observability concern documented in [structured-logging.md](./structured-logging.md).

**Graceful shutdown.** On `SIGINT` or `SIGTERM`, the worker process runs `createWorkerShutdown` (`src/worker-shutdown.ts`), which closes the health app and then disposes the container — running the Awilix `.disposer`s registered in `container.ts` on `jobWorker`, `jobQueue`, `jobScheduler`, and `dashboardQueue`. `JobWorker.close()` closes the worker and quits its `workerConnection`; `BullMqJobQueue.close()` closes its queue and quits the shared `redisConnection`; the scheduler and dashboard queues close their queue objects (they share `redisConnection`, which the queue disposer quits). In-flight work drains and no socket is left dangling.

**Where the real traffic comes from.** Three producers are wired today — two scheduled through `jobScheduler`, and one on the HTTP request path:

- **Outbox relay** — the domain-events outbox (see [domain-events.md](./domain-events.md)). Every 5 s the scheduled `outbox.relay` job runs `OutboxRelay.handle()` on the worker; for each unpublished outbox row it calls `jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, …)` (in `src/infrastructure/events/outbox-relay.ts`). Those `domain-event.dispatch` jobs are then consumed by `DispatchDomainEventJobHandler`, which deserialises and delivers the event to its in-process handlers. It is the full `schedule → handle → enqueue → process` pipeline, and the only producer that enqueues from _inside_ the worker.
- **Data retention** — the scheduled housekeeping sweep (see [data-retention.md](./data-retention.md)). Every hour the scheduled `data.retention` job runs `EnforceDataRetentionJob.handle()` on the worker, which prunes stale rows via its `RetentionTask` list (`refreshTokenRetentionTask`, `outboxRetentionTask`) older than a cutoff of `now − DATA_RETENTION_TTL`. This job does not enqueue further jobs; it is a scheduled maintenance handler that touches the database directly.
- **Verification email** — the registration flow (see [authentication.md](./authentication.md)). `RegisterUser` calls `jobQueue.enqueue(SEND_VERIFICATION_EMAIL_JOB, { email, code })` (`src/application/auth/register-user.ts`), and `SendVerificationEmailHandler` consumes it on the worker, rendering the message and sending it through the `EmailSender` port. This is the only producer that runs on an HTTP request, and the reason it exists is to keep SMTP latency and SMTP failures off the registration response.

So this feature is the transport, and all three producers are live.

**The example job is dormant scaffolding.** `ExampleJobHandler` (job name `example.ping`) is registered in the worker's handler record and unit-tested, but no production runtime path enqueues `EXAMPLE_JOB` — only the transport tests do (see [Testing](#testing)). It exists solely as a copy-paste template for adding new jobs (see [Usage & extension](#usage--extension)); it does not run in production.

## Architecture

The feature is split across the port/adapter boundary. The application layer owns three abstractions — `JobQueue` (enqueue one-off work), `JobScheduler` (register recurring work), and `JobHandler` (the contract a consumer implements) — expressed with no reference to BullMQ or Redis. The infrastructure layer holds the only code that knows the transport: `BullMqJobQueue`, `BullMqJobScheduler`, and `JobWorker`. The presentation layer adds `bullBoardPlugin`, a Fastify plugin that exposes the queue over an operational web UI. Dependencies point inward: a producer depends on the `JobQueue`/`JobScheduler` _interfaces_, a job handler implements the `JobHandler` _interface_, and the concrete BullMQ adapters are bound to those interfaces **only** in `src/container.ts`. Replacing BullMQ (e.g. with SQS or an in-memory fake for tests) means writing new adapters and rebinding a few registrations — no application code changes.

| Component                                                              | Layer              | Responsibility                                                                                                                                         | File                                                             |
| ---------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `JobQueue`                                                             | Application (port) | Contract to enqueue a one-off (optionally delayed) job onto the queue                                                                                  | `src/application/shared/ports/job-queue.ts`                      |
| `JobScheduler`                                                         | Application (port) | Contract to register a repeatable job that fires on a fixed interval                                                                                   | `src/application/shared/ports/job-scheduler.ts`                  |
| `JobHandler`                                                           | Application (port) | Contract a consumer implements: a `jobName` to bind to and an async `handle(payload)`                                                                  | `src/application/shared/ports/job-handler.ts`                    |
| `EXAMPLE_JOB` / `ExampleJobPayload`                                    | Application        | Demo job name (`example.ping`) and payload shape — a template, never enqueued by production code                                                       | `src/application/jobs/example-job.ts`                            |
| `ExampleJobHandler`                                                    | Application        | Demo handler that logs its payload — the worked template for new jobs (dormant)                                                                        | `src/application/jobs/example-job-handler.ts`                    |
| `SEND_VERIFICATION_EMAIL_JOB` / `SendVerificationEmailPayload`         | Application        | Job name (`email.send-verification`) and payload (`email`, `code`) for the registration verification email                                             | `src/application/jobs/send-verification-email-job.ts`            |
| `SendVerificationEmailHandler`                                         | Application        | Consumes `email.send-verification` and sends the rendered code through the `EmailSender` port                                                          | `src/application/jobs/send-verification-email-handler.ts`        |
| `EnforceDataRetentionJob`                                              | Application        | Scheduled handler (`data.retention`) that prunes stale rows via its `RetentionTask` list on an hourly cadence                                          | `src/application/retention/enforce-data-retention-job.ts`        |
| `OutboxRelay`                                                          | Infrastructure     | Scheduled handler (`outbox.relay`) that reads unpublished outbox rows and `enqueue`s a dispatch job for each — the only `enqueue` caller on the worker | `src/infrastructure/events/outbox-relay.ts`                      |
| `DispatchDomainEventJobHandler`                                        | Infrastructure     | Consumes `domain-event.dispatch` and delivers each deserialized event to its in-process handlers (owned by domain-events)                              | `src/infrastructure/events/dispatch-domain-event-job-handler.ts` |
| `BullMqJobQueue`                                                       | Infrastructure     | `JobQueue` adapter: adds jobs to the `default` queue with retry/backoff, retention, and injected trace context                                         | `src/infrastructure/jobs/bullmq-job-queue.ts`                    |
| `BullMqJobScheduler`                                                   | Infrastructure     | `JobScheduler` adapter: upserts a BullMQ job scheduler for repeatable jobs                                                                             | `src/infrastructure/jobs/bullmq-job-scheduler.ts`                |
| `JobWorker`                                                            | Infrastructure     | Consumes the `default` queue and routes each job to its registered `JobHandler` by name, inside the extracted trace context                            | `src/infrastructure/jobs/job-worker.ts`                          |
| `injectTraceContext` / `runWithExtractedContext` / `stripTraceContext` | Infrastructure     | Propagate the OpenTelemetry trace context across the enqueue → process boundary via a payload carrier                                                  | `src/infrastructure/jobs/job-trace-context.ts`                   |
| `DEFAULT_QUEUE_NAME`                                                   | Infrastructure     | The single queue name (`'default'`) shared by every producer, the worker, and the dashboard                                                            | `src/infrastructure/jobs/queue-name.ts`                          |
| `createRedisConnection`                                                | Infrastructure     | Builds an ioredis client configured for BullMQ (`maxRetriesPerRequest: null`)                                                                          | `src/infrastructure/jobs/redis-connection.ts`                    |
| `createDashboardQueue`                                                 | Infrastructure     | Builds a read-side BullMQ `Queue` handle over the `default` queue for Bull Board to introspect                                                         | `src/infrastructure/jobs/dashboard-queue.ts`                     |
| `bullBoardPlugin` / `createBasicAuthValidator`                         | Presentation       | Fastify plugin that mounts the Bull Board UI, guarded by HTTP basic auth and a CSP header                                                              | `src/presentation/http/plugins/bull-board.ts`                    |
| `JOB_NAMES` / `JobHandlersByName` / `toJobHandlerList`                 | Composition root   | The catalogue of live job names, the mapped type that forces one handler per name, and the function that flattens the record for the worker            | `src/job-catalogue.ts`                                           |
| Container wiring                                                       | Composition root   | Binds the ports to the BullMQ adapters, provides the two Redis connections, assembles the name-keyed handler record, registers the dashboard queue     | `src/container.ts`                                               |
| Bootstrap                                                              | Composition root   | Starts the worker and schedules the outbox relay and data-retention jobs                                                                               | `src/worker.ts` → `src/start-worker.ts`                          |

## Public surface

This feature exposes a programmatic contract (three ports) plus one operational HTTP surface (the dashboard).

### Ports — the contract another engineer programs against

**1. `JobQueue` — enqueue one-off work (inject and call this from a producer).**

```ts
export interface JobOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Stable, opaque key identifying the unit of work; a repeat enqueue within the
   *  adapter's horizon is a no-op. Scoped to the job name, not global. */
  readonly deduplicationKey?: string;
}

export interface JobQueue {
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>;
}
```

`jobName` selects which handler will run (it must match a handler's `jobName`); `payload` is any JSON-serializable value stored with the job. `options.attempts` overrides the default of 3 total attempts (the initial try plus 2 retries); `options.delayMs` postpones the first attempt by that many milliseconds. `options.deduplicationKey` is a stable, opaque identifier for the unit of work: enqueuing the same job name with the same key twice delivers the job once, within the horizon the adapter documents (see [Deduplicating an at-least-once producer](#deduplicating-an-at-least-once-producer)). The key is **scoped to the job name, not global** — the same key under two different job names is two different jobs. Retry backoff and retention are fixed by the adapter and are not caller-tunable.

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
export interface JobHandler<TPayload = unknown, TName extends string = string> {
  readonly jobName: TName;

  handle(payload: TPayload): Promise<void>;
}
```

A handler binds to exactly one `jobName` and receives the enqueued payload as `handle`'s argument. The two generics do different jobs. `TPayload` is a compile-time convenience only — the worker passes BullMQ's stored `job.data` (with the trace carrier stripped) straight to `handle` with no runtime schema validation, so the producer and handler must agree on the payload shape. `TName` is load-bearing: pinning it to a job-name literal (`implements JobHandler<MyPayload, typeof MY_JOB>`) is what lets the composition root check the wiring, so **always pin it** rather than leaving it at its `string` default. Delivery is **at-least-once** — BullMQ retries a failed attempt, and the outbox relay can re-enqueue a dispatch job after a crash — so `handle` may run more than once for the same logical job and **must be idempotent**: dedupe on a stable key rather than assuming exactly-once. A handler is reachable once it is registered in the worker's handler record in `container.ts` (see below); because that record is typed by `JobHandlersByName`, a handler that is declared but never filed under its job name fails to compile, and its `jobName` cannot collide with another's — the record gives each name exactly one slot.

The `jobName`s live today are: `example.ping` (dormant), `email.send-verification`, `outbox.relay`, `domain-event.dispatch`, and `data.retention`. `src/job-catalogue.ts` lists them as `JOB_NAMES`, and `src/job-catalogue.test.ts` fails if a handler declares a `jobName` missing from that list.

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

export class SendWelcomeEmailJobHandler implements JobHandler<
  SendWelcomeEmailPayload,
  typeof SEND_WELCOME_EMAIL_JOB
> {
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

**Step 3 — Register the handler and add it to the worker.** Add the job name to `JOB_NAMES` in `src/job-catalogue.ts`, then in `src/container.ts` import the handler, declare it on the `Cradle` **by its port type** (not by its class — that is what keeps the composition root depending on the abstraction), register it, add its key to the `jobWorker` factory's `Pick<Cradle, …>` union, destructure it, and file it in the handler record under its job name:

```ts
// in src/job-catalogue.ts — import the constant, then add it to JOB_NAMES
import { SEND_WELCOME_EMAIL_JOB } from '@/application/jobs/send-welcome-email-job';

export const JOB_NAMES = [
  // …existing names
  SEND_WELCOME_EMAIL_JOB,
] as const;
```

```ts
// in src/container.ts — import at the top
import { SendWelcomeEmailJobHandler } from '@/application/jobs/send-welcome-email-job-handler';
import {
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailPayload,
} from '@/application/jobs/send-welcome-email-job';

// on the Cradle interface, near exampleJobHandler — the port, not the class
sendWelcomeEmailJobHandler: JobHandler<SendWelcomeEmailPayload, typeof SEND_WELCOME_EMAIL_JOB>;

// inside registerDependencies(...)
sendWelcomeEmailJobHandler: asClass(SendWelcomeEmailJobHandler).singleton(),

// extend the existing jobWorker factory
jobWorker: asFunction(
  ({
    workerConnection,
    exampleJobHandler,
    sendVerificationEmailHandler,
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
    | 'sendVerificationEmailHandler'
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
      handlers: toJobHandlerList({
        [EXAMPLE_JOB]: exampleJobHandler,
        [SEND_VERIFICATION_EMAIL_JOB]: sendVerificationEmailHandler,
        [DATA_RETENTION_JOB]: enforceDataRetentionJob,
        [OUTBOX_RELAY_JOB]: outboxRelay,
        [DISPATCH_DOMAIN_EVENT_JOB]: dispatchDomainEventJobHandler,
        [SEND_WELCOME_EMAIL_JOB]: sendWelcomeEmailJobHandler,
      }),
      logger,
    }),
)
  .singleton()
  .disposer((worker) => worker.close()),
```

Once the name is in `JOB_NAMES`, the compiler holds you to the rest: omitting the record entry fails with `TS2345` naming the missing key, and filing a handler under the wrong key fails with `TS2418`. Both are reported in `container.ts`. Pinning `typeof SEND_WELCOME_EMAIL_JOB` in the handler's `implements` clause (Step 2) is what makes the second check meaningful — a handler left at the `string` default satisfies every key alike.

That guarantee is bounded to the **consumer** side: a registered handler can no longer be dropped from the worker. It does not mean no job can dead-letter. `JobQueue.enqueue(jobName: string, …)` still takes a plain string, so a producer can enqueue a name no handler claims, and the worker will throw `No handler registered for job "email.send-welcome"` when it tries to process it.

**Step 4 — Enqueue it from a producer.** Any component that injects `jobQueue` (a use case, another job handler) enqueues work:

```ts
await this.jobQueue.enqueue<SendWelcomeEmailPayload>(SEND_WELCOME_EMAIL_JOB, {
  userId: user.id,
  email: user.email.toString(),
});
```

Pass options to override the defaults — `enqueue(SEND_WELCOME_EMAIL_JOB, payload, { attempts: 5, delayMs: 60_000 })` makes up to five attempts (the initial try plus four retries) and waits a minute before the first attempt. For a **recurring** job instead, register it once at bootstrap the way `src/start-worker.ts` schedules the outbox relay and data-retention jobs:

```ts
await container.resolve('jobScheduler').schedule(SEND_WELCOME_EMAIL_JOB, {}, { everyMs: 60_000 });
```

### Deduplicating an at-least-once producer

If your producer cannot guarantee it enqueues exactly once — because it writes to the database and to Redis in two steps that cannot share a transaction — pass a `deduplicationKey` so that a replay is a no-op rather than a second delivery:

```ts
await jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, payload, { deduplicationKey: row.id });
```

`BullMqJobQueue` maps the key onto a BullMQ `jobId`, namespaced as `` `${jobName}.${key}` `` because job ids are unique per **queue** and every producer shares the `default` queue. BullMQ's `add` script returns early when a job with that id already exists, so the replay neither re-queues nor overwrites the original payload — no error, no duplicate.

Three constraints come with it:

- **The horizon is `removeOnComplete`, not forever.** A job id stays recognisable only while the job is retained: 1 hour / 1 000 completed entries. That comfortably covers crash-restart replay (seconds), but it is **not** a substitute for idempotent handlers — see [At-least-once delivery](#design-decisions--trade-offs) below.
- **The key is scoped to the job name.** The same key under two job names produces two distinct jobs. Other adapters may scope differently (an SQS `MessageDeduplicationId` is queue-wide), so treat the per-job-name scope as the documented contract.
- **Pass an opaque identifier, not structured text.** BullMQ rejects custom ids containing `:` in a two-segment id, and because job names already contain dots, `` `${jobName}.${key}` `` is not injective for keys that themselves contain dots. A UUID or database primary key is the intended shape.

**Viewing jobs in Bull Board.** To inspect the queue locally, set `BULL_BOARD_ENABLED=true` and a `BULL_BOARD_PASSWORD` in your `.env`, then browse to `http://localhost:8000/admin/queues` and authenticate with `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD`. Leave `BULL_BOARD_READONLY=true` unless you specifically need to retry or remove jobs from the UI.

## Design decisions & trade-offs

- **Durable, Redis-backed queue instead of in-process scheduling.** Jobs are persisted in Redis by BullMQ, so an enqueued job outlives the request that created it, survives a process restart or crash, and can be picked up by any worker instance. An in-process alternative (`setInterval`, an in-memory array) would lose all pending work on restart and could not be shared across horizontally scaled instances. This is a standing project decision: **all** background and scheduled work goes through BullMQ, never in-process. The accepted cost is that Redis becomes a required infrastructure dependency (the service cannot run without it) and payloads must be JSON-serializable.
- **Automatic retries with exponential backoff.** `BullMqJobQueue` defaults every job to `attempts: 3` and `backoff: { type: 'exponential', delay: 1000 }` — 3 total attempts, the initial try plus 2 retries, with exponential backoff of ~1 s then ~2 s before the job is marked failed — with no retry bookkeeping in application code. Callers that need different behaviour override `attempts` through `JobOptions`; the backoff curve itself is fixed in the adapter. Exhausting `attempts` is **not** the only route into the failed set: an `UnrecoverableError`, a `job.discard()`, a custom backoff returning `-1`, and a job that stalls past `maxStalledCount` all stop the retry loop early. The worker reports all of them uniformly by reading `job.finishedOn` rather than counting attempts.
- **The dead-letter signal is a log line, not a metric.** A job BullMQ declines to retry is logged once at `error` as `'Job dead-lettered, no retry remains'`, carrying the job name and id — and because the outbox relay uses the outbox row id as its deduplication key, that job id traces a dead-lettered event back to the exact database row that produced it. It is also retained in the failed set for 7 days and inspectable in Bull Board when `BULL_BOARD_ENABLED=true` (it defaults to `false`, so until it is enabled the log line is the only signal). A counter would be the better signal, but the worker process exposes no `/metrics` endpoint today — `metricsRoutes` is registered only in `buildApp`, not on the worker's health app — so a counter would increment a registry nothing renders. Alloy already forwards the log to Loki, so the signal is observable today; exposing `/metrics` from the worker is the natural follow-up.
- **At-least-once delivery — handlers must be idempotent.** Because BullMQ retries a failed attempt, a job can execute more than once for the same logical unit of work. The outbox relay's crash-replay — historically a second source of duplicates — is now suppressed within the completed-job retention window by its `deduplicationKey` (see [Deduplicating an at-least-once producer](#deduplicating-an-at-least-once-producer)), but that window is bounded and does not remove the obligation. Handlers must therefore be idempotent: derive a stable key from the payload and dedupe on it — a `SEND_WELCOME_EMAIL_JOB` handler, for instance, should record that a given user has been emailed and skip a second send — rather than assuming exactly-once delivery. The transport deliberately does not chase exactly-once, which on a distributed queue costs far more than making individual handlers safe to re-run.
- **One shared queue with name-based routing, not a queue per job type.** Every job is added to the single `default` queue, and `JobWorker` dispatches by `job.name` through a `Map<string, JobHandler>` built once at construction. This keeps the wiring to exactly one queue and one worker, which is appropriate at the current low volume. The trade-off is no isolation between job types: a burst of one job competes for the same `QUEUE_CONCURRENCY` budget as every other. Splitting hot jobs onto dedicated queues is a later change if throughput or priority demands it.
- **Repeatable and delayed are deliberately separate concerns.** Recurring work is a `JobScheduler.schedule` (`everyMs`) call that maps to BullMQ's `upsertJobScheduler`; a one-off delayed job is a `JobQueue.enqueue` call with `delayMs`. Splitting them keeps a producer that only ever enqueues from having to see scheduling APIs, and `upsert` makes rescheduling idempotent — re-running bootstrap re-registers the same repeatable job under its `jobName` key rather than stacking duplicates.
- **Trace context rides the payload so async work stays inside the request's trace.** Rather than losing the causal link when work crosses the queue, `BullMqJobQueue` injects the active OpenTelemetry context into the job payload under a reserved `__otelCarrier` key, and `JobWorker` extracts it and runs the handler within that context, stripping the carrier before the handler sees the data. The alternative — treating each worker execution as a fresh, unlinked trace — would make it impossible to follow a slow request into the async work it spawned. The cost is a small, reserved key on object payloads (primitives and span-less enqueues are untouched); the mechanism is isolated in `job-trace-context.ts` (part of the app's [distributed tracing](./tracing.md)) so handlers and producers never deal with it directly.
- **Two separate Redis connections, one for producing and one for the worker.** `container.ts` registers `redisConnection` (used by `BullMqJobQueue`, `BullMqJobScheduler`, and the dashboard queue) and `workerConnection` (used by `JobWorker`) as distinct ioredis singletons. A BullMQ worker holds a _blocking_ connection while it waits for jobs; sharing that socket with the producer side would stall enqueues. Both are created via `createRedisConnection` with `maxRetriesPerRequest: null`, which BullMQ requires so its blocking commands are never aborted mid-wait.
- **Bounded retention so Redis does not grow without limit — but completed-job retention is now correctness-relevant.** Completed jobs are trimmed to 1 hour / 1 000 entries and failed jobs to 7 days / 5 000 entries (`removeOnComplete` / `removeOnFail`). Failures are kept long enough to inspect. **Do not treat `removeOnComplete` as a pure size cap:** BullMQ deduplicates an `add` only while a job with that id is still _known to the queue_, so `removeOnComplete` is exactly what bounds the deduplication window for at-least-once producers. Shrinking its `age` or `count` to reclaim Redis memory narrows the window in which a crash-replay is suppressed, and **no test would fail** if you did. Under a burst of more than 1 000 completed jobs within an hour, the oldest ids are evicted and a replay of those rows would be delivered twice — which is why idempotent handlers remain mandatory.
- **The queue dashboard is defence-in-depth, off by default.** Bull Board exposes queue internals, so it ships behind several layers rather than one: (1) it is only registered when `BULL_BOARD_ENABLED=true`, so production must opt in; (2) it sits behind HTTP basic auth whose validator compares credentials in **constant time** (SHA-256 digest + `timingSafeEqual`) to resist timing attacks, and **fails closed** — if the configured username or password is empty, every request is rejected rather than waved through; (3) `assertProductionSecrets` refuses to boot a production process that enables the board with a `BULL_BOARD_PASSWORD` shorter than 16 characters; (4) it defaults to `BULL_BOARD_READONLY=true` so viewing cannot mutate the queue; and (5) every response carries a restrictive `Content-Security-Policy`. The read side uses a dedicated `dashboardQueue` — a separate BullMQ `Queue` handle over the shared `redisConnection` — so the UI introspects the queue without reaching into the producer's or worker's internal `Queue`/`Worker` objects.
- **`EXAMPLE_JOB` ships as a dormant template, not a live job.** It is fully wired into the worker and unit-tested so the wiring is demonstrably correct, but no production path enqueues `example.ping` (only the transport tests do). It is included purely as a working, copy-pasteable starting point for real jobs — documented explicitly so a reader does not mistake it for production work.

## Testing

Coverage spans unit tests for the pieces that can be exercised in isolation and integration tests that stand up a real Redis (via testcontainers) to prove the transport end-to-end.

- **`src/application/jobs/example-job-handler.test.ts`** (unit) asserts that `ExampleJobHandler.jobName` equals `EXAMPLE_JOB` and that `handle` logs `'Example job processed'` with the payload's `message`. It exercises the demo handler, not the transport.
- **`src/application/jobs/send-verification-email-handler.test.ts`** (unit) asserts that `SendVerificationEmailHandler.jobName` equals `SEND_VERIFICATION_EMAIL_JOB`, that `handle` sends exactly one message to the payload's address carrying the rendered subject/text/html, and that a delivery failure propagates so the worker retries rather than swallowing it.
- **`src/job-catalogue.test.ts`** (unit) closes the one gap the type system cannot: `JOB_NAMES` is hand-maintained, so the compiler forces the record to be _complete_ for the names listed but cannot force a new name to be listed at all. The test scans every non-generated, non-test `.ts` file under `src/` for `readonly jobName = …` declarations, resolves each to its string value (following exported constants, and accepting inline literals or a Prettier-wrapped declaration), and asserts that set equals `JOB_NAMES`. It keys on what actually determines routing rather than on a naming convention, so a handler whose name is missing from the catalogue fails here.
- **`src/infrastructure/jobs/job-trace-context.test.ts`** (unit) covers the trace-propagation helpers directly: `injectTraceContext` envelopes an object payload with a carrier carrying the `traceparent` when a span is active, and returns the payload untouched with no active span or for a primitive; `runWithExtractedContext` restores a context whose active span `traceId` equals the injected one, and runs the callback directly when the payload has no carrier; `stripTraceContext` removes the `__otelCarrier` envelope and leaves carrier-less, null-carrier, or primitive payloads intact.
- **`src/infrastructure/jobs/bullmq-job-queue.test.ts`** (unit) covers the producer adapter against a mocked BullMQ `Queue`: the default retry and backoff policy, the retention settings (asserted explicitly as the deduplication horizon), that `jobId` is **omitted entirely** when no key is supplied, that a supplied key is namespaced as `` `${jobName}.${key}` ``, that the same key under two job names yields two distinct ids, and that the generated id satisfies BullMQ's custom-id rules (does not round-trip through `parseInt`, contains no `:`).
- **`src/infrastructure/jobs/job-worker.test.ts`** (unit) covers the consumer adapter against a mocked BullMQ `Worker`: handler routing by job name, the no-handler throw, and every failure path — warn while a retry is pending, error once BullMQ has declined to retry, error when attempts remain but the error was unrecoverable (this case would pass under an `attemptsMade`-based predicate and fail under a correct one), a retried job whose `finishedOn` was reset to `null` treated as still retrying (guarding the `!= null` comparison against a "strictness cleanup" to `!== undefined`), a `failed` emission with no job at all, and the `stalled` listener.
- **`src/presentation/http/plugins/bull-board.test.ts`** (unit) covers the dashboard guard: `createBasicAuthValidator` rejects when credentials are unconfigured (empty password), rejects mismatched credentials, and accepts an exact match; wired into `@fastify/basic-auth` it passes a request through on valid credentials and challenges with `401` on wrong ones; and `bullBoardPlugin` itself, mounted on a bare Fastify app with a stubbed `dashboardQueue`, answers an unauthenticated `GET /admin/queues` with `401` while stamping the expected `Content-Security-Policy` header.
- **`src/application/retention/enforce-data-retention-job.test.ts`** (unit) covers the data-retention handler's orchestration over its `RetentionTask` list independently of Redis or the worker.
- **`test/integration/jobs/job-queue.int.test.ts`** (the `BullMQ job round-trip` block) is the dedicated transport test. It starts a real Redis via testcontainers (`redis:7.4-alpine`) and constructs `BullMqJobQueue` and `JobWorker` directly. Case one — _"routes an enqueued job to its registered handler"_ — enqueues `EXAMPLE_JOB` with `{ message: 'hello' }` and asserts the registered handler receives that exact payload, covering the enqueue → worker → handler delivery path. Case two — _"logs a failure when a job has no registered handler"_ — wires a worker with an empty handler list, enqueues `'unregistered.job'` with payload `{ message: 'x' }` and options `{ attempts: 1 }`, and asserts the worker's `failed` listener logs metadata matching `{ jobName: 'unregistered.job' }`. With `attempts: 1` the job dead-letters on its first failure, so the message it now hits is `'Job dead-lettered, no retry remains'`; the assertion checks metadata rather than the message, so it is unaffected.
- **`test/integration/jobs/job-queue-deduplication.int.test.ts`** (the `BullMqJobQueue deduplication` block) is the contract test for the deduplication semantics the design rests on — a mock cannot prove them. Against a testcontainers Redis it asserts two cases, each under its own queue prefix. Case one collapses a replay onto a job still sitting in `wait` and checks the retained job kept the **original** payload, proving the replay did not overwrite it. Case two is the load-bearing one: it lets a worker run the job to completion, **closes the worker before replaying** (with a live consumer a wrongly-enqueued duplicate could be drained before the assertion reads the wait list, making the test a coin flip), then asserts the replay adds nothing — which only holds because `removeOnComplete` retains the id.
- **`test/integration/jobs/job-tracing.int.test.ts`** (the `BullMQ trace-context propagation` block) proves the trace crosses the real queue. Against a testcontainers Redis it enqueues `EXAMPLE_JOB` from within an active span and asserts that the handler, running on the worker, observes an active span whose `traceId` equals the enqueuing trace — end-to-end evidence that `injectTraceContext`/`runWithExtractedContext` stitch the two execution contexts together through Redis.
- **`test/integration/outbox.int.test.ts`** (the `relay (BullMQ)` block) also exercises `BullMqJobQueue` and `JobWorker` end-to-end, as a side effect of testing the outbox relay (see [domain-events.md](./domain-events.md)). It starts a real Redis via testcontainers, constructs a real `BullMqJobQueue` and `JobWorker`, and drives the full `create → relay → worker → handler` path, asserting a `UserCreatedEvent` is delivered to the registered handler.
- **`test/integration/data-retention.int.test.ts`** (the `data retention (outbox)` block) resolves `enforceDataRetentionJob` from the container and calls `handle()` directly against a real database, asserting that delivered outbox rows older than the retention window are deleted while recent and unpublished rows survive. It exercises the retention handler, not the scheduler that fires it.
- **No dedicated tests** exist for `BullMqJobScheduler` or `createRedisConnection`. The scheduler's `upsertJobScheduler` registration and the shared Redis-connection factory run only through the container wiring at runtime — no test schedules a repeatable job or builds its connections through `createRedisConnection`; integration tests construct their ioredis clients inline with `new Redis(...)` and invoke handlers directly rather than via the scheduler.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`); they require Docker for the Redis (and database) testcontainers the harness spins up.
