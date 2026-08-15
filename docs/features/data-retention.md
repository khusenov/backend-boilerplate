# Data Retention

> **Status:** Complete · **Layers:** domain, application, infrastructure · **Verified against:** `5156995`

## Purpose

Operational tables accumulate rows that stop being useful once they age out: refresh tokens and password-reset tokens whose expiry is long past, and outbox messages — rows recording domain events for reliable delivery — that have already been relayed (published). Left alone they grow without bound, slow queries, and hold security-sensitive material (token hashes) longer than a retention policy allows. This feature is a scheduled housekeeping job that periodically prunes those stale rows. It is deliberately built as an **open set of prune tasks** behind a single `RetentionTask` port: the job that runs them knows nothing about tokens or outbox rows, so adding a new prunable resource is a new adapter plus a few lines of container wiring (see Usage & extension), never a change to the job or the schedule.

## How it works

Two independent quantities drive the feature, and it is worth separating them up front:

- **Cadence** — _how often_ the sweep runs. Fixed at hourly by the code constant `DATA_RETENTION_INTERVAL_MS` (`60 * 60 * 1000`).
- **Retention window** — _how old_ a row must be before it is eligible for deletion. Configured by the env var `DATA_RETENTION_TTL` (seconds), default 30 days, converted to `dataRetentionWindowMs` in `container.ts`.

**At bootstrap of the worker process** (`src/worker.ts` calls `startWorker(container)` in `src/start-worker.ts`):

1. **The worker starts.** `void container.resolve('jobWorker')` resolves the `JobWorker` singleton, which begins consuming the shared `default` BullMQ queue. Its handler map (assembled in `container.ts`) includes `[DATA_RETENTION_JOB]: enforceDataRetentionJob`, and `src/job-catalogue.ts` lists `DATA_RETENTION_JOB` in `JOB_NAMES`, so the `JobHandlersByName` type forces that entry to exist.
2. **The job is scheduled.** `await scheduler.schedule(DATA_RETENTION_JOB, {}, { everyMs: DATA_RETENTION_INTERVAL_MS })` registers `data.retention` as a repeatable job. Backed by BullMQ's `upsertJobScheduler`, this is idempotent per job name, so restarting the worker re-registers the same schedule rather than stacking duplicates. The payload is an empty object — the handler ignores it.

**From then on, once an hour:**

3. **BullMQ enqueues the job** onto the `default` queue, and `JobWorker` routes it by `job.name` to `EnforceDataRetentionJob`.
4. **The job computes a single cutoff.** `EnforceDataRetentionJob.handle()` calculates `cutoff = new Date(this.clock.now().getTime() - this.dataRetentionWindowMs)` — the instant `DATA_RETENTION_TTL` seconds ago (30 days ago by default). Time arrives through the injected `Clock` port (`src/application/shared/ports/clock.ts`, adapter `SystemClock`) rather than an ambient `Date.now()`, so a test pins the cutoff by handing the job a stub clock instead of patching global timers.
5. **Every task is pruned with that cutoff.** The job iterates its `retentionTasks` array — wired in `container.ts` as `[refreshTokenRetentionTask, outboxRetentionTask, passwordResetTokenRetentionTask]` — and awaits `task.prune(cutoff)` on each. On success it logs `'Pruned expired records'` with the task's `resource` label, the `deleted` count, and the `cutoff`.
6. **Failures are isolated per task.** Each `prune` call is wrapped in `try/catch`. If one task throws, the job logs `'Failed to prune expired records'` with that task's `resource` and the error message (stringifying a non-`Error` rejection) and **continues to the next task**, so one broken table never blocks the others.

**What each task actually deletes.** The single `cutoff` is handed to every task, but each task decides which timestamp column defines "too old":

