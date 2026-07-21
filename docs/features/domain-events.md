# Domain Events

> **Status:** Complete · **Layers:** domain, application, infrastructure · **Verified against:** `9044a23`

## Purpose

Domain events let an aggregate (a domain entity such as `User` that owns and guards its own state)
announce a business fact that has already happened ("a user was created") without knowing, or caring,
who reacts to it. The use case that changed the aggregate stays focused on its one job; side effects —
logging, notifications, read-model projections — are added as independent handlers that subscribe to the event,
honouring the Open/Closed principle and the clean-architecture Dependency Rule. The delivery mechanism
is a **transactional outbox**: an event is written into a database table _inside the same transaction_
as the business change, then relayed to handlers asynchronously through the background-job queue. This
closes the dual-write gap a naive "save, then dispatch in-process" design leaves open — an event is
never lost if the process dies right after committing — at the price of at-least-once (rather than
exactly-once) delivery.

## How it works

The chain spans a synchronous **write half** (inside the request) and an asynchronous **delivery half**
(driven by background jobs). The two halves are joined only by rows in the `outbox_messages` table, so
nothing in the request path waits on a handler.

**Write half — atomic, inside the request transaction**

1. **Recording (domain).** When an aggregate performs a meaningful state transition it constructs a
   `DomainEvent` subclass and buffers it internally via the protected `recordEvent(...)` method on the
   base `Entity`. Concretely, `User.create(...)` calls
   `user.recordEvent(new UserCreatedEvent(user.id, user.email.toString()))`. The event is _only
   recorded_, not delivered — the entity has no dependency on any dispatcher, queue, or I/O. The buffer
   is a plain in-memory array (`_domainEvents`) on the entity instance.
