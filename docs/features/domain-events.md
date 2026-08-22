# Domain Events

> **Status:** Complete · **Layers:** domain, application, infrastructure · **Verified against:** `5156995`

## Purpose

Domain events let an aggregate (a domain entity, such as `User`, that owns and guards its own state)
announce a business fact that has already happened — "a user was created" — without knowing who reacts
to it. The use case that changed the aggregate stays focused on its one job; side effects such as
logging, notifications, or projections are added as independent handlers that subscribe to the event,
honouring the Open/Closed principle and the clean-architecture Dependency Rule. Delivery uses a
**transactional outbox**: the event is written into a database table _in the same transaction_ as the
business change, then relayed to handlers asynchronously through the background-job queue. That closes
the dual-write gap a naive "save, then dispatch" design leaves open — an event is never lost if the
process dies right after committing — at the price of **at-least-once** rather than exactly-once
delivery: a handler can be invoked more than once for the same event, so every handler must be
idempotent.

## How it works

The pipeline has a synchronous **write half** (inside the request transaction) and an asynchronous
**delivery half** (driven by background jobs in the worker process). The halves are joined only by rows
in the `outbox_messages` table, so nothing in the request path ever waits on a handler.

**Write half — atomic, inside the request transaction**

1. **Recording (domain).** An aggregate constructs a `DomainEvent` subclass at the point of a meaningful
   state transition and buffers it via the protected `recordEvent(...)` method on **`AggregateRoot`**,
   the base class for event-emitting aggregates (`Entity` itself has no event buffer — it provides only
   identity, timestamps, and soft-delete). Concretely, the private `User.build(...)` factory calls
   `user.recordEvent(new UserCreatedEvent(user.id, user.email.toString(), now))`; both public creation
   paths — `User.create(...)` (status `active`) and `User.register(...)` (status `pending`) — route
   through `build`, so **both emit `user.created`**. `User.hydrate(...)` (rehydration from persistence)
   records nothing, so loading a user never re-emits its creation. The event is only recorded, never
   delivered here — the aggregate has no dependency on any dispatcher, queue, or I/O. Because the same
   `now` (read once from the `Clock` port by the use case) also stamps `createdAt`/`updatedAt`, the
   event's `occurredAt` always equals the created row's `createdAt`.
2. **Staging (application).** The use case saves the aggregate and stages its events inside one
   `UnitOfWork` transaction. Both producers follow this shape — `CreateUser.execute` (admin-driven
   creation, see [user-crud.md](./user-crud.md)) and `RegisterUser.execute` (self-registration, see
   [email-verification.md](./email-verification.md)):

   ```ts
   await this.uow.run(async ({ userRepository, outbox }) => {
     await userRepository.save(newUser);
     outbox.stage(newUser.pullDomainEvents());
   });
   ```

   That snippet is `CreateUser.execute` verbatim. `RegisterUser.execute` differs only by doing more in
   the same transaction: it destructures a third repository and persists the verification code alongside
   the user — `async ({ userRepository, emailVerificationCodeRepository, outbox }) => { … await
emailVerificationCodeRepository.create(code); … }` — with the save-then-stage pairing unchanged.

   `pullDomainEvents()` returns a copy of the buffer and clears it, so an event is staged at most once.
   `outbox.stage(...)` touches no I/O; it appends the events to an in-memory array scoped to the running
   transaction.

3. **Writing to the outbox (infrastructure), in the same transaction.** After the callback returns —
   but still inside `prisma.$transaction` — `PrismaUnitOfWork` flushes the staged events through
   `PrismaOutboxWriter.write(staged, tx)`, which issues one `tx.outboxMessage.createMany(...)` using the
   same transactional client that saved the user. The business `INSERT` and the outbox `INSERT`s commit
   or roll back **together**: on a successful commit there is no window in which a user exists without
   its `user.created` row, or vice versa. Each row is written with `publishedAt = null`, marking it
   not-yet-relayed. (Transaction mechanics — how `PrismaUnitOfWork` builds the `TransactionContext` —
   are documented in [unit-of-work.md](./unit-of-work.md).)

**Delivery half — asynchronous, at-least-once, driven by jobs**