- **`RefreshTokenRetentionTask`** (`resource = 'refresh_tokens'`) delegates to `refreshTokenRepository.deleteExpired(cutoff)`, which runs `deleteMany({ where: { expiresAt: { lt: cutoff } } })` against the refresh-token table. A token is pruned only once it has been **expired** for the full retention window — not merely created that long ago. With the default 14-day `REFRESH_TOKEN_TTL` and 30-day window, that is roughly 44 days after the token was issued (see [authentication](./authentication.md)).
- **`OutboxRetentionTask`** (`resource = 'outbox_messages'`) runs `prisma.outboxMessage.deleteMany({ where: { publishedAt: { lt: cutoff } } })`. Only **relayed (published)** messages are deleted: a row whose `publishedAt` is still `NULL` (not yet relayed — see [domain events](./domain-events.md)) is excluded by the `lt` comparison and is never pruned, so retention can never drop an event that still needs delivery.
- **`PasswordResetTokenRetentionTask`** (`resource = 'password_reset_tokens'`) delegates to `passwordResetTokenRepository.deleteExpired(cutoff)`, which runs `deleteMany({ where: { expiresAt: { lt: cutoff } } })`. Because the criterion is expiry alone, used and unused tokens alike leave the table once their expiry is a full window old. With the default 30-minute `PASSWORD_RESET_TOKEN_TTL`, a reset token's hash is gone roughly 30 days after it was created (see [password reset](./password-reset.md)).

The job runs on the project's shared background-job transport rather than an in-process timer; see [background jobs](./background-jobs.md) for the worker, scheduler, and queue mechanics it reuses.

## Architecture

The feature sits across the port/adapter boundary. The application layer owns two abstractions: `RetentionTask` — the contract "delete rows older than this cutoff and tell me how many" — and `EnforceDataRetentionJob`, a `JobHandler` that fans a cutoff out across a list of `RetentionTask`s. Neither mentions Prisma or any concrete table. The infrastructure layer holds the only code that knows what is being pruned and how: `RefreshTokenRetentionTask` and `PasswordResetTokenRetentionTask` (each through a domain repository interface) and `OutboxRetentionTask` (through Prisma directly). Dependencies point inward — the job depends on the `RetentionTask` _interface_, and the concrete tasks are bound to it and assembled into the job's task list **only** in `src/container.ts`. Pruning a new resource therefore never edits `EnforceDataRetentionJob`; it adds an adapter and a few lines of container wiring (see Usage & extension).

| Component                                    | Layer                                      | Responsibility                                                                                                                                      | File                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `RetentionTask`                              | Application (port)                         | Contract a prune task implements: a `resource` label and `prune(cutoff): Promise<number>`                                                           | `src/application/shared/ports/retention-task.ts`                                                                                           |
| `EnforceDataRetentionJob`                    | Application                                | `JobHandler` (`jobName = 'data.retention'`) that derives one cutoff from the window and prunes every registered task, isolating per-task failures   | `src/application/retention/enforce-data-retention-job.ts`                                                                                  |
| `Clock`                                      | Application (port)                         | `now(): Date` — the time source the job derives its cutoff from (adapter: `SystemClock`, `src/infrastructure/time/system-clock.ts`)                 | `src/application/shared/ports/clock.ts`                                                                                                    |
| `RefreshTokenRetentionTask`                  | Infrastructure                             | `RetentionTask` adapter (`resource = 'refresh_tokens'`) that delegates to `RefreshTokenRepository.deleteExpired`                                    | `src/infrastructure/persistence/refresh-token-retention-task.ts`                                                                           |
| `OutboxRetentionTask`                        | Infrastructure                             | `RetentionTask` adapter (`resource = 'outbox_messages'`) that deletes relayed (published) outbox rows via Prisma                                    | `src/infrastructure/persistence/outbox-retention-task.ts`                                                                                  |
| `PasswordResetTokenRetentionTask`            | Infrastructure                             | `RetentionTask` adapter (`resource = 'password_reset_tokens'`) that delegates to `PasswordResetTokenRepository.deleteExpired`                       | `src/infrastructure/persistence/password-reset-token-retention-task.ts`                                                                    |
| `RefreshTokenRepository.deleteExpired`       | Domain (interface) / Infrastructure (impl) | Deletes refresh tokens where `expiresAt < cutoff`, returns the count                                                                                | `src/domain/auth/refresh-token-repository.ts`, `src/infrastructure/persistence/prisma-refresh-token-repository.ts`                         |
| `PasswordResetTokenRepository.deleteExpired` | Domain (interface) / Infrastructure (impl) | Deletes password-reset tokens where `expiresAt < cutoff`, returns the count                                                                         | `src/domain/password-reset/password-reset-token-repository.ts`, `src/infrastructure/persistence/prisma-password-reset-token-repository.ts` |
| `JobHandler`                                 | Application (port)                         | The consumer contract `EnforceDataRetentionJob` implements so the worker can route `data.retention` to it                                           | `src/application/shared/ports/job-handler.ts`                                                                                              |
| `JobScheduler`                               | Application (port)                         | `schedule(jobName, payload, { everyMs })` — registers the repeatable `data.retention` job (adapter: `BullMqJobScheduler`)                           | `src/application/shared/ports/job-scheduler.ts`                                                                                            |
| Job catalogue entry                          | Composition root                           | `JOB_NAMES` includes `DATA_RETENTION_JOB`; `JobHandlersByName` makes the worker's handler map provably complete                                     | `src/job-catalogue.ts`                                                                                                                     |
| Container wiring                             | Composition root                           | Binds the three tasks to `RetentionTask`, sets `dataRetentionWindowMs`, assembles the job's task list, and adds the job to the worker's handler map | `src/container.ts`                                                                                                                         |
| Worker bootstrap                             | Composition root                           | `startWorker` resolves `jobWorker` and schedules `data.retention` on the hourly interval (invoked from `src/worker.ts`)                             | `src/start-worker.ts`                                                                                                                      |

