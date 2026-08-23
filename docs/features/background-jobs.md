# Background Jobs

> **Status:** Complete · **Layers:** application, infrastructure, presentation, composition root · **Verified against:** `7150871`

## Purpose

Some work should not happen inside the HTTP request that triggers it: it may be slow, may fail transiently and need retrying, or should keep running on a schedule regardless of traffic. Background jobs move that work off the request path onto a durable, Redis-backed queue so it survives process restarts, retries automatically, and can be spread across multiple worker instances. This feature is the generic **transport**: two producer ports (`JobQueue` for one-off work, `JobScheduler` for recurring work), a consumer port (`JobHandler`), and the BullMQ adapters behind them. It also ships a separate worker process and a guarded [Bull Board](https://github.com/felixmosh/bull-board) web dashboard for operational visibility — and any part of the application can use all of it without knowing that Redis or BullMQ is underneath.

## How it works

There are two sides: producers put jobs on the queue, and a worker takes them off and runs the matching handler. Both talk to one BullMQ queue named `default` (namespaced in Redis by `QUEUE_PREFIX`). Producers run in whichever process enqueues — normally the API process (`src/main.ts`) — while consumption happens only in the worker process (`src/worker.ts`), which is started separately (`npm run start:worker`, or `npm run dev` which runs both under `concurrently`).

**Both processes build the same container.** `src/main.ts` and `src/worker.ts` each call `createAppContainer(baseLogger)` from `src/container.ts`, which creates an Awilix container with the shared `APP_CONTAINER_OPTIONS` (`src/container-options.ts` — `{ injectionMode: InjectionMode.PROXY, strict: true }`) and registers `createRegistrations(baseLogger)`. Two Awilix terms recur below and are worth fixing now. The **cradle** is the container's property bag: reading `container.cradle.<name>` resolves the registration filed under that name, constructing it on first read (and, for a `.singleton()`, caching it thereafter). **`InjectionMode.PROXY`** means a registered class or factory is handed the whole cradle and takes what it names — a constructor that destructures `{ jobQueue, logger }` receives whatever is registered under `jobQueue` and `logger`, with no explicit argument list anywhere.

There is no separate worker wiring: the worker sees the same `jobQueue`, `jobScheduler`, `jobWorker`, and handler registrations from `src/composition/jobs.ts` that the API sees. What differs is only which of them each process resolves — the PROXY cradle is lazy, so a registration that is never asked for is never constructed, and the API process therefore never builds a `Worker` while the worker process never builds the dashboard queue.

**At API-app build time, in `buildApp` (`src/presentation/http/app.ts`):** when `BULL_BOARD_ENABLED` is true, and only then, the dashboard is wired:

```ts
if (env.BULL_BOARD_ENABLED) {
  await app.register(bullBoardPlugin, { dashboardQueue: container.cradle.dashboardQueue });
}
```

The plugin receives the BullMQ `Queue` it should display as a **plugin option**; it does not reach into a container itself (see [Design decisions](#design-decisions--trade-offs)). Because a cradle read is what triggers construction, placing `container.cradle.dashboardQueue` _inside_ the `if` is what keeps the resolution lazy — see [Bull Board dashboard](#bull-board-dashboard--operational-visibility). When the flag is false (the default) neither the plugin nor the queue behind it is ever constructed.

**At bootstrap, in the worker process (`src/worker.ts` → `startWorker` in `src/start-worker.ts`):**

1. **The worker starts and indexes its handlers by `jobName`.** `void container.resolve('jobWorker')` resolves the `JobWorker` singleton. Constructing it calls `new Worker('default', …)`, which immediately opens a _blocking_ connection to Redis — a connection dedicated to parking until the next job arrives, so it can serve no other commands while it waits — and begins consuming jobs. Its constructor takes the handler list assembled in `src/composition/jobs.ts` and indexes them into a `Map` keyed by each handler's `jobName`, which is what `process` later looks up. How that list is made exhaustive and collision-free is a contract detail — see [`JobHandler`](#ports--the-contract-another-engineer-programs-against).
2. **Two recurring jobs are scheduled.** `startWorker` resolves `jobScheduler` and calls `schedule` twice — these are the only two `schedule` calls in the codebase:
   - `jobScheduler.schedule(OUTBOX_RELAY_JOB, {}, { everyMs: OUTBOX_RELAY_INTERVAL_MS })` registers `outbox.relay` as a repeatable job that BullMQ re-enqueues every `5_000` ms.
   - `jobScheduler.schedule(DATA_RETENTION_JOB, {}, { everyMs: DATA_RETENTION_INTERVAL_MS })` registers `data.retention` as a repeatable job that fires hourly (`60 * 60 * 1000` ms).
3. **The worker exposes its own health/metrics surface.** The worker's health app (`buildHealthApp`) listens on `WORKER_PORT`, so the worker process is independently probeable ([health-checks.md](./health-checks.md)) and scrapeable ([metrics.md](./metrics.md)) even though it serves no application routes.

**From then on, at runtime:**

4. **A producer enqueues.** Any component with the `jobQueue` dependency calls `jobQueue.enqueue(jobName, payload, options?)`. `BullMqJobQueue` translates that into `queue.add(jobName, injectTraceContext(payload), …)`, attaching the default retry, backoff, and retention policy. BullMQ persists the job in Redis.
5. **The worker picks it up.** `JobWorker.process(job)` looks up `this.handlers.get(job.name)`. If no handler is registered it throws `No handler registered for job "<name>"`; otherwise it awaits `handler.handle(stripTraceContext(job.data))`, passing the stored payload straight through.
6. **Success or failure.** On success BullMQ removes the job per the retention policy. On failure it retries with exponential backoff — 3 total attempts (the initial try plus 2 retries), spaced roughly 1 s then 2 s. BullMQ emits its `failed` event after **every** failed attempt (not only the last), so the worker's listener distinguishes the two cases rather than logging them alike: while a retry is still pending it logs `'Job attempt failed, retry pending'` at **warn**, and once BullMQ has decided against retrying it logs `'Job dead-lettered, no retry remains'` at **error**. **Dead-lettered** here means only that BullMQ has stopped retrying and parked the job in this queue's _failed set_ (retained 7 days, inspectable in Bull Board); there is no separate dead-letter queue — the failed set lives on the same `default` queue as everything else. The worker reads the retry decision off `job.finishedOn`, which BullMQ assigns only in the non-retry branch — so all four ways a job can stop retrying (attempts exhausted, `UnrecoverableError`, `job.discard()`, or a custom backoff returning `-1`) land in the dead-letter branch, where comparing `attemptsMade` against `opts.attempts` would catch only the first. Both log lines carry `{ jobName, jobId, error }`; BullMQ can emit `failed` with no job object at all (a lock lost outside a running handler, for instance), and `JobWorker` substitutes the literal `'unidentified'` for the missing name so the line is still parseable.
7. **Stalls — and why a stall can duplicate work.** If a worker dies mid-job its processing lock expires, and BullMQ's stalled check returns the job to the wait list entirely inside Lua — emitting only `'stalled'`, never `'failed'`. The worker's `stalled` listener logs `'Job stalled, its processing lock expired'` at **warn**, so that first stall is visible. This is the concrete reason handlers must be idempotent: a worker that crashes _after_ its side effect has landed but _before_ it acknowledges the job loses its lock, and the job is returned to the wait list and re-run **from the top** — the email is sent twice, the sweep runs twice. BullMQ cannot know the side effect already happened. Once a job exceeds `maxStalledCount` (default 1), BullMQ raises the next pickup as an `UnrecoverableError`, which lands in the dead-letter branch above.

**When Redis is unavailable.** Redis is a hard dependency of this transport, and it fails in three distinct ways worth knowing before you debug one:

- **Producer side — the caller stalls, it does not error.** `createRedisConnection` builds every ioredis client with `maxRetriesPerRequest: null` (`src/infrastructure/jobs/redis-connection.ts`), which BullMQ requires so its blocking commands are never aborted mid-wait. Combined with ioredis's offline queue (on by default), a command issued while Redis is unreachable is **buffered and retried on reconnect rather than rejected**. `BullMqJobQueue.enqueue` awaits `queue.add`, so a producer that enqueues during a Redis outage hangs on that await instead of throwing — the request that triggered it hangs with it, until the transport-level `REQUEST_TIMEOUT_MS` cuts the connection. Do not expect a rejected promise to surface a Redis outage.
- **Worker boot — no health port opens at all.** `src/worker.ts` awaits `startWorker(container)` **before** `healthApp.listen(…)`, and `startWorker` awaits two `scheduler.schedule` calls, each of which is a Redis command over the same buffering connection. With Redis unreachable at boot, those awaits never settle: the worker never reaches `listen`, so nothing is bound to `WORKER_PORT`, and `bootstrap().catch(…)` never fires because nothing rejected. The process is alive and silent. What surfaces the fault is the container healthcheck — compose's `worker` service probes `http://127.0.0.1:8001/health/live`, the connection is refused, and after `retries: 3` the container is marked unhealthy.
- **Readiness — a bounded, explicit signal.** Once the health app _is_ listening, `RedisHealthCheck` (`src/infrastructure/jobs/redis-health-check.ts`) is the component that reports the outage. It `PING`s over its own connection and races that against `HEALTHCHECK_TIMEOUT_MS` (default `2000`), so a hung Redis fails the check within a bounded time rather than hanging the probe. A non-`PONG` reply, a connection error, or the timeout fails the composite check and flips `/health/ready` to unhealthy on both processes, while `/health/live` — which touches no dependency — stays up. See [health-checks.md](./health-checks.md).

**Trace-context propagation across the queue.** A job is produced in one execution context (an HTTP request, or a scheduled job) and consumed later in a different one on the worker — in a different process — joined only by a row in Redis. To keep those two halves inside the same distributed trace, `BullMqJobQueue.enqueue` calls `injectTraceContext(payload)` before adding the job: if an OpenTelemetry span is active, it serializes the current context into a carrier — a plain key/value object OpenTelemetry writes the W3C `traceparent` into — and envelopes the payload as `{ ...payload, __otelCarrier: carrier }`. On the consuming side, `JobWorker.process` runs the handler inside `runWithExtractedContext(job.data, …)`, which re-establishes that context, then hands the handler `stripTraceContext(job.data)` so it never sees the carrier key. Primitive payloads, and payloads enqueued with no active span, pass through untouched. This propagation lives entirely in `src/infrastructure/jobs/job-trace-context.ts`; the end-to-end tracing story it plugs into is documented in [tracing.md](./tracing.md), and the request-scoped log correlation id is a sibling concern in [structured-logging.md](./structured-logging.md).

**Graceful shutdown.** On a termination signal (`registerGracefulShutdown` wraps `close-with-grace` with a 10 s cap), the worker process runs `createWorkerShutdown` (`src/worker-shutdown.ts`), which closes the health app and then — in a `finally`, so a health-app failure cannot skip it — disposes the container, running the Awilix `.disposer`s registered in `src/composition/jobs.ts` and `src/composition/health.ts`. Awilix disposes only what was actually resolved, so in the worker that means `jobWorker`, `jobScheduler`, `jobQueue` (resolved through the outbox relay), and `healthCheckRedisConnection` (resolved when `buildHealthApp` was handed `container.cradle.healthCheck`), while `dashboardQueue` — never resolved there — has nothing to dispose. `JobWorker.close()` closes the worker and quits its `workerConnection`; `BullMqJobQueue.close()` closes its queue and quits the shared `redisConnection`; the scheduler and dashboard queues close their queue objects (they share `redisConnection`, which the queue disposer quits). The health-probe connection is the one exception to that pattern: its disposer calls `.disconnect()`, not `.quit()`, because it holds no queue whose in-flight commands need draining — dropping the socket immediately is correct for a probe and avoids waiting on a Redis that may be exactly what is broken. In-flight work drains and no socket is left dangling. The API process reaches the same disposers through `app.close()`, because `fastifyAwilixPlugin` is registered with `disposeOnClose: true`. See [graceful-shutdown.md](./graceful-shutdown.md).

## Architecture

The feature is split across the port/adapter boundary. The application layer owns three abstractions — `JobQueue` (enqueue one-off work), `JobScheduler` (register recurring work), and `JobHandler` (the contract a consumer implements) — expressed with no reference to BullMQ or Redis. The infrastructure layer holds the only code that knows the transport: `BullMqJobQueue`, `BullMqJobScheduler`, and `JobWorker`. The presentation layer adds `bullBoardPlugin`, a Fastify plugin that exposes the queue over an operational web UI. Dependencies point inward: a producer depends on the `JobQueue`/`JobScheduler` _interfaces_, a job handler implements the `JobHandler` _interface_, and the concrete BullMQ adapters are bound to those interfaces **only** in `src/composition/jobs.ts`. Replacing BullMQ (e.g. with SQS or an in-memory fake for tests) means writing new adapters and rebinding a few registrations — no application code changes. The one deliberate exception to the inward rule is `bullBoardPlugin`, which is a BullMQ dashboard and nothing else, and says so in its own signature rather than hiding it.

| Component                                                                 | Layer              | Responsibility                                                                                                                 | File                                                             |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `JobQueue`                                                                | Application (port) | Contract to enqueue a one-off (optionally delayed, optionally deduplicated) job                                                | `src/application/shared/ports/job-queue.ts`                      |
| `JobScheduler`                                                            | Application (port) | Contract to register a repeatable job that fires on a fixed interval                                                           | `src/application/shared/ports/job-scheduler.ts`                  |
| `JobHandler`                                                              | Application (port) | Contract a consumer implements: a `jobName` to bind to and an async `handle(payload)`                                          | `src/application/shared/ports/job-handler.ts`                    |
| `EXAMPLE_JOB` / `ExampleJobPayload`                                       | Application        | Demo job name (`example.ping`) and payload shape — a template, never enqueued by production code                               | `src/application/jobs/example-job.ts`                            |
| `ExampleJobHandler`                                                       | Application        | Demo handler that logs its payload — the worked template for new jobs (dormant)                                                | `src/application/jobs/example-job-handler.ts`                    |
| `SEND_VERIFICATION_EMAIL_JOB` / `SendVerificationEmailPayload`            | Application        | Job name (`email.send-verification`) and payload (`email`, `code`)                                                             | `src/application/jobs/send-verification-email-job.ts`            |
| `SendVerificationEmailHandler`                                            | Application        | Renders the verification email and sends it through the `EmailSender` port                                                     | `src/application/jobs/send-verification-email-handler.ts`        |
| `SEND_PASSWORD_RESET_EMAIL_JOB` / `SendPasswordResetEmailPayload`         | Application        | Job name (`email.send-password-reset`) and payload (`email`, `token`)                                                          | `src/application/jobs/send-password-reset-email-job.ts`          |
| `SendPasswordResetEmailHandler`                                           | Application        | Builds the reset URL from `passwordResetUrlBase` + the token, renders and sends the email                                      | `src/application/jobs/send-password-reset-email-handler.ts`      |
| `REVOKE_USER_SESSIONS_JOB` / `RevokeUserSessionsPayload`                  | Application        | Job name (`auth.revoke-user-sessions`) and payload (`userId`)                                                                  | `src/application/jobs/revoke-user-sessions-job.ts`               |
| `RevokeUserSessionsHandler`                                               | Application        | Revokes every refresh token for the payload's user at the current instant                                                      | `src/application/jobs/revoke-user-sessions-handler.ts`           |
| `EnforceDataRetentionJob`                                                 | Application        | Scheduled handler (`data.retention`) that prunes stale rows via its `RetentionTask` list                                       | `src/application/retention/enforce-data-retention-job.ts`        |
| `OutboxRelay`                                                             | Infrastructure     | Scheduled handler (`outbox.relay`): reads unpublished outbox rows and enqueues a dispatch job for each                         | `src/infrastructure/events/outbox-relay.ts`                      |
| `DispatchDomainEventJobHandler`                                           | Infrastructure     | Consumes `domain-event.dispatch` and delivers each deserialized event to its in-process handlers                               | `src/infrastructure/events/dispatch-domain-event-job-handler.ts` |
| `BullMqJobQueue`                                                          | Infrastructure     | `JobQueue` adapter: adds jobs with retry/backoff, retention, optional dedup id, and injected trace context                     | `src/infrastructure/jobs/bullmq-job-queue.ts`                    |
| `BullMqJobScheduler`                                                      | Infrastructure     | `JobScheduler` adapter: upserts a BullMQ job scheduler for repeatable jobs                                                     | `src/infrastructure/jobs/bullmq-job-scheduler.ts`                |
| `JobWorker`                                                               | Infrastructure     | Consumes the `default` queue and routes each job to its registered `JobHandler` by name, inside the extracted trace context    | `src/infrastructure/jobs/job-worker.ts`                          |
| `injectTraceContext` / `runWithExtractedContext` / `stripTraceContext`    | Infrastructure     | Propagate the OpenTelemetry trace context across the enqueue → process boundary via a payload carrier                          | `src/infrastructure/jobs/job-trace-context.ts`                   |
| `DEFAULT_QUEUE_NAME`                                                      | Infrastructure     | The single queue name (`'default'`) shared by every producer, the worker, and the dashboard                                    | `src/infrastructure/jobs/queue-name.ts`                          |
| `createRedisConnection`                                                   | Infrastructure     | Builds an ioredis client configured for BullMQ (`maxRetriesPerRequest: null`)                                                  | `src/infrastructure/jobs/redis-connection.ts`                    |
| `createDashboardQueue`                                                    | Infrastructure     | Builds a read-side BullMQ `Queue` handle over the `default` queue for Bull Board to introspect                                 | `src/infrastructure/jobs/dashboard-queue.ts`                     |
| `RedisHealthCheck`                                                        | Infrastructure     | Reports Redis reachability, bounded by `HEALTHCHECK_TIMEOUT_MS`, as part of the composite readiness check both processes serve | `src/infrastructure/jobs/redis-health-check.ts`                  |
| `bullBoardPlugin` / `BullBoardPluginOptions` / `createBasicAuthValidator` | Presentation       | Mounts the Bull Board UI over the injected `dashboardQueue`, behind constant-time basic auth and a restrictive CSP             | `src/presentation/http/plugins/bull-board.ts`                    |
| `jobsRegistrations`                                                       | Composition root   | Binds the BullMQ adapters to the three ports, and the handlers to their job names, with disposers                              | `src/composition/jobs.ts`                                        |
| `healthRegistrations`                                                     | Composition root   | Registers `healthCheckRedisConnection` (the probe's own Redis client) and `healthCheckTimeoutMs`                               | `src/composition/health.ts`                                      |
| `JOB_NAMES` / `JobHandlersByName` / `toJobHandlerList`                    | Composition root   | The catalogue of live job names and the mapped type that forces one handler per name                                           | `src/job-catalogue.ts`                                           |
| `createAppContainer` / `APP_CONTAINER_OPTIONS`                            | Composition root   | The single container factory and its `PROXY` + `strict` options, shared by the API and worker processes alike                  | `src/container.ts`, `src/container-options.ts`                   |
| Worker process                                                            | Composition root   | Boots the container, starts the worker, schedules the recurring jobs, serves health/metrics, shuts down gracefully             | `src/worker.ts`, `src/start-worker.ts`, `src/worker-shutdown.ts` |
| `purge-verification-jobs`                                                 | Operational script | Removes dead-lettered `email.send-verification` jobs (whose payloads hold raw codes) from the failed set                       | `src/scripts/purge-verification-jobs.ts`                         |

## Public surface

This feature exposes a programmatic contract (three ports plus the catalogue of job names they route on) and one operational HTTP surface (the dashboard).

### Ports — the contract another engineer programs against

**1. `JobQueue` — enqueue one-off work (inject and call this from a producer).**

```ts
export interface JobOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly deduplicationKey?: string;
}

export interface JobQueue {
  enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>;
}
```

`jobName` selects which handler will run (it must match a handler's `jobName`); `payload` is any JSON-serializable value stored with the job. `options.attempts` overrides the default of 3 total attempts (the initial try plus 2 retries); `options.delayMs` postpones the first attempt by that many milliseconds. `options.deduplicationKey` is a stable, opaque identifier for the unit of work — a key that makes a replayed enqueue a no-op rather than a second delivery: enqueuing the same job name with the same key twice delivers the job once, within the horizon the adapter documents (see [Deduplicating a producer that may enqueue twice](#deduplicating-a-producer-that-may-enqueue-twice)). The key is **scoped to the job name, not global** — the same key under two different job names is two different jobs. Retry backoff and retention are fixed by the adapter and are not caller-tunable.

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

A handler binds to exactly one `jobName` and receives the enqueued payload as `handle`'s argument. The two generics do different jobs. `TPayload` is a compile-time convenience only — the worker passes BullMQ's stored `job.data` (with the trace carrier stripped) straight to `handle` with no runtime schema validation, so the producer and handler must agree on the payload shape. `TName` is load-bearing: pinning it to a job-name literal (`implements JobHandler<MyPayload, typeof MY_JOB>`) is what lets the composition root check the wiring, so **always pin it** rather than leaving it at its `string` default. Delivery is **at-least-once** — BullMQ retries a failed attempt, a stalled job is re-run from the top, and the outbox relay can re-enqueue a dispatch job after a crash — so `handle` may run more than once for the same logical job and **must be idempotent**: dedupe on a stable key, or make the operation naturally repeatable, rather than assuming exactly-once.

A handler becomes reachable when it is filed in the worker's handler record in `src/composition/jobs.ts`. That record's type does the enforcing. `src/job-catalogue.ts` declares `JOB_NAMES` as an `as const` list, derives the `JobName` union from it, and derives `JobHandlersByName` as a **mapped type over that union** — one required slot per live job name, each typed `JobHandler<unknown, TJobName>`. `toJobHandlerList` takes a value of that type and returns its values, which is the list `JobWorker` indexes. So a handler declared but never filed under its job name fails to compile (the record is missing a required key), and a `jobName` cannot collide with another's, because the record gives each name exactly one slot — a second handler under a name already in use is unrepresentable rather than a silent last-one-wins overwrite at boot. [Usage & extension](#usage--extension) walks the exact edits and names which of them the compiler checks.

### The job catalogue today

`src/job-catalogue.ts` is the single list of live job names (`JOB_NAMES`). Seven jobs are registered; four are enqueued on demand by application or infrastructure code, two are enqueued by the scheduler on a fixed interval, and one (`example.ping`) is enqueued only by the transport integration tests.

| Job name                    | Constant                        | Handler                         | Enqueued by                                                                                                                      |
| --------------------------- | ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `email.send-verification`   | `SEND_VERIFICATION_EMAIL_JOB`   | `SendVerificationEmailHandler`  | `RegisterUser` (`src/application/auth/register-user.ts`) and `EditUser` on an email change (`src/application/user/edit-user.ts`) |
| `email.send-password-reset` | `SEND_PASSWORD_RESET_EMAIL_JOB` | `SendPasswordResetEmailHandler` | `RequestPasswordReset` (`src/application/auth/request-password-reset.ts`)                                                        |
| `auth.revoke-user-sessions` | `REVOKE_USER_SESSIONS_JOB`      | `RevokeUserSessionsHandler`     | `ResetPassword` (`src/application/auth/reset-password.ts`)                                                                       |
| `domain-event.dispatch`     | `DISPATCH_DOMAIN_EVENT_JOB`     | `DispatchDomainEventJobHandler` | `OutboxRelay` (`src/infrastructure/events/outbox-relay.ts`), with the outbox row id as `deduplicationKey`                        |
| `outbox.relay`              | `OUTBOX_RELAY_JOB`              | `OutboxRelay`                   | `jobScheduler.schedule` in `src/start-worker.ts`, every 5 s                                                                      |
| `data.retention`            | `DATA_RETENTION_JOB`            | `EnforceDataRetentionJob`       | `jobScheduler.schedule` in `src/start-worker.ts`, hourly                                                                         |
| `example.ping`              | `EXAMPLE_JOB`                   | `ExampleJobHandler`             | **Nothing in production.** Enqueued only by the transport integration tests                                                      |

What each of them is _for_ belongs to the feature that owns it, not here:

- **`email.send-verification` / `email.send-password-reset`** keep SMTP latency and SMTP failures off the registration, profile-edit, and forgot-password responses. Both handlers render their message and hand it to the `EmailSender` port — see [email-sending.md](./email-sending.md), [email-verification.md](./email-verification.md), and [password-reset.md](./password-reset.md).
- **`auth.revoke-user-sessions`** revokes every refresh token for a user after a completed password reset, via `refreshTokenRepository.revokeAllForUser(userId, clock.now())` — see [password-reset.md](./password-reset.md) and [authentication.md](./authentication.md).
- **`outbox.relay` → `domain-event.dispatch`** is the full `schedule → handle → enqueue → process` pipeline: the relay is the only producer that enqueues from _inside_ the worker, and the only one that supplies a `deduplicationKey`. See [domain-events.md](./domain-events.md).
- **`data.retention`** prunes stale rows through its `RetentionTask` list (`refreshTokenRetentionTask`, `outboxRetentionTask`, `passwordResetTokenRetentionTask`) using a cutoff of `now − DATA_RETENTION_TTL`. It enqueues nothing; it touches the database directly. See [data-retention.md](./data-retention.md).
- **`example.ping` is dormant demo scaffolding.** `ExampleJobHandler` is registered in the worker's handler record and unit-tested, but no production code path enqueues `EXAMPLE_JOB` — only `test/integration/jobs/job-queue.int.test.ts` and `test/integration/jobs/job-tracing.int.test.ts` do. It exists purely as a copy-paste template for new jobs (see [Usage & extension](#usage--extension)). This is a scoped caveat about one job, not about the transport: the other six are all reachable from real execution paths.

`src/job-catalogue.test.ts` fails if a handler anywhere in `src/` declares a `jobName` missing from `JOB_NAMES`.

### Bull Board dashboard — operational visibility

An operator-facing web UI for inspecting the `default` queue: pending, active, completed, delayed, and failed jobs. Its env default is **off**, and it is gated behind several guards (see [Design decisions](#design-decisions--trade-offs)) — but note that the repo's own `docker-compose.yml` turns it **on**, with a default password, for every service in the bundled stack; see [Running the worker](#running-the-worker) before you deploy that file anywhere shared.

| Method                                        | Path                                                         | Auth                                                                                                                                 | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `GET` (and Bull Board's own asset/API routes) | all routes under `BULL_BOARD_PATH` (default `/admin/queues`) | HTTP Basic (`Authorization: Basic …`), realm `<APP_NAME> Queues` (default `app Queues`); only mounted when `BULL_BOARD_ENABLED=true` | Browse and (unless `BULL_BOARD_READONLY`) act on queued jobs |

The plugin's own contract is a single required option:

```ts
export interface BullBoardPluginOptions {
  dashboardQueue: Queue;
}

export async function bullBoardPlugin(
  app: FastifyInstance,
  { dashboardQueue }: BullBoardPluginOptions,
): Promise<void>;
```

`Queue` here is BullMQ's own class (`import type { Queue } from 'bullmq'`), not one of this feature's ports — a deliberate, declared coupling explained in [Design decisions](#design-decisions--trade-offs). The caller supplies it; `buildApp` passes `container.cradle.dashboardQueue`, the singleton built by `createDashboardQueue` over the shared `redisConnection`. The plugin wraps it in a `BullMQAdapter` whose `readOnlyMode` follows `BULL_BOARD_READONLY`, mounts Bull Board's route tree via `serverAdapter.registerPlugin()` under `basePath = env.BULL_BOARD_PATH`, and stamps a restrictive `Content-Security-Policy` header on every response through an `onSend` hook. Everything else it reads — path, credentials, read-only flag — comes from `env` directly. The dashboard is mounted on the **API app**, not the worker's health app: it needs only Redis, not the worker process.

## Configuration

Read from `src/config/env.ts` (`.env.example` lists the same keys):

| Variable                  | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_NAME`                | `app`                                                  | The one identity knob. It supplies `QUEUE_PREFIX`'s default and the dashboard's basic-auth realm (`appIdentity.bullBoardRealm` = `` `${APP_NAME} Queues` ``), among other derived names — see `src/config/app-identity.ts`.                                                                                                    |
| `REDIS_URL`               | `redis://127.0.0.1:6379` (dev/test only)               | Connection string for the Redis instance that backs BullMQ. Declared with `devDefault`, so it has **no** production default — it is required when `NODE_ENV=production` and is only defaulted in development/test.                                                                                                             |
| `QUEUE_PREFIX`            | `app` (from `APP_NAME`)                                | Key prefix BullMQ applies to every queue key in Redis, namespacing this app's jobs.                                                                                                                                                                                                                                            |
| `QUEUE_CONCURRENCY`       | `5`                                                    | Maximum number of jobs the worker processes in parallel.                                                                                                                                                                                                                                                                       |
| `WORKER_PORT`             | `8001`                                                 | Port the worker's health app listens on, serving health and metrics (the API process uses `PORT`).                                                                                                                                                                                                                             |
| `HEALTHCHECK_TIMEOUT_MS`  | `2000`                                                 | Bounds `RedisHealthCheck.check()`'s `PING` (wired as `healthCheckTimeoutMs` in `src/composition/health.ts`), so an unresponsive Redis fails readiness within a known time instead of hanging the probe. Shared with the database health check — owned by [health-checks.md](./health-checks.md).                               |
| `DATA_RETENTION_TTL`      | `2592000` (30 days, in seconds)                        | Age threshold for the `data.retention` job: rows older than `now − DATA_RETENTION_TTL` are pruned. Multiplied by 1000 in `src/composition/retention.ts` to form `dataRetentionWindowMs`.                                                                                                                                       |
| `PASSWORD_RESET_URL_BASE` | `http://localhost:5173/reset-password` (dev/test only) | Read by `SendPasswordResetEmailHandler` as `passwordResetUrlBase`; the raw token is appended as `?token=`. Owned by [password-reset.md](./password-reset.md).                                                                                                                                                                  |
| `BULL_BOARD_ENABLED`      | `false`                                                | Master switch for the dashboard. When false, `bullBoardPlugin` is never registered and `dashboardQueue` is never resolved. The bundled `docker-compose.yml` sets it to `true`.                                                                                                                                                 |
| `BULL_BOARD_PATH`         | `/admin/queues`                                        | Base path the dashboard UI (and its API/asset routes) is mounted under.                                                                                                                                                                                                                                                        |
| `BULL_BOARD_USERNAME`     | `admin`                                                | Basic-auth username for the dashboard.                                                                                                                                                                                                                                                                                         |
| `BULL_BOARD_PASSWORD`     | `''` (empty)                                           | Basic-auth password. **Empty disables login fail-closed** — the validator rejects every request. In production, `assertProductionSecrets` fails boot if the dashboard is enabled and this is shorter than 16 characters. The bundled `docker-compose.yml` supplies a 28-character default that clears that floor; override it. |
| `BULL_BOARD_READONLY`     | `true`                                                 | When true, the dashboard can only view jobs; retry/remove/promote actions are disabled.                                                                                                                                                                                                                                        |

The worker process reads more of the process-wide configuration than the queue keys above. `src/worker.ts` passes `hardening: { ...httpLimits, trustProxy: false }` into `buildHealthApp`, so its health port is governed by `BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`, `KEEP_ALIVE_TIMEOUT_MS`, and `MAX_PARAM_LENGTH` ([http-infrastructure.md](./http-infrastructure.md)) — but **`trustProxy` is hardcoded `false` regardless of the `TRUST_PROXY` env var**, because the worker's health port is not fronted by an ingress and therefore has no proxy whose `X-Forwarded-*` headers could be trusted. It also reads `HOST` and `WORKER_PORT` for `listen`, `LOG_LEVEL` and `METRICS_ENABLED` for its logger and metrics surface ([structured-logging.md](./structured-logging.md), [metrics.md](./metrics.md)), and builds its logger identity from `toServiceIdentity(env)`, which reads `OTEL_SERVICE_NAME`, `NODE_ENV`, and `OTEL_SERVICE_VERSION` ([tracing.md](./tracing.md)).

The two scheduling intervals are code constants, not env vars: `OUTBOX_RELAY_INTERVAL_MS = 5_000` (in `outbox-relay.ts`) and `DATA_RETENTION_INTERVAL_MS = 60 * 60 * 1000` (in `enforce-data-retention-job.ts`). So are the retry and retention policies, fixed in `bullmq-job-queue.ts`.

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

**Step 2 — Implement the handler (application).** Create `src/application/jobs/send-welcome-email-handler.ts`. **Awilix injects by name**: because the container runs in `InjectionMode.PROXY`, every key you destructure in the constructor must match a container registration (`logger`, `emailSender`, `clock`, `jobQueue`, …). A name with no registration is not a compile error — it fails when the class is first resolved, at runtime. Check the `Cradle` declarations in `src/composition/*.ts` for the name you want before you type it.

```ts
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import {
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailPayload,
} from '@/application/jobs/send-welcome-email-job';

export interface SendWelcomeEmailHandlerDeps {
  logger: Logger;
}

export class SendWelcomeEmailHandler implements JobHandler<
  SendWelcomeEmailPayload,
  typeof SEND_WELCOME_EMAIL_JOB
> {
  readonly jobName = SEND_WELCOME_EMAIL_JOB;
  private readonly logger: Logger;

  constructor({ logger }: SendWelcomeEmailHandlerDeps) {
    this.logger = logger;
  }

  handle(payload: SendWelcomeEmailPayload): Promise<void> {
    this.logger.info('Sending welcome email', { userId: payload.userId });
    return Promise.resolve();
  }
}
```

**Step 3 — Register the handler and add it to the worker.** Add the job name to `JOB_NAMES` in `src/job-catalogue.ts`, then in `src/composition/jobs.ts` import the handler, declare it on the `Cradle` **by its port type** (not by its class — that is what keeps the composition root depending on the abstraction), register it, add its key to the `jobWorker` factory's `Pick<Cradle, …>` union, destructure it, and file it in the handler record under its job name:

```ts
// in src/job-catalogue.ts — import the constant, then add it to JOB_NAMES
import { SEND_WELCOME_EMAIL_JOB } from '@/application/jobs/send-welcome-email-job';

export const JOB_NAMES = [
  EXAMPLE_JOB,
  SEND_VERIFICATION_EMAIL_JOB,
  SEND_PASSWORD_RESET_EMAIL_JOB,
  REVOKE_USER_SESSIONS_JOB,
  DATA_RETENTION_JOB,
  OUTBOX_RELAY_JOB,
  DISPATCH_DOMAIN_EVENT_JOB,
  SEND_WELCOME_EMAIL_JOB,
] as const;
```

```ts
// in src/composition/jobs.ts — import at the top
import { SendWelcomeEmailHandler } from '@/application/jobs/send-welcome-email-handler';
import {
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailPayload,
} from '@/application/jobs/send-welcome-email-job';
```

The `Cradle` entry goes **inside the module-augmentation block already at the top of that file** — you are merging one property into the existing `interface Cradle`, not opening a second declaration:

```ts
// src/composition/jobs.ts — the existing augmentation, with one property added
declare module '@fastify/awilix' {
  interface Cradle {
    // …the existing entries: queuePrefix, redisConnection, jobQueue, exampleJobHandler, …
    sendWelcomeEmailHandler: JobHandler<SendWelcomeEmailPayload, typeof SEND_WELCOME_EMAIL_JOB>;
  }
}
```

Each `src/composition/*.ts` module augments the same third-party `Cradle` interface with its own slice; TypeScript merges them into one type. Adding a property to the wrong block still compiles, but it puts the declaration where nobody looking for it will find it — keep the job's declaration in the jobs module.

```ts
// in jobsRegistrations
sendWelcomeEmailHandler: asClass(SendWelcomeEmailHandler).singleton(),

// extend the existing jobWorker factory
jobWorker: asFunction(
  ({
    workerConnection,
    exampleJobHandler,
    sendVerificationEmailHandler,
    sendPasswordResetEmailHandler,
    revokeUserSessionsHandler,
    outboxRelay,
    dispatchDomainEventJobHandler,
    enforceDataRetentionJob,
    sendWelcomeEmailHandler,
    logger,
    queuePrefix,
    queueConcurrency,
  }: Pick<
    Cradle,
    | 'workerConnection'
    | 'exampleJobHandler'
    | 'sendVerificationEmailHandler'
    | 'sendPasswordResetEmailHandler'
    | 'revokeUserSessionsHandler'
    | 'outboxRelay'
    | 'dispatchDomainEventJobHandler'
    | 'enforceDataRetentionJob'
    | 'sendWelcomeEmailHandler'
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
        [SEND_PASSWORD_RESET_EMAIL_JOB]: sendPasswordResetEmailHandler,
        [REVOKE_USER_SESSIONS_JOB]: revokeUserSessionsHandler,
        [DATA_RETENTION_JOB]: enforceDataRetentionJob,
        [OUTBOX_RELAY_JOB]: outboxRelay,
        [DISPATCH_DOMAIN_EVENT_JOB]: dispatchDomainEventJobHandler,
        [SEND_WELCOME_EMAIL_JOB]: sendWelcomeEmailHandler,
      }),
      logger,
    }),
)
  .singleton()
  .disposer((worker) => worker.close()),
```

Nothing else has to change for the worker process to pick the handler up: `src/worker.ts` builds its container through the same `createAppContainer` the API uses, so a registration added here is live in both processes.

**Which of those edits the compiler will catch for you.** Once the name is in `JOB_NAMES`, four of the six edits are compiler-guarded and two are not:

- **Guarded — the handler record must be exhaustive.** Omitting the record entry fails with `TS2345` naming the missing key.
- **Guarded — the record slot must match the handler's pinned name.** Filing a handler under the wrong key fails with `TS2418`. Pinning `typeof SEND_WELCOME_EMAIL_JOB` in the `implements` clause (Step 2) is what makes this check meaningful; a handler left at the `string` default satisfies every key alike.
- **Guarded — a `Cradle` key with no registration.** `createRegistrations` in `src/composition/compose.ts` is annotated `CompleteRegistrations`, a **total** mapped type over `Cradle` (`src/composition/registration-map.ts`). Declaring `sendWelcomeEmailHandler` on the `Cradle` and forgetting to add it to `jobsRegistrations` fails to compile in `compose.ts` — the returned object is missing a required key. The reverse mismatch (a registration whose resolved type does not match the declared port type) is caught by `satisfies RegistrationMap` in the jobs module itself.
- **Guarded — the factory's `Pick` union.** Destructuring a key you did not add to the `Pick<Cradle, …>` union is a type error at the destructure site.
- **Silent — nothing forces a _new_ name into `JOB_NAMES`.** A handler whose name is missing from the catalogue compiles fine; `src/job-catalogue.test.ts` is what fails.
- **Silent — a producer can enqueue a name no handler claims.** `JobQueue.enqueue(jobName: string, …)` takes a plain string, so this guarantee is bounded to the **consumer** side: a registered handler can no longer be dropped from the worker, but a typo'd job name still reaches the worker, which throws `No handler registered for job "email.send-welcome"` when it tries to process it, and the job dead-letters.

**Step 4 — Enqueue it from a producer.** Any component that injects `jobQueue` (a use case, another job handler) enqueues work. Remember the injection convention from Step 2: the container registration is named `jobQueue`, so that is the key the constructor must destructure — the live producers then assign it to a shorter field. `RegisterUser` is the canonical shape:

```ts
export interface SendWelcomeDeps {
  unitOfWork: UnitOfWork;
  jobQueue: JobQueue;
}

export class SendWelcome {
  private readonly uow: UnitOfWork;
  private readonly queue: JobQueue;

  constructor({ unitOfWork, jobQueue }: SendWelcomeDeps) {
    this.uow = unitOfWork;
    this.queue = jobQueue;
  }

  async execute(user: User, email: Email): Promise<void> {
    await this.uow.run(async () => {
      /* persist first */
    });

    const payload: SendWelcomeEmailPayload = { userId: user.id, email: email.toString() };
    await this.queue.enqueue(SEND_WELCOME_EMAIL_JOB, payload);
  }
}
```

The ordering is the point: build a typed payload, then enqueue **after** the database work has committed (see [Design decisions](#design-decisions--trade-offs)).

Pass options to override the defaults — `enqueue(SEND_WELCOME_EMAIL_JOB, payload, { attempts: 5, delayMs: 60_000 })` makes up to five attempts (the initial try plus four retries) and waits a minute before the first attempt. For a **recurring** job instead, register it once at bootstrap the way `src/start-worker.ts` schedules the outbox relay and data-retention jobs:

```ts
await scheduler.schedule(SEND_WELCOME_EMAIL_JOB, {}, { everyMs: 60_000 });
```

### Deduplicating a producer that may enqueue twice

If your producer cannot guarantee it enqueues exactly once — because it writes to the database and to Redis in two steps that cannot share a transaction — pass a `deduplicationKey` so that a replay is a no-op rather than a second delivery. `OutboxRelay` is the one producer that does this today:

```ts
await this.jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, payload, {
  deduplicationKey: message.id,
});
```

`BullMqJobQueue` maps the key onto a BullMQ `jobId`, namespaced as `` `${jobName}.${key}` `` because job ids are unique per **queue** and every producer shares the `default` queue. BullMQ's `add` script returns early when a job with that id already exists, so the replay neither re-queues nor overwrites the original payload — no error, no duplicate.

Three constraints come with it:

- **The horizon is `removeOnComplete`, not forever.** A job id stays recognizable only while the job is retained: 1 hour / 1 000 completed entries. That comfortably covers crash-restart replay (seconds), but it is **not** a substitute for idempotent handlers — see [At-least-once delivery](#design-decisions--trade-offs) below.
- **The key is scoped to the job name.** The same key under two job names produces two distinct jobs. Other adapters may scope differently (an SQS `MessageDeduplicationId` is queue-wide), so treat the per-job-name scope as the documented contract.
- **Pass an opaque identifier, not structured text.** BullMQ rejects custom ids containing `:`, and because job names already contain dots, `` `${jobName}.${key}` `` is not injective for keys that themselves contain dots. A UUID or database primary key is the intended shape.

### Running the worker

Locally, `npm run dev` starts the API and the worker together under `concurrently`; `npm run start:worker` runs the built worker alone (`node --import ./dist/instrumentation.js dist/worker.js`).

The bundled `docker-compose.yml` deploys the worker as its own `worker` service, from the same `runtime` image as `app`, overriding only the command and a little of the environment:

- `command: ['node', '--import', './dist/instrumentation.js', 'dist/worker.js']` — the same entrypoint `npm run start:worker` uses.
- `WORKER_PORT: '8001'`, published as `127.0.0.1:8001:8001` — **loopback only**, so the health and metrics surface is reachable from the host for debugging but never from the network.
- `OTEL_SERVICE_NAME: ${APP_NAME:-app}-worker`, so the worker's traces and logs are distinguishable from the API's (which uses `-api`).
- `stop_grace_period: 15s` with `init: true` — wider than the graceful-shutdown handler's own 10 s cap, so in-flight jobs get to drain before Docker sends `SIGKILL` ([graceful-shutdown.md](./graceful-shutdown.md)).
- A healthcheck that fetches `http://127.0.0.1:8001/health/live` every 30 s (`start_period: 20s`, `retries: 3`). As described under [When Redis is unavailable](#how-it-works), this probe is what surfaces a worker that hung during bootstrap — the process itself stays silent.
- `depends_on` gates the worker on MariaDB and Redis being healthy and on the `migrate` service having completed.

**The bundled stack enables the dashboard.** Both `app` and `worker` inherit the shared `x-app-environment` anchor, which sets `NODE_ENV: production` together with `BULL_BOARD_ENABLED: true`, `BULL_BOARD_USERNAME: admin`, `BULL_BOARD_READONLY: true`, and `BULL_BOARD_PASSWORD: ${BULL_BOARD_PASSWORD:-dev-only-bull-board-password}`. That 28-character default clears `assertProductionSecrets`' 16-character floor, so boot succeeds and `docker compose up` publishes `/admin/queues` on `:8000` behind a password committed to this repository. It is convenient for local work and unsafe anywhere else: **set `BULL_BOARD_PASSWORD` in your environment before running this compose file on any host that is not your laptop**, or set `BULL_BOARD_ENABLED=false`.

### Operating the queue

**Viewing jobs in Bull Board.** Under the bundled compose stack the dashboard is already on: browse to `http://localhost:8000/admin/queues` and authenticate with `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD` (`admin` / `dev-only-bull-board-password` unless you overrode it — and do override it outside a laptop). Running the app outside compose, the env default is off: set `BULL_BOARD_ENABLED=true` and a `BULL_BOARD_PASSWORD` in your `.env` first. Leave `BULL_BOARD_READONLY=true` unless you specifically need to retry or remove jobs from the UI.

**Mounting the dashboard elsewhere.** Because the plugin takes its queue as an option, it can be registered on any Fastify instance without a container — pass any BullMQ `Queue` handle over the queue you want to inspect:

```ts
await app.register(bullBoardPlugin, { dashboardQueue: someQueue });
```

**Purging dead-lettered verification emails.** Failed jobs are retained for 7 days _with their payloads_, and an `email.send-verification` payload carries a raw verification code. `src/scripts/purge-verification-jobs.ts` removes those specific dead-lettered jobs — filtering by job name, because the shared failed set also holds dead-lettered `domain-event.dispatch` jobs which are the only surviving copy of their event. It has no npm script; run it with `npx tsx src/scripts/purge-verification-jobs.ts` against the target environment's `REDIS_URL` and `QUEUE_PREFIX`. See [email-sending.md](./email-sending.md) for the wider secrets-in-payloads discussion.

## Design decisions & trade-offs

- **Durable, Redis-backed queue instead of in-process scheduling.** Jobs are persisted in Redis by BullMQ, so an enqueued job outlives the request that created it, survives a process restart or crash, and can be picked up by any worker instance. An in-process alternative (`setInterval`, an in-memory array) would lose all pending work on restart and could not be shared across horizontally scaled instances. This is a standing project decision: **all** background and scheduled work goes through BullMQ, never in-process. The accepted cost is that Redis becomes a required infrastructure dependency — and, because the transport is configured to buffer and retry rather than fail fast, its absence shows up as stalled awaits and a failing readiness probe rather than as thrown errors ([When Redis is unavailable](#how-it-works)) — and that payloads must be JSON-serializable.
- **A separate worker process, not a worker embedded in the API app.** `src/main.ts` never resolves `jobWorker`; only `src/worker.ts` does. Job execution therefore cannot steal CPU or event-loop time from request handling, and the two can be scaled and restarted independently. The cost is a second process to deploy and observe — which is why the worker serves its own health and metrics endpoints on `WORKER_PORT`, why `docker-compose.yml` carries a dedicated `worker` service with its own healthcheck, and why `npm run dev` starts both under `concurrently`.
- **One container factory for both processes, not a worker-specific wiring.** `src/worker.ts` calls the same `createAppContainer(logger)` as `src/main.ts`, over the same `APP_CONTAINER_OPTIONS` extracted to `src/container-options.ts` so that every process — and the unit-test container helper — agrees on `PROXY` injection and `strict` mode. The alternative, a worker that registers its own subset of dependencies, means two wiring paths that can silently diverge: a handler registered for the API and forgotten in the worker would fail only at runtime, on the first job of that name. The cost is that the worker's container knows about registrations it will never resolve, which the lazy PROXY cradle makes cheap — an unresolved registration is never constructed and never opens a connection.
- **`bullBoardPlugin` takes its queue as a plugin option, typed as BullMQ's concrete `Queue`.** Declaring `dashboardQueue` as a plugin option rather than resolving it from a module-global container puts the dependency in the signature — `bullBoardPlugin(app, { dashboardQueue }: BullBoardPluginOptions)`, matching how `metricsPlugin` takes `{ metricsRecorder }` — instead of hiding it inside the plugin body, and makes the plugin testable with a plain queue double rather than a fake registered into a global container. The type is deliberately **not** a port. This plugin exists solely to mount BullMQ's own dashboard — it already imports `@bull-board/api`, `@bull-board/api/bullMQAdapter`, and `@bull-board/fastify`, and `BullMQAdapter` refuses anything that is neither a real `Queue` nor a `metaValues.version` starting with `bullmq`. An invented `QueueInspector` port would abstract nothing (there is exactly one implementation, and it is BullMQ's) while making the coupling harder to see. Declaring it in the signature is more honest than hiding it behind a string container key.
- **`dashboardQueue` is resolved lazily, inside the `BULL_BOARD_ENABLED` branch, and deliberately not hoisted into `BuildAppOptions`.** The other plugin dependencies `buildApp` passes are cheap objects; this one is not. Resolving `dashboardQueue` runs `createDashboardQueue`, which constructs `new Queue(…)` over the `redisConnection` singleton — itself a `new Redis(url)` — so touching it opens live Redis sockets. Adding `dashboardQueue` to `BuildAppOptions` would force every caller of `buildApp` to resolve it up front, including the integration harness and every test app that never enables the dashboard, and connections opened that way have to be closed again. Keeping the cradle read inside the `if` means the default configuration (`BULL_BOARD_ENABLED=false`) constructs neither the queue nor its connection.
- **Automatic retries with exponential backoff.** `BullMqJobQueue` defaults every job to `attempts: 3` and `backoff: { type: 'exponential', delay: 1000 }` — 3 total attempts, the initial try plus 2 retries, with exponential backoff of ~1 s then ~2 s before the job is marked failed — with no retry bookkeeping in application code. Callers that need different behaviour override `attempts` through `JobOptions`; the backoff curve itself is fixed in the adapter. Exhausting `attempts` is **not** the only route into the failed set: an `UnrecoverableError`, a `job.discard()`, a custom backoff returning `-1`, and a job that stalls past `maxStalledCount` all stop the retry loop early. The worker reports all of them uniformly by reading `job.finishedOn` rather than counting attempts.
- **The dead-letter signal is a log line, not a metric.** A job BullMQ declines to retry is logged once at `error` as `'Job dead-lettered, no retry remains'`, carrying the job name and id — and because the outbox relay uses the outbox row id as its deduplication key, that job id traces a dead-lettered event back to the exact database row that produced it. It is also retained in the failed set for 7 days and inspectable in Bull Board when `BULL_BOARD_ENABLED=true`. The worker process exposes a `/metrics` endpoint, so a registry has somewhere to be scraped from — but no code increments a dead-letter counter yet; `MetricsRecorder` would need a new method called from the worker's failure handler before a counter could replace the log line as the primary signal.
- **At-least-once delivery — handlers must be idempotent.** Because BullMQ retries a failed attempt, and because a crashed worker's job is returned to the wait list and re-run from the top, a job can execute more than once for the same logical unit of work. The outbox relay's crash-replay is suppressed within the completed-job retention window by its `deduplicationKey`, but that window is bounded and does not remove the obligation. The live handlers each satisfy it in their own way: `RevokeUserSessionsHandler` is naturally repeatable (revoking already-revoked tokens changes nothing), `DispatchDomainEventJobHandler` is guarded by the outbox dedup key, and the email handlers accept that a retry may send a second copy of a still-valid code or link rather than risk sending none. A new handler must make the same choice deliberately. The transport does not chase exactly-once, which on a distributed queue costs far more than making individual handlers safe to re-run.
- **Enqueue after commit, not inside the transaction.** Every producer runs its `unitOfWork.run(...)` first and calls `enqueue` afterwards, so a job never references a row that a rolled-back transaction never wrote. The cost is the reverse failure mode: a crash between commit and enqueue loses the job. That is tolerable for the email jobs (the user can retry the flow) and explicitly solved for domain events by the transactional outbox — the reason [domain-events.md](./domain-events.md) exists rather than events being enqueued inline.
- **One shared queue with name-based routing, not a queue per job type.** Every job is added to the single `default` queue, and `JobWorker` dispatches by `job.name` through a `Map<string, JobHandler>` built once at construction. This keeps the wiring to exactly one queue and one worker, which is appropriate at the current low volume. The trade-off is no isolation between job types: a burst of one job competes for the same `QUEUE_CONCURRENCY` budget as every other, and the shared failed set is why the purge script must filter by job name. Splitting hot jobs onto dedicated queues is a later change if throughput or priority demands it.
- **A hand-maintained catalogue plus a mapped type, rather than handler auto-discovery.** `JOB_NAMES` is an explicit `as const` list; `JobHandlersByName` derives a mapped type from it that forces the container's handler record to be exhaustive and collision-free. Auto-discovery by file glob would remove the list but also remove the compile-time check and make the live job set invisible in one place. The one gap — nothing forces a _new_ name into `JOB_NAMES` — is closed by `src/job-catalogue.test.ts`, which scans the source for `readonly jobName = …` declarations and fails on any name the catalogue omits.
- **Repeatable and delayed are deliberately separate concerns.** Recurring work is a `JobScheduler.schedule` (`everyMs`) call that maps to BullMQ's `upsertJobScheduler`; a one-off delayed job is a `JobQueue.enqueue` call with `delayMs`. Splitting them keeps a producer that only ever enqueues from having to see scheduling APIs, and `upsert` makes rescheduling idempotent — re-running bootstrap re-registers the same repeatable job under its `jobName` key rather than stacking duplicates.
- **Trace context rides the payload so async work stays inside the request's trace.** Rather than losing the causal link when work crosses the queue, `BullMqJobQueue` injects the active OpenTelemetry context into the job payload under a reserved `__otelCarrier` key, and `JobWorker` extracts it and runs the handler within that context, stripping the carrier before the handler sees the data. The alternative — treating each worker execution as a fresh, unlinked trace — would make it impossible to follow a slow request into the async work it spawned, which matters more here than usual because the work happens in a different process. The cost is a small, reserved key on object payloads (primitives and span-less enqueues are untouched); the mechanism is isolated in `job-trace-context.ts` (see [tracing.md](./tracing.md)) so handlers and producers never deal with it directly.
- **Three Redis connections — producer, worker, and health probe.** The composition registers three distinct ioredis singletons, all built by `createRedisConnection` with `maxRetriesPerRequest: null` (which BullMQ requires so its blocking commands are never aborted mid-wait): `redisConnection` (used by `BullMqJobQueue`, `BullMqJobScheduler`, and the dashboard queue) and `workerConnection` (used by `JobWorker`) in `src/composition/jobs.ts`, plus `healthCheckRedisConnection` in `src/composition/health.ts`. A BullMQ worker holds a _blocking_ connection while it waits for jobs, so sharing that socket with the producer side would stall enqueues — hence the first split. The probe gets a third for the same reason from the other direction: a readiness `PING` must answer promptly and truthfully, so it can sit neither behind the worker's blocking wait (where it would queue behind a `BRPOPLPUSH` that may block for seconds) nor behind the producer's in-flight `add` pipeline, whose latency it would then report as Redis health. Each process resolves only what it uses — the worker resolves all three, while the API process resolves the producer and probe connections and never constructs `workerConnection`. The probe's disposer calls `.disconnect()` rather than `.quit()`, because it has no queued work to drain.
- **Bounded retention so Redis does not grow without limit — and `removeOnComplete` is not only a size cap.** Completed jobs are trimmed to 1 hour / 1 000 entries and failed jobs to 7 days / 5 000 entries (`removeOnComplete` / `removeOnFail`). Failures are kept long enough to inspect. The subtlety is that BullMQ deduplicates an `add` only while a job with that id is still _known to the queue_, so `removeOnComplete` **bounds the deduplication window** for producers that may enqueue twice. Shrinking its `age` or `count` to reclaim Redis memory narrows the window in which a crash-replay is suppressed, and **no test would fail** if you did. Under a burst of more than 1 000 completed jobs within an hour, the oldest ids are evicted and a replay of those rows would be delivered twice — which is why idempotent handlers remain mandatory.
- **The queue dashboard is defence-in-depth, off by env default.** Bull Board exposes queue internals, so it ships behind several layers rather than one: (1) it is only registered when `BULL_BOARD_ENABLED=true`, so a deployment must opt in; (2) it sits behind HTTP basic auth whose validator compares credentials in **constant time** (SHA-256 digest + `timingSafeEqual`) to resist timing attacks, and **fails closed** — if the configured username or password is empty, every request is rejected rather than waved through; (3) `assertProductionSecrets` refuses to boot a production process that enables the board with a `BULL_BOARD_PASSWORD` shorter than 16 characters; (4) it defaults to `BULL_BOARD_READONLY=true` so viewing cannot mutate the queue; and (5) every response carries a restrictive `Content-Security-Policy`. The read side uses a dedicated `dashboardQueue` — a separate BullMQ `Queue` handle over the shared `redisConnection` — so the UI introspects the queue without reaching into the producer's or worker's internal `Queue`/`Worker` objects. **The bundled `docker-compose.yml` deliberately trades layer (1) away for local convenience**: it sets `BULL_BOARD_ENABLED: true` with a 28-character default password that is long enough to satisfy layer (3) and is committed to this repository. Anyone deploying that file must override `BULL_BOARD_PASSWORD`, or the only thing standing between the internet and the queue UI is a public string.
- **`EXAMPLE_JOB` ships as a dormant template, not a live job.** It is fully wired into the worker and unit-tested so the wiring is demonstrably correct, and the transport integration tests use it as their neutral fixture — enqueuing a real job type there would couple transport tests to a feature's payload shape. No production path enqueues `example.ping`. It is documented explicitly so a reader does not mistake it for production work.

## Testing

Coverage spans unit tests for the pieces that can be exercised in isolation and integration tests that stand up a real Redis (via Testcontainers) to prove the transport end-to-end.

- **Unit — `src/job-catalogue.test.ts`.** Closes the one gap the type system cannot: `JOB_NAMES` is hand-maintained, so the compiler forces the handler record to be _complete_ for the names listed but cannot force a new name to be listed at all. The test scans every non-generated, non-test `.ts` file under `src/` for `readonly jobName = …` declarations, resolves each to its string value (an inline literal, or a lookup through the exported string constants it also collects, tolerating an explicit type annotation on the declaration), and asserts that set equals `JOB_NAMES`. It keys on what actually determines routing rather than on a naming convention, so a handler whose name is missing from the catalogue fails here.
- **Unit — `src/application/jobs/example-job-handler.test.ts`.** Asserts that `ExampleJobHandler.jobName` equals `EXAMPLE_JOB` and that `handle` logs `'Example job processed'` with the payload's `message`.
- **Unit — `src/application/jobs/send-verification-email-handler.test.ts`.** Asserts the handler's job name, that `handle` sends exactly one message to the payload's address carrying the rendered subject/text/html, and that a delivery failure propagates so the worker retries rather than swallowing it.
- **Unit — `src/application/jobs/send-password-reset-email-handler.test.ts`.** Covers the same shape for the reset email, plus the URL construction: the reset link is built from the configured base and the token, and a token containing URL-sensitive characters is percent-encoded.
- **Unit — `src/application/jobs/revoke-user-sessions-handler.test.ts`.** Asserts the handler's job name, that it revokes every refresh token for the payload's user at the clock's current instant, and that a failure propagates so the worker can retry the naturally idempotent revoke.
- **Unit — `src/application/retention/enforce-data-retention-job.test.ts`.** Covers the retention handler's orchestration over its `RetentionTask` list independently of Redis or the worker.
- **Unit — `src/infrastructure/jobs/job-trace-context.test.ts`.** Covers the trace-propagation helpers directly: `injectTraceContext` envelopes an object payload with a carrier carrying the `traceparent` when a span is active, and returns the payload untouched with no active span or for a primitive; `runWithExtractedContext` restores a context whose active span `traceId` equals the injected one, and runs the callback directly when the payload has no carrier; `stripTraceContext` removes the `__otelCarrier` envelope and leaves carrier-less, null-carrier, or primitive payloads intact.
- **Unit — `src/infrastructure/jobs/bullmq-job-queue.test.ts`.** Covers the producer adapter against a mocked BullMQ `Queue`: the default retry and backoff policy, the retention settings (asserted explicitly as the deduplication horizon), that `jobId` is **omitted entirely** when no key is supplied, that a supplied key is namespaced as `` `${jobName}.${key}` ``, that the same key under two job names yields two distinct ids, that the generated id satisfies BullMQ's custom-id rules, that explicit `attempts`/`delayMs` are forwarded, and that `close()` closes both the queue and the ioredis connection.
- **Unit — `src/infrastructure/jobs/job-worker.test.ts`.** Covers the consumer adapter against a mocked BullMQ `Worker`: handler routing by job name, the no-handler throw, and every failure path — warn while a retry is pending, error once BullMQ has declined to retry, error when attempts remain but the error was unrecoverable (this case would pass under an `attemptsMade`-based predicate and fail under a correct one), a retried job whose `finishedOn` was reset to `null` treated as still retrying, a `failed` emission with no job at all (asserting the `jobName: 'unidentified'` fallback), and the `stalled` listener.
- **Unit — `src/infrastructure/jobs/redis-health-check.test.ts`.** The only test for `RedisHealthCheck`, and the one that pins the readiness behaviour described above: `check()` resolves when `PING` replies `PONG`, rejects with `unexpected Redis PING reply` on anything else (`LOADING`, for instance), propagates a connection error such as `ECONNREFUSED`, and — driving fake timers past `healthCheckTimeoutMs` against a `ping` that never settles — rejects with a `timed out` error rather than hanging the probe.
- **Unit — `src/start-worker.test.ts`.** Drives `startWorker` with a stub container and asserts it resolves `'jobWorker'` and schedules exactly the two recurring jobs with their named interval constants — so a dropped `schedule` call, or a drifted interval, fails here rather than silently at runtime.
- **Unit — `src/worker-shutdown.test.ts`.** Asserts the shutdown order (`healthApp.close()` then `container.dispose()`) and, crucially, that the container is still disposed when the health app's `close()` rejects — the `finally` that keeps a failed HTTP shutdown from leaking the worker's Redis connections.
- **Unit — `src/container.test.ts`.** Pins the container factory both processes share: every call returns a fresh container, a registration override stays local to the container it was applied to, the built container's `options` equal `{ injectionMode: InjectionMode.PROXY, strict: true }`, and `cradle.baseLogger` is the logger it was constructed from.
- **Unit — `src/presentation/http/plugins/bull-board.test.ts`.** Covers the dashboard guard: `createBasicAuthValidator` rejects when credentials are unconfigured (empty password), rejects mismatched credentials, and accepts an exact match; wired into `@fastify/basic-auth` it passes a valid request through and challenges with `401` on wrong credentials; and `bullBoardPlugin` itself, mounted on a bare Fastify app, answers an unauthenticated `GET /admin/queues` with `401` while stamping the expected `Content-Security-Policy` header. Because the queue is a typed plugin option, the test passes a `mock<Queue>({ name: 'app', metaValues: { version: 'bullmq' } })` from `vitest-mock-extended` straight in. The two seeded properties are the ones `BullMQAdapter` inspects: it accepts a queue that is either an `instanceof` BullMQ's `Queue` or carries a `metaValues.version` beginning with `bullmq`.
- **Integration — `test/integration/jobs/job-queue.int.test.ts`.** The dedicated transport test, under the describe block `BullMQ job round-trip`. It starts a real Redis via Testcontainers and constructs `BullMqJobQueue` and `JobWorker` directly. Case one enqueues `EXAMPLE_JOB` with `{ message: 'hello' }` and asserts the registered handler receives that exact payload, covering the enqueue → worker → handler path. Case two wires a worker with an empty handler list, enqueues `'unregistered.job'` with `{ attempts: 1 }`, and asserts the worker's `failed` listener logs metadata matching `{ jobName: 'unregistered.job' }`.
- **Integration — `test/integration/jobs/job-queue-deduplication.int.test.ts`.** The contract test for the deduplication semantics the design rests on (describe block `BullMqJobQueue deduplication`) — a mock cannot prove them. Against a Testcontainers Redis it asserts two cases, each under its own queue prefix. Case one collapses a replay onto a job still sitting in `wait` and checks the retained job kept the **original** payload. Case two lets a worker run the job to completion, **closes the worker before replaying** (with a live consumer a wrongly-enqueued duplicate could be drained before the assertion reads the wait list), then asserts the replay adds nothing — which only holds because `removeOnComplete` retains the id.
- **Integration — `test/integration/jobs/job-tracing.int.test.ts`.** Proves the trace crosses the real queue (describe block `BullMQ trace-context propagation`): it enqueues `EXAMPLE_JOB` from within an active span and asserts the handler, running on the worker, observes an active span whose `traceId` equals the enqueuing trace.
- **Integration — `test/integration/outbox.int.test.ts`.** Its `relay (BullMQ)` block exercises `BullMqJobQueue` and `JobWorker` end-to-end as a side effect of testing the outbox relay (see [domain-events.md](./domain-events.md)), driving the full `create → relay → worker → handler` path against a real Redis and asserting a `UserCreatedEvent` reaches its registered handler.
- **Integration — `test/integration/data-retention.int.test.ts`.** Resolves `enforceDataRetentionJob` from the container and calls `handle(undefined)` directly against a real database, asserting that outbox rows older than the retention window are deleted while recent and unpublished rows survive. It exercises the retention handler, not the scheduler that fires it.

Feature-level integration tests assert the enqueue contract from the **producer** side rather than against a real Redis, using `CapturingJobQueue` — a recording `JobQueue` implementation in `test/integration/support/harness.ts`, injected through `createHarness({ jobQueue: queue })`. `test/integration/password-reset.int.test.ts` asserts that requesting a reset enqueues `SEND_PASSWORD_RESET_EMAIL_JOB` and that completing one enqueues `REVOKE_USER_SESSIONS_JOB`; `test/integration/verify-email.int.test.ts` and `test/integration/edit-user-verification.int.test.ts` do the same for `SEND_VERIFICATION_EMAIL_JOB`.

Two components have **no dedicated tests**: `BullMqJobScheduler` and `createRedisConnection`. The scheduler's `upsertJobScheduler` registration and the shared Redis-connection factory run only through the container wiring at runtime — no test schedules a repeatable job or builds its connections through `createRedisConnection`; integration tests construct their ioredis clients inline and invoke handlers directly rather than via the scheduler.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`); they require Docker for the Redis and database Testcontainers the harness spins up.