4. **Relaying.** The worker process (`src/worker.ts`) calls `startWorker` (`src/start-worker.ts`),
   which starts the `JobWorker` and schedules a repeatable `OUTBOX_RELAY_JOB` (`'outbox.relay'`) every
   `OUTBOX_RELAY_INTERVAL_MS` (`5_000` ms) via the `JobScheduler`. Each tick runs `OutboxRelay.handle`:
   it reads up to `RELAY_BATCH_SIZE` (`100`) unpublished rows (`where: { publishedAt: null }`, oldest
   first by `occurredAt`) and, per row, enqueues a `DISPATCH_DOMAIN_EVENT_JOB`
   (`'domain-event.dispatch'`) carrying `{ eventName, payload }` onto the `JobQueue` — **passing the
   outbox row's own id as the job's `deduplicationKey`**, so a replayed batch is delivered once rather
   than twice, for as long as the original job is retained. It then stamps `publishedAt` (via the
   `Clock` port) on exactly the ids it successfully enqueued, in one `updateMany`.

   A row whose enqueue throws is logged and left unpublished, so the next tick retries it. `publishedAt`
   therefore means **handed to the queue**, not **processed**; the queue's terminal state is the record
   of processing, and because the row id becomes part of the BullMQ job id, a failed job traces back to
   the exact row that produced it.

5. **Dispatching.** The `JobWorker` picks up each `DISPATCH_DOMAIN_EVENT_JOB` and runs
   `DispatchDomainEventJobHandler.handle`. It rebuilds the concrete event from its stored JSON via
   `DomainEventSerializer.deserialize(eventName, payload)` — a lookup of `eventName` in the
   `domainEventFactories` registry followed by the matching factory call — then awaits
   `handler.handle(event)` for every handler the `DomainEventHandlerRegistry` holds under that
   `eventName`, in registration order.
6. **Handling.** The subscriber runs. For `user.created`, `UserCreatedLogHandler` writes a structured
   log line (`aggregateId`, `email`, `occurredAt`) through the `Logger` port.

Failure paths that matter:

- **Transaction rollback.** If anything inside `uow.run` throws, `$transaction` rolls back and the flush
  is never reached: neither the user row nor any outbox row is committed. An event can never escape for
  a change that failed to persist.
- **Relay enqueue failure.** `OutboxRelay` marks only the rows it actually enqueued; failed rows stay
  `publishedAt = null` and retry next tick. A crash between the enqueue and the `updateMany` replays the
  batch, but the row id carried as `deduplicationKey` makes the replay a no-op within the queue's
  job-retention window rather than a second delivery. Retrying is unbounded, and an unpublished row is
  **exempt from retention**: `OutboxRetentionTask.prune` deletes
  `where: { publishedAt: { lt: cutoff } }`, and `publishedAt = null` never satisfies `lt`. So a row that
  can never be enqueued — a permanently unreachable Redis, a payload BullMQ rejects — is re-read and
  re-attempted every 5 s forever, is never pruned, and grows `outbox_messages` without bound. This is not
  a benign steady state; it needs operational resolution (fix the enqueue path so the row drains, or
  delete the row deliberately), and the relay's `Failed to relay outbox message` error log carrying
  `outboxMessageId` is the signal to alert on.
- **Concurrent relays.** `OutboxRelay.findPending` takes no lock and makes no claim — there is no
  `SKIP LOCKED`, no claim column, and no reservation write before the enqueue. Two worker replicas, or
  two relay ticks that overlap inside a single worker (the relay runs on the shared `JobWorker` at
  `QUEUE_CONCURRENCY = 5`, so a tick outlasting the 5 s interval overlaps its successor), will read the
  same unpublished batch and both enqueue it. Nothing in the read path prevents that; correctness rests
  entirely on the row-id `deduplicationKey` turning the second `add` into a no-op, and that suppression
  is bounded by completed-job retention (1 hour / 1 000 entries). Outside that window, concurrent relays
  produce genuine duplicate deliveries — the walkthrough above describes one relay, but the code does
  not guarantee one. Another reason handlers must be idempotent.
- **Handler failure.** `DispatchDomainEventJobHandler` does **not** swallow handler errors; a throw
  propagates out of the job, so BullMQ retries it under the shared queue policy — `attempts: 3` with
  exponential backoff from a 1 s base delay — and an exhausted job comes to rest in the failed set
  (retained 7 days / 5 000 entries) rather than being dropped (see
  [background-jobs.md](./background-jobs.md)). The consequence: delivery is at-least-once, so **a
  handler can run more than once for the same event and must be idempotent**.
- **Poisoned event — the dead-lettered job is the last copy.** Understand where a permanently failing
  event comes to rest. The relay stamped `publishedAt` the moment the enqueue succeeded, and the
  row-id dedup key suppresses a re-enqueue, so **the failed `domain-event.dispatch` job is the only
  surviving copy of the event** — an invariant the codebase itself calls out in
  `src/scripts/purge-verification-jobs.ts`, which filters the failed set by job name precisely so it
  cannot destroy dispatch jobs. There is no re-drive from `outbox_messages`: nothing re-reads a
  published row, and once `DATA_RETENTION_TTL` elapses the row is deleted outright. When the failed job
  then ages out (7 days / 5 000 entries) or is cleaned wholesale, the event is unrecoverable. Recovery
  is therefore: inspect and retry the job from the Bull Board dashboard (`BULL_BOARD_ENABLED`, see
  [background-jobs.md](./background-jobs.md)) after fixing the handler or factory — and **never**
  blanket-clean the failed set (`queue.clean(…, 'failed')`); filter by job name the way the purge script
  does.