## Public surface

This is not an HTTP feature — it exposes no endpoints. The contract another engineer programs against is the `RetentionTask` port: implement it to have a new resource pruned on the retention schedule.

```ts
export interface RetentionTask {
  readonly resource: string;

  prune(cutoff: Date): Promise<number>;
}
```

- **`resource`** — a stable, log-friendly label for the table this task prunes (the existing tasks use `'refresh_tokens'`, `'outbox_messages'`, and `'password_reset_tokens'`). `EnforceDataRetentionJob` includes it verbatim in every success and failure log line, so it is how a resource's pruning is identified in the logs.
- **`prune(cutoff)`** — delete the rows this task considers older than `cutoff` and resolve with the number deleted. The task chooses which timestamp column `cutoff` is compared against — the job supplies the same cutoff to every task but does not dictate its meaning. Returning `0` (nothing old enough) is normal. The operation must be safe to repeat: it runs at least once an hour and re-running it after a partial failure must not corrupt anything (a `deleteMany … where < cutoff` is naturally idempotent).

A task is only reached once it is registered in `container.ts` **and** added to the `retentionTasks` array passed to `EnforceDataRetentionJob` (see below). Defining a `RetentionTask` without wiring it in has no effect.

## Configuration

Read from `src/config/env.ts` (`.env.example` lists the same key):

| Variable             | Default                         | Meaning                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_RETENTION_TTL` | `2592000` (30 days, in seconds) | How old a row must be before it is eligible for pruning. `container.ts` registers `dataRetentionWindowMs` as `env.DATA_RETENTION_TTL * 1000`, and the job's cutoff is `now − dataRetentionWindowMs`. Each task applies this window to its own timestamp column (token `expiresAt`, outbox `publishedAt`). |

Two related values are **compile-time constants, not env vars**, both in `src/application/retention/enforce-data-retention-job.ts`: `DATA_RETENTION_INTERVAL_MS` (`60 * 60 * 1000` — the hourly cadence) and `DATA_RETENTION_JOB` (`'data.retention'` — the job name). Scheduling and execution run on the shared background-job transport, which reads its own configuration (`REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_CONCURRENCY`); see [background jobs](./background-jobs.md#configuration).

## Usage & extension

Adding a new prunable resource is three steps. The example prunes an `audit_logs` table by its `createdAt` column; it follows `OutboxRetentionTask` (Prisma-direct). A task that fronts a domain repository instead follows `RefreshTokenRetentionTask` or `PasswordResetTokenRetentionTask` — inject the repository and delegate to a `deleteExpired(cutoff)`-style method.

**Step 1 — Implement the `RetentionTask` (infrastructure).** Create `src/infrastructure/persistence/audit-log-retention-task.ts`:

```ts
import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { PrismaClient } from '@/generated/prisma/client';