2. **Staging (application).** `CreateUser.execute` (the user-creation use case documented in
   [user-crud.md](./user-crud.md)) opens a **unit of work** — a single database transaction that bundles
   the aggregate save and its event staging into one atomic commit — and, inside it, saves the aggregate
   and stages its events (`uow` is `CreateUser`'s private field for the injected `unitOfWork` port):
   ```ts
   await this.uow.run(async ({ userRepository, outbox }) => {
     await userRepository.save(newUser);
     outbox.stage(newUser.pullDomainEvents());
   });
   ```
   `pullDomainEvents()` returns a copy of the buffer and clears it, so an event is staged at most once.
   `outbox.stage(...)` does not touch the database yet; it appends the events to an in-memory array held
   by the running transaction.
3. **Writing to the outbox (infrastructure), in the same transaction.** `PrismaUnitOfWork.run` wraps the
   whole callback in `this.prisma.$transaction`. After the callback returns — but still inside the
   transaction — it flushes the staged events through `PrismaOutboxWriter.write(staged, tx)`, which
   issues `tx.outboxMessage.createMany(...)` using the same transactional client `tx` that saved the
   user. The business `INSERT` (the user row) and the outbox `INSERT`s therefore commit or roll back
   **together**. This atomicity is the entire point of the pattern: on a successful commit there is no
   window in which a user exists without its `user.created` event, or vice versa. Each row is written
   with `publishedAt = null`, marking it as not-yet-relayed.

**Delivery half — asynchronous, at-least-once, driven by jobs**

4. **Relaying.** At bootstrap, `main.ts` schedules a repeatable `OUTBOX_RELAY_JOB` (`'outbox.relay'`) to
   run every `OUTBOX_RELAY_INTERVAL_MS` (`5_000` ms) via the `JobScheduler`. Each tick runs
   `OutboxRelay.handle`, which reads up to `RELAY_BATCH_SIZE` (`100`) unpublished rows
   (`where: { publishedAt: null }`, oldest first by `occurredAt`), and for each row enqueues a
   `DISPATCH_DOMAIN_EVENT_JOB` (`'domain-event.dispatch'`) carrying `{ eventName, payload }` onto the
   `JobQueue`. It collects the ids it successfully enqueued and, in one `updateMany`, stamps their
   `publishedAt`. A row whose enqueue throws is logged and left unpublished, so the next tick retries it —
   nothing is dropped.
5. **Dispatching.** The `JobWorker` picks up each `DISPATCH_DOMAIN_EVENT_JOB` and runs
   `DispatchDomainEventJobHandler.handle`. It rebuilds the concrete event from its stored JSON via
   `DomainEventSerializer.deserialize(eventName, payload)` — which looks the `eventName` up in the
   `domainEventFactories` registry and calls the matching factory — then fans the event out over the
   `DomainEventHandlerRegistry`, awaiting `handler.handle(event)` for every handler registered under that
   `eventName`.
6. **Handling.** The matched handler runs. For `user.created`, `UserCreatedLogHandler` writes a
   structured log line (`aggregateId`, `email`, `occurredAt`) through the `Logger` port.

Failure paths that matter:

- **Transaction rollback.** If anything inside `uow.run` throws, `$transaction` rolls back: the user row
  is discarded and — because the throw short-circuits the callback before the flush — no outbox row is
  ever written either. An event can never escape for a change that failed to persist.
- **Relay enqueue failure.** If the queue is unavailable, `OutboxRelay` marks only the rows it actually
  enqueued, so unenqueued rows remain `publishedAt = null` and are retried on the next tick — the retry
  mechanism that makes delivery **at-least-once** (and so, on a crash-replay, possibly more than once),
  never at-most-once.
- **Handler failure.** `DispatchDomainEventJobHandler` does **not** swallow handler errors; a throw
  propagates out of the job, so BullMQ retries it on the shared queue's retry policy — `attempts: 3`
  with exponential backoff (first retry after ~1 s). Once those attempts are exhausted the job comes to
  rest in BullMQ's failed set rather than being dropped (see [background-jobs.md](./background-jobs.md)
  for the queue's retry and retention settings). Combined with relay retries, delivery is at-least-once,
  which means **a handler can be invoked more than once for the same event and must therefore be
  idempotent** — running it again with the same event produces the same end state and no additional side
  effects.
- **Unknown event.** If a stored `eventName` has no entry in `domainEventFactories`, `deserialize` throws
  `UnknownDomainEventError`; the dispatch job fails and retries (it will keep failing until a factory is
  registered).

## Architecture

The feature is split across the port/adapter boundary. The domain owns the `DomainEvent` base type and
the event buffer on `Entity`. The application layer defines the abstractions — the
`DomainEventDispatcher` and `DomainEventHandler` **ports**, and the `OutboxStaging` contract exposed on
the unit-of-work `TransactionContext`. Infrastructure supplies every concrete: the outbox writer,
serializer, factory registry, handler registry, relay, and dispatch job handler. Dependencies point
inward — the domain entity depends on nothing, the use case depends on the `UnitOfWork` and
`OutboxStaging` interfaces (never on Prisma or BullMQ), and concretes are bound to ports only in
`src/container.ts`. The event machinery rides on the generic background-job ports (`JobQueue`,
`JobScheduler`, `JobHandler`) documented in [background-jobs.md](./background-jobs.md); this feature does
not re-implement queueing.

| Component                                     | Layer                   | Responsibility                                                                                                                                                              | File                                                              |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DomainEvent`                                 | Domain                  | Abstract base for every event; carries `aggregateId`, `eventName`, and an `occurredAt` timestamp (defaulting to now, but overridable so it survives a serialize round-trip) | `src/domain/shared/domain-event.ts`                               |
| `Entity` (`recordEvent` / `pullDomainEvents`) | Domain                  | Buffers events an aggregate records, and drains-and-clears them on pull                                                                                                     | `src/domain/shared/entity.ts`                                     |
| `UserCreatedEvent`                            | Domain                  | Concrete event for user creation; pins routing key `EVENT_NAME = 'user.created'` and carries `email`                                                                        | `src/domain/user/events/user-created-event.ts`                    |
| `User`                                        | Domain                  | Records `UserCreatedEvent` inside `User.create(...)`                                                                                                                        | `src/domain/user/user-entity.ts`                                  |
| `DomainEventDispatcher`                       | Application (port)      | Interface for fanning a batch of events out to handlers                                                                                                                     | `src/application/shared/ports/domain-event-dispatcher.ts`         |
| `DomainEventHandler`                          | Application (port)      | Interface a subscriber implements: an `eventName` to bind to and an async `handle`                                                                                          | `src/application/shared/ports/domain-event-handler.ts`            |
| `OutboxStaging` (on `TransactionContext`)     | Application (port)      | `stage(events)` — how a use case hands its events to the running transaction for outbox persistence                                                                         | `src/application/shared/ports/unit-of-work.ts`                    |
| `UserCreatedLogHandler`                       | Application             | Subscribes to `user.created` and logs the creation                                                                                                                          | `src/application/user/events/user-created-log-handler.ts`         |
| `CreateUser`                                  | Application             | Saves the user and stages its events inside one unit-of-work transaction                                                                                                    | `src/application/user/create-user.ts`                             |
| `PrismaUnitOfWork`                            | Infrastructure          | Runs the business callback and flushes staged events to the outbox in the same DB transaction                                                                               | `src/infrastructure/persistence/prisma-unit-of-work.ts`           |
| `PrismaOutboxWriter`                          | Infrastructure          | Serializes staged events and `createMany`s them into `outbox_messages` using the transactional client                                                                       | `src/infrastructure/persistence/prisma-outbox-writer.ts`          |
| `DomainEventSerializer`                       | Infrastructure          | `serialize` (event → JSON string) and `deserialize` (event name + JSON → concrete event via a factory)                                                                      | `src/infrastructure/events/domain-event-serializer.ts`            |
| `SerializedDomainEvent`                       | Infrastructure          | Shape of the parsed JSON a factory reads (`aggregateId`, `eventName`, `occurredAt`, plus payload fields)                                                                    | `src/infrastructure/events/serialized-domain-event.ts`            |
| `domainEventFactories`                        | Infrastructure          | Registry mapping each `eventName` to a factory that reconstructs its concrete event class                                                                                   | `src/infrastructure/events/domain-event-factories.ts`             |
| `DomainEventHandlerRegistry`                  | Infrastructure          | Indexes handlers into a `Map<eventName, handler[]>` for O(1) lookup at dispatch time                                                                                        | `src/infrastructure/events/domain-event-handler-registry.ts`      |
| `OutboxRelay`                                 | Infrastructure          | Repeatable job: reads unpublished rows, enqueues a dispatch job per event, marks the enqueued rows published                                                                | `src/infrastructure/events/outbox-relay.ts`                       |
| `DispatchDomainEventJobHandler`               | Infrastructure          | Per-event job: deserializes the event and fans it out over the handler registry, propagating failures for retry                                                             | `src/infrastructure/events/dispatch-domain-event-job-handler.ts`  |
| `InProcessDomainEventDispatcher`              | Infrastructure          | `DomainEventDispatcher` adapter: synchronous, error-isolating fan-out over the registry — wired as the port, but not on the async outbox path (see Design decisions)        | `src/infrastructure/events/in-process-domain-event-dispatcher.ts` |
| `createDomainEventDispatcher`                 | Composition root        | Factory that builds the `InProcessDomainEventDispatcher` from the registry + logger                                                                                         | `src/container.ts`                                                |
| `OutboxMessage` (`outbox_messages`)           | Infrastructure (schema) | The outbox table: `id`, `aggregate_id`, `event_name`, `payload`, `occurred_at`, `published_at`, indexed on `(published_at, occurred_at)`                                    | `prisma/schema.prisma`                                            |

## Public surface

This is a cross-cutting infrastructure feature with no HTTP endpoints. The contract another engineer
programs against is the following pieces.

**1. `DomainEvent` — the event shape (extend this).**

```ts
export abstract class DomainEvent {
  readonly occurredAt: Date;

  protected constructor(
    readonly aggregateId: string,
    readonly eventName: string,
    occurredAt?: Date,
  ) {
    this.occurredAt = occurredAt ?? new Date();
  }
}
```

The optional `occurredAt` parameter is what lets a factory rebuild an event with its **original**
timestamp after a serialize round-trip, instead of stamping the moment of deserialization. A concrete
event pins its `eventName` as a `static readonly EVENT_NAME` and adds payload fields, e.g.
`UserCreatedEvent(aggregateId: string, email: string, occurredAt?: Date)` with
`EVENT_NAME = 'user.created'`.

**2. Recording an event from an entity.** Inside an aggregate method, call the protected base method —
it only buffers:

```ts
this.recordEvent(new UserCreatedEvent(this.id, this.email.toString()));
```

The base `Entity` exposes `public pullDomainEvents(): DomainEvent[]`, which returns the buffered events
and clears the buffer. `recordEvent` is `protected` (only the entity's own methods may record);
`pullDomainEvents` is `public` so the application layer can drain the buffer.

**3. `OutboxStaging.stage` — persist events atomically (call this from a use case).** Inside a
`unitOfWork.run(...)` callback, hand the pulled events to the transaction's `outbox`:

```ts
export interface OutboxStaging {
  stage(events: readonly DomainEvent[]): void;
}
```

Staging is what routes events into the transactional outbox; a use case that mutates state but never
stages its events will silently deliver nothing. See [user-crud.md](./user-crud.md) for the full
`CreateUser` example; the `UnitOfWork`, `TransactionContext`, and `OutboxStaging` port surface lives in
`src/application/shared/ports/unit-of-work.ts`.

**4. `DomainEventHandler` — subscribing (implement this).**

```ts
export interface DomainEventHandler<E extends DomainEvent = DomainEvent> {
  readonly eventName: string; // must equal the event's EVENT_NAME
  handle(event: E): Promise<void>; // the reaction — must be idempotent
}
```

A handler binds to exactly one `eventName`. Many handlers may share the same `eventName`; the dispatch
job invokes them all, in the order they were registered in `container.ts`. Because delivery is
at-least-once, `handle` must tolerate being called more than once for the same event.

## Configuration

This feature defines **no environment variables of its own**. Two behavioural constants are pinned in
code rather than configured:

| Constant                   | Value   | Meaning                                                               | File                                        |
| -------------------------- | ------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `OUTBOX_RELAY_INTERVAL_MS` | `5_000` | How often the relay job runs (worst-case delivery latency floor)      | `src/infrastructure/events/outbox-relay.ts` |
| `RELAY_BATCH_SIZE`         | `100`   | Max unpublished rows drained per relay tick (module-private constant) | `src/infrastructure/events/outbox-relay.ts` |

Delivery rides on the shared background-job infrastructure, whose keys are parsed in `src/config/env.ts`
(mirrored in `.env.example`) and documented in full in [background-jobs.md](./background-jobs.md). The
keys that materially affect this feature:

| Variable            | Default                                                        | Meaning                                                                                    |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`      | (required, no default)                                         | Connection string for the Prisma client that writes and reads `outbox_messages`.           |
| `REDIS_URL`         | `redis://127.0.0.1:6379` (dev default; required in production) | Redis connection backing the BullMQ queue the relay enqueues onto and the worker consumes. |
| `QUEUE_PREFIX`      | `finflow`                                                      | Key prefix isolating this app's BullMQ queues in Redis.                                    |
| `QUEUE_CONCURRENCY` | `5`                                                            | Worker concurrency — how many dispatch (and other) jobs run in parallel.                   |

## Usage & extension

To add a new event, deliver it through the outbox, and react to it, follow the steps below. The example
adds a `user.deactivated` event with a logging handler. **Note the extra step the outbox requires over a
plain in-process design: a deserialization factory (Step 3) — without it the dispatch job cannot rebuild
the event and throws `UnknownDomainEventError`.**

**Step 1 — Define the event (domain).** Create `src/domain/user/events/user-deactivated-event.ts`:

```ts
import { DomainEvent } from '@/domain/shared/domain-event';

export class UserDeactivatedEvent extends DomainEvent {
  static readonly EVENT_NAME = 'user.deactivated';

  constructor(aggregateId: string, occurredAt?: Date) {
    super(aggregateId, UserDeactivatedEvent.EVENT_NAME, occurredAt);
  }
}
```

Accept and forward the optional `occurredAt` so the factory in Step 3 can restore the original timestamp.

**Step 2 — Record it from the aggregate (domain).** In `src/domain/user/user-entity.ts`, record the
event where the state transition happens (import `UserDeactivatedEvent` at the top):

```ts
deactivate(): void {
  if (this.isDeleted) throw new UserDeletedError(this.id);
  if (!this.isActive) return;
  this.props.status = UserStatus.Inactive;
  this.touch();
  this.recordEvent(new UserDeactivatedEvent(this.id));
}
```

**Step 3 — Register a deserialization factory (infrastructure).** In
`src/infrastructure/events/domain-event-factories.ts`, add an entry so the relay/dispatch path can
rebuild the event from its stored JSON:

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

**Step 5 — Register the handler in the composition root (`src/container.ts`).** Import it, declare it on
the `Cradle`, register it, and add it to the `domainEventHandlers` array (the registry is built from that
array):

```ts
import { UserDeactivatedLogHandler } from '@/application/user/events/user-deactivated-log-handler';

// in the Cradle interface, near userCreatedLogHandler
userDeactivatedLogHandler: DomainEventHandler;

// in registerDependencies(...)'s container.register({ ... })
userDeactivatedLogHandler: asClass(UserDeactivatedLogHandler).singleton(),

// extend the handler list the registry is assembled from
domainEventHandlers: asFunction(
  ({ userCreatedLogHandler, userDeactivatedLogHandler }: Pick<
    Cradle,
    'userCreatedLogHandler' | 'userDeactivatedLogHandler'
  >) => [userCreatedLogHandler, userDeactivatedLogHandler],
).singleton(),
```

**Step 6 — Stage the event from the use case.** The use case that calls `deactivate` must persist and
stage its events inside a `unitOfWork.run(...)` block, exactly as `CreateUser` does:

```ts
await this.uow.run(async ({ userRepository, outbox }) => {
  await userRepository.save(user);
  outbox.stage(user.pullDomainEvents());
});
```

No relay, worker, or dispatch-handler change is needed — they are event-agnostic and route purely by
`eventName`.

## Design decisions & trade-offs

- **Transactional outbox instead of synchronous in-process dispatch.** The obvious alternative is to save
  the aggregate and _then_ dispatch events in-process within the same request. That leaves a dual-write
  gap: if the process dies after the commit but before (or during) dispatch, the event is lost, and there
  is no retry. The outbox closes the gap by writing the event into `outbox_messages` **in the same
  transaction** as the business change (`PrismaUnitOfWork` flushes `PrismaOutboxWriter.write(staged, tx)`
  before the transaction commits), so the event's existence is exactly as durable as the fact it
  describes. The cost is real: **eventual consistency** (a handler runs after a relay tick, not
  synchronously — up to `OUTBOX_RELAY_INTERVAL_MS` of latency plus queue time), the extra moving parts of
  a table, a relay job, and a dispatch job, and a hard dependency on the relay actually being scheduled
  (an unscheduled relay leaves events stranded as unpublished rows).
- **At-least-once delivery, so handlers must be idempotent.** `OutboxRelay` stamps a row's `publishedAt`
  only after its enqueue succeeds, and `DispatchDomainEventJobHandler` lets handler errors propagate so
  BullMQ retries the job. This guarantees delivery even across crashes, but the same event can be
  delivered more than once (e.g. the relay enqueues a job then dies before its `updateMany`; or a job is
  retried after one of several handlers already succeeded). Guaranteeing delivery is worth far more than
  avoiding a duplicate, so the contract pushes idempotency onto the handler rather than attempting
  unsupportable exactly-once semantics.
- **Two-hop jobs (relay → dispatch) rather than the relay invoking handlers directly.** The relay's only
  job is to move durable rows onto the queue quickly and in batches; the actual handler fan-out happens in
  a separate `DISPATCH_DOMAIN_EVENT_JOB` per event. This gives each event its own retry unit and its own
  slot in the worker's concurrency, and keeps a slow or failing handler from stalling the relay's drain of
  the whole batch.
- **The live path bypasses `InProcessDomainEventDispatcher` — it is dormant plumbing.**
  `DispatchDomainEventJobHandler` calls `registry.handlersFor(eventName)` itself and awaits each handler
  with no `try/catch`, so a failure surfaces to BullMQ and triggers a retry — exactly the semantics
  at-least-once delivery needs. `InProcessDomainEventDispatcher` (the registered `DomainEventDispatcher`
  port adapter, built by `createDomainEventDispatcher`) does the opposite: it catches and logs handler
  errors and always resolves, which is right for a synchronous best-effort path but would silently defeat
  retries here. **It is wired in `container.ts` but has no runtime `.dispatch()` caller** — nothing
  resolves `domainEventDispatcher` outside its own unit test. Treat it as legacy/optional plumbing kept
  for a possible synchronous path, not part of the delivery flow this doc describes.
- **Events recorded on the entity, pulled and staged by the use case.** The base `Entity` only _buffers_
  events; it never touches a dispatcher, queue, or database, keeping the domain free of I/O (the
  Dependency Rule). The use case decides _when_ events become durable — here, only within the same
  transaction as the save. The cost is a little ceremony: every dispatching use case must pull and stage.
- **JSON payload with a factory registry keyed by `eventName`.** `DomainEventSerializer.serialize` is a
  plain `JSON.stringify`; `deserialize` looks the `eventName` up in `domainEventFactories` and calls the
  factory, which reconstructs the concrete class (restoring the original `occurredAt`). This keeps the
  stored payload human-readable and decouples storage from class shape, at the cost of one registry entry
  per event type — a missing factory throws `UnknownDomainEventError` at dispatch rather than failing at
  compile time (mitigated by keying off the same `EVENT_NAME` constant everywhere).
- **Routing by a string `eventName`.** Handlers self-declare the routing key they bind to, and the
  `DomainEventHandlerRegistry` indexes them into a `Map<string, handler[]>` once at construction. String
  keys keep events and handlers loosely coupled (a handler need not import the emitting aggregate), at the
  cost that a typo'd `eventName` silently never matches — mitigated by pinning the key as a single
  `static readonly EVENT_NAME` on the event and reusing it.
- **Batching and ordering in the relay.** `OutboxRelay` reads at most `RELAY_BATCH_SIZE` rows oldest first
  (`orderBy: { occurredAt: 'asc' }`) and marks only the ids it actually enqueued. Batching bounds each
  tick's work; ordering biases delivery toward causal order; per-id marking means a single failing enqueue
  never blocks or double-publishes its neighbours. The `(published_at, occurred_at)` index keeps the
  "oldest unpublished" scan cheap as the table grows.

## Testing

Unit tests use Vitest with mocked ports; integration tests drive the real database (and, for the
relay/dispatch path, a real Redis via Testcontainers) end-to-end.

- **`src/domain/shared/entity.test.ts`** — the base entity's behaviours: getters, `equals`, `touch`, and
  `softDelete`/`restore`. (It does **not** touch the domain-event buffer; `recordEvent` /
  `pullDomainEvents` are exercised through the use-case and integration tests below.)
- **`src/infrastructure/persistence/prisma-outbox-writer.test.ts`** — the writer emits one `createMany`
  row per event with correctly serialized columns (`id`, `aggregateId`, `eventName`, `payload`,
  `occurredAt`) using the transactional client, and performs no write (and generates no id) for an empty
  array.
- **`src/infrastructure/persistence/prisma-unit-of-work.test.ts`** — runs the callback inside
  `prisma.$transaction`; flushes the staged events to the outbox writer with the same `tx` client;
  flushes an empty array when nothing was staged; and, when the callback rejects, propagates the error and
  **never flushes** (so Prisma rolls the transaction back).
- **`src/infrastructure/events/domain-event-serializer.test.ts`** — round-trips a `UserCreatedEvent`
  preserving its fields and original timestamp, serializes `occurredAt` as an ISO-8601 string, and throws
  `UnknownDomainEventError` for an unregistered event name.
- **`src/infrastructure/events/domain-event-handler-registry.test.ts`** — groups multiple handlers under
  the same `eventName`, keys handlers by their own `eventName`, and returns an empty list for an
  unregistered name.
- **`src/infrastructure/events/outbox-relay.test.ts`** — enqueues a dispatch job per pending row and marks
  exactly those ids published; never marks anything published when every enqueue fails (nothing is lost);
  marks only the successfully-enqueued rows when one enqueue fails; and no-ops when there are no pending
  rows.
- **`src/infrastructure/events/dispatch-domain-event-job-handler.test.ts`** — deserializes the event and
  invokes every registered handler; **propagates** a handler failure so BullMQ can retry; propagates
  `UnknownDomainEventError` when no factory exists; and no-ops when no handler is registered.
- **`src/infrastructure/events/in-process-domain-event-dispatcher.test.ts`** — the dormant synchronous
  adapter: routes by `eventName`, invokes every matching handler in registration order, **catches and
  logs** a failing handler without rejecting, and isolates a failure in one event from the next (contrast
  the propagating job handler above).
- **`src/application/user/events/user-created-log-handler.test.ts`** — the handler subscribes to
  `UserCreatedEvent.EVENT_NAME` and logs `'User created'` with `aggregateId`, `email`, and
  `occurredAt.toISOString()`.
- **`src/application/user/create-user.test.ts`** — proves the emit path with a fake unit of work:
  `execute` stages exactly one `UserCreatedEvent` (the event `User.create` recorded, drained via
  `pullDomainEvents`) carrying the new user's `aggregateId` and `email`; save precedes stage within the
  transaction; and nothing is staged (nor a transaction opened) when the email is already taken.
- **`test/integration/outbox.int.test.ts`** — the end-to-end proof: creating a user writes exactly one
  unpublished outbox row; a forced failure inside the transaction (thrown after
  `outbox.stage(user.pullDomainEvents())`) commits **neither** the user nor any outbox row (atomic write);
  the relay drains unpublished rows once, marks them published, then no-ops on a second drain (idempotent);
  and a full `create → relay → worker → handler` round-trip delivers the `UserCreatedEvent` to the real
  registered handler through a real BullMQ queue.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with
`npm run test:integration` (`vitest run -c vitest.integration.config.ts`), which requires the integration
prerequisites (a database, and Redis for the relay/dispatch cases).