- **Unknown event.** If a stored `eventName` has no entry in `domainEventFactories`, `deserialize`
  throws `UnknownDomainEventError`; the dispatch job fails and retries, and will keep failing until a
  factory is registered. The terminal state above applies in full — register the factory and retry the
  job from Bull Board before it ages out, because nothing will re-deliver the event afterwards.

## Architecture

The feature is split across the port/adapter boundary. The domain owns the `DomainEvent` base type and
the event buffer on `AggregateRoot`. The application layer defines the abstractions — the
`DomainEventHandler` and `DomainEventDispatcher` ports, and the `OutboxStaging` contract exposed on the
unit-of-work `TransactionContext`. Infrastructure supplies every concrete: outbox writer, serializer,
factory registry, handler registry, relay, and dispatch job handler. Dependencies point inward — the
aggregate depends on nothing, the use cases depend on the `UnitOfWork`/`OutboxStaging` interfaces (never
on Prisma or BullMQ), and concretes bind to ports only under `src/composition/**`. Delivery rides on the
generic background-job ports (`JobQueue`, `JobScheduler`, `JobHandler`) documented in
[background-jobs.md](./background-jobs.md); this feature does not re-implement queueing.

| Component                                 | Layer                   | Responsibility                                                                                                                                                                     | File                                                                           |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DomainEvent`                             | Domain                  | Abstract base for every event; carries `aggregateId`, `eventName`, and a caller-supplied `occurredAt`                                                                              | `src/domain/shared/domain-event.ts`                                            |
| `AggregateRoot`                           | Domain                  | Extends `Entity` with the event buffer (protected `recordEvent(...)` appends, public `pullDomainEvents()` drains and clears) and a `readonly version` for optimistic concurrency   | `src/domain/shared/aggregate-root.ts`                                          |
| `Entity`                                  | Domain                  | Base identity/timestamps/soft-delete for all entities — holds **no** event machinery                                                                                               | `src/domain/shared/entity.ts`                                                  |
| `UserCreatedEvent`                        | Domain                  | Concrete event for user creation; pins routing key `EVENT_NAME = 'user.created'` and carries `email`                                                                               | `src/domain/user/events/user-created-event.ts`                                 |
| `User`                                    | Domain                  | Records `UserCreatedEvent` in its private `build(...)`, reached from both `create(...)` and `register(...)`                                                                        | `src/domain/user/user-entity.ts`                                               |
| `DomainEventHandler`                      | Application (port)      | Interface a subscriber implements: an `eventName` to bind to and an async `handle`                                                                                                 | `src/application/shared/ports/domain-event-handler.ts`                         |
| `DomainEventDispatcher`                   | Application (port)      | Interface for fanning a batch of events out to handlers — currently dormant (see Design decisions)                                                                                 | `src/application/shared/ports/domain-event-dispatcher.ts`                      |
| `OutboxStaging` (on `TransactionContext`) | Application (port)      | `stage(events)` — how a use case hands events to the running transaction for outbox persistence                                                                                    | `src/application/shared/ports/unit-of-work.ts`                                 |
| `UserCreatedLogHandler`                   | Application             | Subscribes to `user.created` and logs the creation                                                                                                                                 | `src/application/user/events/user-created-log-handler.ts`                      |
| `CreateUser` / `RegisterUser`             | Application             | The two producers: save the user and stage its pulled events inside one `uow.run(...)`                                                                                             | `src/application/user/create-user.ts`, `src/application/auth/register-user.ts` |
| `PrismaUnitOfWork`                        | Infrastructure          | Runs the business callback and flushes staged events to the outbox in the same DB transaction                                                                                      | `src/infrastructure/persistence/prisma-unit-of-work.ts`                        |
| `PrismaOutboxWriter`                      | Infrastructure          | Serializes staged events and `createMany`s them into `outbox_messages` with the transactional client                                                                               | `src/infrastructure/persistence/prisma-outbox-writer.ts`                       |
| `DomainEventSerializer`                   | Infrastructure          | `serialize` (event → JSON string) and `deserialize` (event name + JSON → concrete event via a factory); throws `UnknownDomainEventError` for unknown names                         | `src/infrastructure/events/domain-event-serializer.ts`                         |
| `SerializedDomainEvent`                   | Infrastructure          | Shape of the parsed JSON a factory reads (`aggregateId`, `eventName`, `occurredAt` string, plus payload fields)                                                                    | `src/infrastructure/events/serialized-domain-event.ts`                         |
| `domainEventFactories`                    | Infrastructure          | Registry mapping each `eventName` to a factory that reconstructs its concrete event class                                                                                          | `src/infrastructure/events/domain-event-factories.ts`                          |
| `DomainEventHandlerRegistry`              | Infrastructure          | Indexes handlers into a `Map<eventName, handler[]>` once at construction; `handlersFor(eventName)` looks them up                                                                   | `src/infrastructure/events/domain-event-handler-registry.ts`                   |
| `OutboxRelay`                             | Infrastructure          | Repeatable job (`OUTBOX_RELAY_JOB`): reads unpublished rows, enqueues one dispatch job per row keyed on the row id, marks the enqueued rows published                              | `src/infrastructure/events/outbox-relay.ts`                                    |
| `DispatchDomainEventJobHandler`           | Infrastructure          | Per-event job (`DISPATCH_DOMAIN_EVENT_JOB`): deserializes the event and fans it out over the registry, propagating failures for retry                                              | `src/infrastructure/events/dispatch-domain-event-job-handler.ts`               |
| `InProcessDomainEventDispatcher`          | Infrastructure          | Synchronous, error-isolating `DomainEventDispatcher` adapter — registered but not on the runtime path (see Design decisions)                                                       | `src/infrastructure/events/in-process-domain-event-dispatcher.ts`              |
| `startWorker`                             | Composition root        | Starts the `JobWorker` and schedules `OUTBOX_RELAY_JOB` every `OUTBOX_RELAY_INTERVAL_MS`; invoked by the worker entry point `src/worker.ts`                                        | `src/start-worker.ts`                                                          |
| `JOB_NAMES`                               | Composition root        | The closed job catalogue; includes `OUTBOX_RELAY_JOB` and `DISPATCH_DOMAIN_EVENT_JOB`, which the container's `jobWorker` maps to `outboxRelay` and `dispatchDomainEventJobHandler` | `src/job-catalogue.ts`                                                         |
| `OutboxMessage` (`outbox_messages`)       | Infrastructure (schema) | The outbox table: `id`, `aggregate_id`, `event_name`, `payload`, `occurred_at`, `published_at`, indexed on `(published_at, occurred_at)`                                           | `prisma/schema.prisma`                                                         |

## Public surface

This is a cross-cutting infrastructure feature with no HTTP endpoints. The contract another engineer
programs against is the following pieces.

**1. `DomainEvent` — the event shape (extend this).**

```ts
export abstract class DomainEvent {
  protected constructor(
    readonly aggregateId: string,
    readonly eventName: string,
    readonly occurredAt: Date,
  ) {}
}
```

`occurredAt` is required, which forces the write path to say which instant it means (events never read a
clock of their own) and forces a deserialization factory to restore the **original** timestamp rather
than silently restamping with the deserialization time. A concrete event pins its `eventName` as a
`static readonly EVENT_NAME` and adds payload fields, e.g.
`UserCreatedEvent(aggregateId: string, email: string, occurredAt: Date)` with
`EVENT_NAME = 'user.created'`.

**2. `AggregateRoot` — recording and draining events.** Extend `AggregateRoot` (not `Entity`) for any
aggregate that emits events; only it carries the buffer. Doing so also opts the aggregate into
optimistic concurrency, which obliges its table to carry a `version` column and its repository to
apply a version-guarded save — see [user-crud.md](./user-crud.md):

```ts
export const UNSAVED_VERSION = 0;