export interface AuditLogRetentionTaskDeps {
  prisma: PrismaClient;
}

export class AuditLogRetentionTask implements RetentionTask {
  readonly resource = 'audit_logs';
  private readonly prisma: PrismaClient;

  constructor({ prisma }: AuditLogRetentionTaskDeps) {
    this.prisma = prisma;
  }

  async prune(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
```

**Step 2 — Register the task (`src/container.ts`).** Import it, declare it on the `Cradle` interface, and register it as a singleton bound to `RetentionTask`:

```ts
import { AuditLogRetentionTask } from '@/infrastructure/persistence/audit-log-retention-task';

// on the Cradle interface, beside the other retention tasks
auditLogRetentionTask: RetentionTask;

// inside registerDependencies(...), beside the existing task registrations
auditLogRetentionTask: asClass(AuditLogRetentionTask).singleton(),
```

**Step 3 — Add it to the job's task list (`src/container.ts`).** This is the step that actually makes it run. Extend the `enforceDataRetentionJob` factory: add the task to the `Pick<Cradle, …>` destructure and to the `retentionTasks` array:

```ts
enforceDataRetentionJob: asFunction(
  ({
    refreshTokenRetentionTask,
    outboxRetentionTask,
    passwordResetTokenRetentionTask,
    auditLogRetentionTask,
    dataRetentionWindowMs,
    clock,
    logger,
  }: Pick<
    Cradle,
    | 'refreshTokenRetentionTask'
    | 'outboxRetentionTask'
    | 'passwordResetTokenRetentionTask'
    | 'auditLogRetentionTask'
    | 'dataRetentionWindowMs'
    | 'clock'
    | 'logger'
  >) =>
    new EnforceDataRetentionJob({
      retentionTasks: [
        refreshTokenRetentionTask,
        outboxRetentionTask,
        passwordResetTokenRetentionTask,
        auditLogRetentionTask,
      ],
      dataRetentionWindowMs,
      clock,
      logger,
    }),
).singleton(),
```

No change to `EnforceDataRetentionJob`, `src/job-catalogue.ts`, `src/start-worker.ts`, or the schedule is needed: the next hourly run picks the new task up and prunes `audit_logs` with the same cutoff. If the new resource needs its own retention window rather than the shared 30-day window, see the second design note below.

## Design decisions & trade-offs

- **A `RetentionTask` port with a task list, not one job full of hardcoded deletes.** `EnforceDataRetentionJob` depends only on the `RetentionTask` interface and iterates whatever list it is handed. Adding a prunable table is a new adapter plus a few lines of container wiring (open for extension); the job itself never changes (closed for modification). A single job with inline `prisma.x.deleteMany(...)` calls would couple the sweep to every table's persistence details and force an edit to the same method for every new resource.
- **One shared retention window for all tasks.** Every task receives the same cutoff derived from a single `DATA_RETENTION_TTL`, which keeps configuration to one knob and the policy in one place. The cost is that resources cannot yet have _different_ ages (e.g. outbox 7 days but tokens 90 days). The port already supports per-resource windows — a task can be constructed with its own configured age and ignore the shared cutoff — so this is a deliberate "simple until needed" choice, not a limitation baked into the design.
- **The cutoff's _meaning_ lives in each task, not the job.** The job computes `now − window` and passes it along; the token tasks compare it to `expiresAt` while `OutboxRetentionTask` compares it to `publishedAt`. Centralising "how old is old" (the window) while letting each resource define _which_ timestamp counts keeps the job resource-agnostic and lets each table encode its own correctness rule — most importantly that an outbox row's age is measured from publish/relay, never from creation.
- **Per-task failure isolation, logged rather than thrown.** `handle()` catches each task's error and moves on, so a broken or locked table does not stop the others from being pruned. The trade-off is that a persistently failing task surfaces only as an error log line, not as a failed BullMQ job with retries. That is acceptable here precisely because the job is **idempotent and re-runs hourly**: the next run naturally retries the failed table, and pruning twice deletes nothing the second time — so leaning on BullMQ's retry/backoff would add noise without adding safety.
- **Unpublished outbox rows are never pruned.** `OutboxRetentionTask` filters on `publishedAt: { lt: cutoff }`, and a `NULL` `publishedAt` fails a `lt` comparison, so a message still awaiting relay is retained no matter how old it is. Retention can therefore never cause event loss — an outbox row is only ever deleted well after it has been successfully relayed (published).
- **Token pruning keys on expiry, not creation or use.** Both token tasks delete on `expiresAt < cutoff`. This keeps recently-expired tokens around for the full window — useful when investigating a security incident (e.g. refresh-token reuse detection needs the revoked family's rows) — while still guaranteeing every token row, used or not, eventually leaves the database on a bounded schedule.
- **Cadence is a constant; the retention window is configuration.** How _often_ the sweep runs (`DATA_RETENTION_INTERVAL_MS`, hourly) rarely needs operational tuning, so it is a code constant. How _long_ data is kept (`DATA_RETENTION_TTL`) is a policy/compliance decision that differs per environment, so it is the one env var. An hourly cadence against a 30-day window means a row lingers at most an extra hour past its window — cheap insurance against the worker being briefly down.
- **Scheduled by the worker process on the shared BullMQ transport, not an in-process timer.** `startWorker` (run by `src/worker.ts`, not the API process) registers the schedule through `JobScheduler.schedule` — a repeatable BullMQ job — consistent with the project rule that all background and scheduled work is Redis-backed. This gives the sweep durability across restarts, keeps it on the same worker and observability path as every other job, and means scaling API replicas never multiplies schedules (and `upsertJobScheduler` is idempotent per job name regardless). The cost is the standing Redis dependency the transport already requires.

## Testing

**Unit tests** (Vitest with fakes — no database or Redis; run with `npm test`):

- **`src/application/retention/enforce-data-retention-job.test.ts`** exercises the orchestration with fake `RetentionTask`s, a stub `Clock` pinned to a fixed `NOW`, and a stub `Logger`: `jobName` equals `DATA_RETENTION_JOB`; every task is pruned with the cutoff derived from _now minus the window_; the deleted count is logged per resource via `'Pruned expired records'`; when one task throws it keeps pruning the rest and logs `'Failed to prune expired records'` with the error message; a non-`Error` rejection is stringified in that log; and with no tasks registered it does nothing (no log calls).
- **`src/infrastructure/persistence/refresh-token-retention-task.test.ts`** asserts `resource` is `'refresh_tokens'` and that `prune(cutoff)` delegates to `refreshTokenRepository.deleteExpired(cutoff)` and returns its count.
- **`src/infrastructure/persistence/outbox-retention-task.test.ts`** asserts `resource` is `'outbox_messages'` and that `prune(cutoff)` calls `prisma.outboxMessage.deleteMany` with `{ where: { publishedAt: { lt: cutoff } } }` and returns the `count`.
- **`src/infrastructure/persistence/password-reset-token-retention-task.test.ts`** asserts `resource` is `'password_reset_tokens'` and that `prune(cutoff)` delegates to `passwordResetTokenRepository.deleteExpired(cutoff)` and returns its count.
- **`src/start-worker.test.ts`** asserts the worker bootstrap resolves `jobWorker` and registers the recurring `DATA_RETENTION_JOB` schedule with `{ everyMs: DATA_RETENTION_INTERVAL_MS }`.

**Integration test** (run with `npm run test:integration`; Testcontainers starts real MariaDB and Redis instances):

- **`test/integration/data-retention.int.test.ts`** boots the full app through the shared harness, seeds three outbox rows — one published 40 days ago, one published 1 day ago, one 40 days old but never published (`publishedAt: null`) — then resolves `enforceDataRetentionJob` from the DI container and calls `handle(undefined)` directly. It asserts exactly the old published row is deleted and both the recent and the unpublished rows survive, proving the real Prisma wiring, the 30-day default window, and the never-prune-unpublished guarantee end to end.

The `schedule → BullMQ → worker` transport the job rides on is covered separately; see [background jobs](./background-jobs.md#testing).