export interface AggregateRootProps extends EntityProps {
  readonly version: number;
}

export abstract class AggregateRoot<T extends AggregateRootProps> extends Entity<T> {
  private readonly _domainEvents: DomainEvent[] = [];

  get version(): number {
    return this.props.version;
  }

  public pullDomainEvents(): DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }

  protected recordEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }
}
```

`recordEvent` is `protected` — only the aggregate's own methods may record, and it only buffers. The
`now` an aggregate passes in is the one its caller supplied; entities never read a clock.
`pullDomainEvents` is `public` so the application layer can drain the buffer; draining clears it, so a
second pull returns `[]`.

**3. `OutboxStaging.stage` — persisting events atomically (call this from a use case).** Inside a
`unitOfWork.run(...)` callback, hand the pulled events to the transaction's `outbox`:

```ts
export interface OutboxStaging {
  stage(events: readonly DomainEvent[]): void;
}
```

Staging is what routes events into the transactional outbox; a use case that mutates state but never
stages its events silently delivers nothing. The `UnitOfWork`, `TransactionContext`, and `OutboxStaging`
surface lives in `src/application/shared/ports/unit-of-work.ts` and is documented in
[unit-of-work.md](./unit-of-work.md).

**4. `DomainEventHandler` — subscribing (implement this).**

```ts
export interface DomainEventHandler<E extends DomainEvent = DomainEvent> {
  readonly eventName: string;
  handle(event: E): Promise<void>;
}
```

A handler binds to exactly one `eventName`, which must equal the event's `EVENT_NAME`. Many handlers may
share an `eventName`; the dispatch job invokes them all, in the order they appear in the
`domainEventHandlers` array in `src/composition/events.ts`. Because delivery is at-least-once, `handle` must tolerate
being called more than once for the same event.

**5. `DomainEventDispatcher` — a port to avoid for now.** The port
(`dispatch(events: readonly DomainEvent[]): Promise<void>`) is registered in the container as
`domainEventDispatcher`, but nothing resolves it at runtime — the live delivery path is the outbox
pipeline above. Do not program against it expecting outbox semantics (see Design decisions).

## Configuration

This feature defines **no environment variables of its own** (there are no `OUTBOX_*` keys in
`src/config/env.ts`). Two behavioural constants are pinned in code rather than configured:

| Constant                   | Value   | Meaning                                                               | File                                        |
| -------------------------- | ------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `OUTBOX_RELAY_INTERVAL_MS` | `5_000` | How often the relay job runs — the worst-case delivery-latency floor  | `src/infrastructure/events/outbox-relay.ts` |
| `RELAY_BATCH_SIZE`         | `100`   | Max unpublished rows drained per relay tick (module-private constant) | `src/infrastructure/events/outbox-relay.ts` |

Delivery rides on the shared background-job infrastructure, whose keys are parsed in
`src/config/env.ts` (mirrored in `.env.example`) and documented in full in
[background-jobs.md](./background-jobs.md). The keys that materially affect this feature:

| Variable             | Default                                                        | Meaning                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | (required, no default)                                         | Connection string for the Prisma client that writes and reads `outbox_messages`.                                                                                                                |
| `REDIS_URL`          | `redis://127.0.0.1:6379` (dev default; required in production) | Redis connection backing the BullMQ queue the relay enqueues onto and the worker consumes.                                                                                                      |
| `QUEUE_PREFIX`       | `app` (from `APP_NAME`)                                        | Key prefix isolating this app's BullMQ queues in Redis.                                                                                                                                         |
| `QUEUE_CONCURRENCY`  | `5`                                                            | Worker concurrency — how many dispatch (and other) jobs run in parallel.                                                                                                                        |
| `DATA_RETENTION_TTL` | `2592000` (`60 * 60 * 24 * 30` — 30 days)                      | Age in **seconds** past which the retention job deletes **delivered** outbox rows. The only key controlling how long `outbox_messages` history survives; shared with the other retention tasks. |

Delivered rows do not accumulate forever: the data-retention job prunes `outbox_messages` rows whose
`publishedAt` is older than `DATA_RETENTION_TTL` (`OutboxRetentionTask.prune` issues
`deleteMany({ where: { publishedAt: { lt: cutoff } } })`; see [data-retention.md](./data-retention.md)).
Note the scope of that predicate: it matches **delivered rows only**, because `publishedAt = null` never
satisfies `lt`. Undelivered rows are exempt from retention and never age out — see "Relay enqueue
failure" above for why a row stuck at `publishedAt = null` is an operational problem, not a self-healing
one.

## Usage & extension

To add a new event, deliver it through the outbox, and react to it, follow the steps below. The example
adds a `user.deactivated` event with a logging handler. Note the extra step the outbox requires over a
plain in-process design: a deserialization factory (Step 3) — without it the dispatch job cannot rebuild
the event and throws `UnknownDomainEventError`.

**Step 1 — Define the event (domain).** Create `src/domain/user/events/user-deactivated-event.ts`:

```ts
import { DomainEvent } from '@/domain/shared/domain-event';

export class UserDeactivatedEvent extends DomainEvent {
  static readonly EVENT_NAME = 'user.deactivated';

  constructor(aggregateId: string, occurredAt: Date) {
    super(aggregateId, UserDeactivatedEvent.EVENT_NAME, occurredAt);
  }
}
```

Accept and forward `occurredAt` so the factory in Step 3 can restore the original timestamp.

**Keep the payload JSON-safe.** `DomainEventSerializer.serialize` is a bare `JSON.stringify(event)` —
there is no custom encoder — so every field the outbox stores must be a **public, JSON-round-trippable
primitive**. A value object, `Map`, `Set`, or any class instance is flattened to whatever
`JSON.stringify` makes of it, a `private`/`#`-prefixed field may not be emitted at all, and a `Date`
returns as a string. `UserCreatedEvent` already respects this at the call site — `User.build(...)` passes
`user.email.toString()`, not the `Email` value object — and the price of ignoring it is a silent, lossy
round-trip that surfaces only when a handler runs. Store primitives; make the Step 3 factory rebuild
anything richer.

**Step 2 — Record it from the aggregate (domain).** In `src/domain/user/user-entity.ts`, record the
event where the state transition happens (import `UserDeactivatedEvent` at the top). `User` already
extends `AggregateRoot`, so `recordEvent` is available; the mutator already receives `now` from its
caller, so the event, `updatedAt`, and the status change share one instant:

```ts
deactivate(now: Date): void {
  if (this.isDeleted) throw new UserDeletedError(this.id);
  if (!this.isActive) return;
  this.props.status = UserStatus.Inactive;
  this.touch(now);
  this.recordEvent(new UserDeactivatedEvent(this.id, now));
}
```

**Step 3 — Register a deserialization factory (infrastructure).** In
`src/infrastructure/events/domain-event-factories.ts`, add an entry so the dispatch path can rebuild the
event from its stored JSON:

```ts
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import { UserDeactivatedEvent } from '@/domain/user/events/user-deactivated-event';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { SerializedDomainEvent } from './serialized-domain-event';

export type DomainEventFactory = (data: SerializedDomainEvent) => DomainEvent;

export const domainEventFactories: Readonly<Record<string, DomainEventFactory>> = {
  [UserCreatedEvent.EVENT_NAME]: (data) =>
    new UserCreatedEvent(data.aggregateId, data.email as string, new Date(data.occurredAt)),
  [UserDeactivatedEvent.EVENT_NAME]: (data) =>
    new UserDeactivatedEvent(data.aggregateId, new Date(data.occurredAt)),
};
```

The factory is the exact inverse of the bare `JSON.stringify` in Step 1, and it carries the whole burden
of rebuilding non-primitives: `data` is raw parsed JSON, so `occurredAt` arrives as an ISO string and
must be re-wrapped (`new Date(data.occurredAt)`), and any field the event flattened on the way in has to
be re-created here (had `UserCreatedEvent` needed an `Email` instance, its factory would call
`Email.create(data.email as string)`). Fields typed loosely on `SerializedDomainEvent` need a cast, as
`data.email as string` shows — that cast is unchecked, which is one more reason to keep payloads to
simple primitives.

**Step 4 — Write the handler (application).** Create
`src/application/user/events/user-deactivated-log-handler.ts`:

```ts
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { UserDeactivatedEvent } from '@/domain/user/events/user-deactivated-event';

interface UserDeactivatedLogHandlerDeps {
  logger: Logger;
}

export class UserDeactivatedLogHandler implements DomainEventHandler<UserDeactivatedEvent> {
  readonly eventName = UserDeactivatedEvent.EVENT_NAME;
  private readonly logger: Logger;

  constructor({ logger }: UserDeactivatedLogHandlerDeps) {
    this.logger = logger;
  }

  handle(event: UserDeactivatedEvent): Promise<void> {
    this.logger.info('User deactivated', {
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}
```

**Step 5 — Register the handler in the composition root (`src/composition/events.ts`).** Import it, declare it on
that module's `Cradle` slice, register it, and add it to the `domainEventHandlers` array (the registry is built from
that array):

```ts
import { UserDeactivatedLogHandler } from '@/application/user/events/user-deactivated-log-handler';

// in the module's declare module '@fastify/awilix' block, next to userCreatedLogHandler
userDeactivatedLogHandler: DomainEventHandler;

// in eventsRegistrations
userDeactivatedLogHandler: asClass(UserDeactivatedLogHandler).singleton(),

// extend the handler list the registry is assembled from
domainEventHandlers: asFunction(
  ({ userCreatedLogHandler, userDeactivatedLogHandler }: Pick<
    Cradle,
    'userCreatedLogHandler' | 'userDeactivatedLogHandler'
  >) => [userCreatedLogHandler, userDeactivatedLogHandler],
).singleton(),
```

**Step 6 — Stage the event from the use case.** The use case that calls `deactivate` must save and
stage inside a `unitOfWork.run(...)` block, exactly as `CreateUser` and `RegisterUser` do:

```ts
await this.uow.run(async ({ userRepository, outbox }) => {
  await userRepository.save(user);
  outbox.stage(user.pullDomainEvents());
});
```

No relay, worker, or dispatch-handler change is needed — those components are event-agnostic and route
purely by `eventName`. (Only a brand-new **job**, not a new event, would touch `src/job-catalogue.ts`.)

## Design decisions & trade-offs

- **Transactional outbox instead of synchronous in-process dispatch.** The obvious alternative — save
  the aggregate, then dispatch in-process within the same request — leaves a dual-write gap: if the
  process dies after the commit but before dispatch completes, the event is lost with no retry. The
  outbox writes the event into `outbox_messages` in the same transaction as the business change
  (`PrismaUnitOfWork` flushes `PrismaOutboxWriter.write(staged, tx)` before the commit), so the event's
  existence is exactly as durable as the fact it describes. The cost is real: eventual consistency (a
  handler runs after a relay tick — up to `OUTBOX_RELAY_INTERVAL_MS` plus queue time), the extra moving
  parts of a table, a relay job, and a dispatch job, and a hard dependency on the relay being scheduled
  — an app process running without the worker leaves events stranded as unpublished rows.
- **At-least-once delivery, so handlers must be idempotent.** `OutboxRelay` stamps `publishedAt` only
  after a successful enqueue, and `DispatchDomainEventJobHandler` lets handler errors propagate so
  BullMQ retries the job. Delivery therefore survives crashes, but the same event can be delivered more
  than once (e.g. a job retried after one of several handlers already succeeded). Guaranteeing delivery
  is worth more than avoiding a duplicate, so the contract pushes idempotency onto handlers rather than
  attempting unsupportable exactly-once semantics. The specific crash-between-enqueue-and-`updateMany`
  replay is suppressed: the relay passes the outbox row id as `deduplicationKey`, `BullMqJobQueue` turns
  it into the job id (`domain-event.dispatch.<rowId>`), and BullMQ treats a repeat `add` under a
  retained job id as a no-op that still resolves — so the replayed row is then marked published. The
  suppression window is bounded by job retention (completed: 1 hour / 1 000 entries; failed: 7 days /
  5 000), so it covers crash-restart replay, not unbounded history — one more reason the idempotency
  obligation stays with handlers. See [background-jobs.md](./background-jobs.md) before trimming those
  retention settings.
- **Two-hop jobs (relay → dispatch) rather than the relay invoking handlers directly.** The relay's only
  job is to move durable rows onto the queue quickly, in batches; handler fan-out happens in a separate
  `DISPATCH_DOMAIN_EVENT_JOB` per event. Each event gets its own retry unit and its own slot in the
  worker's concurrency, and a slow or failing handler cannot stall the relay's drain of the batch.
- **`InProcessDomainEventDispatcher` is dormant plumbing — the live path bypasses it.** The
  `domainEventDispatcher` registration in `src/composition/events.ts` (built by `createDomainEventDispatcher`) is
  resolved nowhere at runtime; its only caller is its own unit test. The runtime dispatch path is
  `OutboxRelay → DISPATCH_DOMAIN_EVENT_JOB → DispatchDomainEventJobHandler → DomainEventHandlerRegistry`.
  The two differ deliberately: the job handler awaits each handler with no `try/catch`, so a failure
  surfaces to BullMQ and triggers a retry — the semantics at-least-once delivery needs — whereas the
  in-process dispatcher catches and logs handler errors and always resolves, which is right for a
  synchronous best-effort path but would silently defeat retries here. Treat it as an optional adapter
  kept for a possible synchronous path, not part of the delivery flow this doc describes.
- **Event buffer on `AggregateRoot`, not `Entity`.** Only aggregate roots — the consistency boundaries a
  transaction saves — may announce facts, so the buffer lives on the `AggregateRoot` subclass and plain
  entities cannot record events by construction. The domain stays free of I/O either way (the buffer is
  a plain array; the use case decides when events become durable), and the split keeps "has identity"
  and "publishes facts" as separate capabilities. The cost is one more base class in the hierarchy and a
  little ceremony: every producing use case must pull and stage.
- **JSON payload with a factory registry keyed by `eventName`.** `DomainEventSerializer.serialize` is a
  plain `JSON.stringify`; `deserialize` looks up `domainEventFactories[eventName]` and calls the
  factory, which reconstructs the concrete class and restores the original `occurredAt` from the ISO
  string. The stored payload stays human-readable and storage is decoupled from class shape, at the cost
  of one registry entry per event type — a missing factory throws `UnknownDomainEventError` at dispatch
  rather than failing at compile time (mitigated by keying everything off the same `EVENT_NAME`
  constant).
- **Routing by a string `eventName`.** Handlers self-declare the key they bind to and the
  `DomainEventHandlerRegistry` indexes them into a `Map<string, handler[]>` once at construction. String
  keys keep events and handlers loosely coupled (a handler need not import the emitting aggregate), at
  the cost that a typo'd `eventName` silently never matches — mitigated by pinning the key as a single
  `static readonly EVENT_NAME` on the event and reusing it everywhere.
- **Batching and ordering in the relay.** `OutboxRelay` reads at most `RELAY_BATCH_SIZE` rows oldest
  first (`orderBy: { occurredAt: 'asc' }`) and marks only the ids it actually enqueued. Batching bounds
  each tick's work; ordering biases delivery toward causal order; per-id marking means one failing
  enqueue never blocks or double-publishes its neighbours. The `(published_at, occurred_at)` index keeps
  the "oldest unpublished" scan cheap as the table grows.

## Testing

Unit tests use Vitest with mocked ports; integration tests drive the real database (and, for the
relay/dispatch path, a real Redis via Testcontainers) end-to-end.

- **`src/domain/shared/aggregate-root.test.ts`** — the event buffer: starts empty, records events and
  returns them in insertion order, and clears on pull (a second `pullDomainEvents()` returns `[]`);
  plus the version lifecycle: a newly built aggregate reports `UNSAVED_VERSION`, a hydrated one
  reports its stored version.
- **`src/infrastructure/persistence/prisma-outbox-writer.test.ts`** — the writer emits one `createMany`
  row per event with correctly serialized columns (`id`, `aggregateId`, `eventName`, `payload`,
  `occurredAt`) using the transactional client, and performs no write for an empty array.
- **`src/infrastructure/persistence/prisma-unit-of-work.test.ts`** — runs the callback inside
  `prisma.$transaction`; flushes staged events to the outbox writer with the same `tx` client; flushes
  an empty array when nothing was staged; and, when the callback rejects, propagates the error and never
  flushes (so Prisma rolls the transaction back).
- **`src/infrastructure/persistence/outbox-retention-task.test.ts`** — names the resource it prunes
  (`outbox_messages`) and asserts the exact delete predicate,
  `{ where: { publishedAt: { lt: cutoff } } }` — i.e. **delivered rows older than the cutoff only** — and
  returns the deleted count. This is the test that pins the "unpublished rows never age out" behaviour
  described under Configuration.
- **`src/infrastructure/events/domain-event-serializer.test.ts`** — round-trips a `UserCreatedEvent`
  preserving its fields and original timestamp, serializes `occurredAt` as an ISO-8601 string, and
  throws `UnknownDomainEventError` for an unregistered event name.
- **`src/infrastructure/events/domain-event-handler-registry.test.ts`** — groups multiple handlers under
  the same `eventName`, keys handlers by their own `eventName`, and returns an empty list for an
  unregistered name.
- **`src/infrastructure/events/outbox-relay.test.ts`** — enqueues a dispatch job per pending row and
  marks exactly those ids published; keys each dispatch job on its outbox row id so a replayed batch is
  delivered once; never marks anything published when every enqueue fails (and logs each error); marks
  only the successfully-enqueued rows when one enqueue fails; and does nothing when there are no pending
  rows. The deduplication semantics those keys rely on are proven against a real Redis in
  `test/integration/jobs/` (see [background-jobs.md](./background-jobs.md)).
- **`src/start-worker.test.ts`** — the scheduling stage: `startWorker` resolves and starts `jobWorker`
  and schedules the recurring relay via `jobScheduler.schedule(OUTBOX_RELAY_JOB, {}, { everyMs:
OUTBOX_RELAY_INTERVAL_MS })` (alongside the data-retention job). Without this the delivery half never
  ticks, so it guards the one wiring step the whole outbox depends on.
- **`src/infrastructure/events/dispatch-domain-event-job-handler.test.ts`** — deserializes the event and
  invokes every registered handler; **propagates** a handler failure so BullMQ can retry; propagates
  `UnknownDomainEventError` when no factory exists; and no-ops when no handler is registered.
- **`src/infrastructure/events/in-process-domain-event-dispatcher.test.ts`** — the dormant synchronous
  adapter: routes by `eventName`, invokes every matching handler in registration order, **catches and
  logs** a failing handler without rejecting, and isolates a failure in one event from the next
  (contrast the propagating job handler above).
- **`src/application/user/events/user-created-log-handler.test.ts`** — subscribes to the `user.created`
  routing key and logs the creation with the event data.
- **`src/application/user/create-user.test.ts`** — the emit path with a fake unit of work: stages the
  `UserCreatedEvent` inside the transaction; the staged event's `occurredAt` matches the saved user's
  `createdAt` (single clock reading); and save precedes stage within the transaction.
- **`test/integration/outbox.int.test.ts`** — the end-to-end proof: creating a user writes exactly one
  unpublished outbox row; a forced failure inside the transaction (thrown after
  `outbox.stage(user.pullDomainEvents())`) commits neither the user nor any outbox row (atomic write);
  the relay drains unpublished rows once, marks them published, then no-ops on a second drain; and a
  full `create → relay → worker → handler` round-trip delivers the `UserCreatedEvent` to the real
  registered handler through a real BullMQ queue.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with
`npm run test:integration` (`vitest run -c vitest.integration.config.ts`), which requires the
integration prerequisites (a database, and Redis via Testcontainers for the relay/dispatch cases).
