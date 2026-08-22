# Unit of Work & Persistence

> **Status:** Complete · **Layers:** application, infrastructure · **Verified against:** `5156995`

## Purpose

A single use case often has to change more than one thing at once: registering a user writes both the
`User` row and its email-verification code; resetting a password writes the new hash _and_ consumes the
reset token; syncing authorization upserts permissions, creates the superadmin role, and grants it. If
those writes land as independent statements, a crash between them leaves the database in a state the
domain considers impossible — a user with no verification code, a spent token against an unchanged
password. The **Unit of Work** gives the application layer one way to say "all of these writes commit
together or none of them do", expressed as a port so the use case never learns that the mechanism
underneath is a Prisma interactive transaction. The same boundary is what makes the transactional
outbox correct: staged domain events are written inside the very transaction that made the business
change, closing the dual-write gap described in [domain-events.md](./domain-events.md).

## How it works

`UnitOfWork` exposes exactly one method, `run`, which takes a callback and returns whatever that
callback returns. Everything transactional happens inside the callback; everything outside it is
non-transactional.

**The happy path.** A use case — say `RegisterUser.execute` — does its reads, validation, and pure
domain work _first_, using the container-level repositories injected into its constructor. It creates
the `User` aggregate and issues the verification code in memory. Only then does it call
`this.uow.run(...)`, and the callback body is deliberately small: just the writes.

```ts
await this.uow.run(async ({ userRepository, emailVerificationCodeRepository, outbox }) => {
  await userRepository.save(user);
  await emailVerificationCodeRepository.create(code);
  outbox.stage(user.pullDomainEvents());
});
```

Inside `PrismaUnitOfWork.run`, this happens in order:

1. **Open the transaction.** `this.prisma.$transaction(async (tx) => { ... })` starts a Prisma
   _interactive_ transaction and yields a transaction-scoped client `tx`.
2. **Create the outbox staging buffer.** A local `staged: DomainEvent[]` array is declared first and
   exposed to the callback as `outbox`, whose `stage(events)` simply appends to it.
3. **Build per-transaction repositories.** A fresh `TransactionalRepositories` bundle is constructed on
   every call, with each adapter handed `tx` instead of the root client:
   `new PrismaUserRepository({ prisma: tx })`, and likewise for the role, permission, user-role,
   email-verification-code, and password-reset-token repositories. Because these instances are created
   per invocation and never shared, `run` is safe under concurrent requests. `TransactionContext` is the
   union of this bundle and the `outbox` handle, which is why the callback can destructure both from one
   parameter.
4. **Run the callback.** `const result = await work(context)` — the use case performs its writes through
   the transaction-scoped repositories.
5. **Flush the outbox.** `await this.outboxWriter.write(staged, tx)` inserts one `outbox_messages` row
   per staged event, using the _same_ `tx`. The flush is unconditional: with nothing staged the writer
   receives an empty array and returns without issuing a query.
6. **Return.** `result` is returned out of `$transaction`, and Prisma commits.

**The failure path that matters.** `run` catches nothing. If the callback rejects — a domain rule
throws, a `save` hits a constraint, the process is interrupted — the rejection propagates out of the
`$transaction` callback, Prisma rolls the transaction back, and step 5 never runs. Business rows and
outbox rows therefore share one fate; you can never observe an event for a change that did not commit,
nor a committed change whose event was lost.

**How database errors reach the caller.** Prisma throws driver-flavoured errors that the application
layer must not know about. Each repository wraps its write in `try/catch` and delegates to
`mapPrismaError(error)`, which translates the two codes the domain has opinions about — `P2002`
(unique-constraint violation) into `ConflictError` with code `UNIQUE_VIOLATION`, and `P2025` (record not
found) into `NotFoundError` with code `RECORD_NOT_FOUND` — and funnels everything else into a generic
`InternalError('Database operation failed')` with the original error preserved as `cause`. The function
is typed `never`: it always throws, so a caller writes `mapPrismaError(error)` as the last statement of
its `catch` block without a redundant `throw`. Because these are the shared error types from
`src/shared/errors`, the HTTP error handler renders them without any Prisma-specific knowledge.

## Architecture

The port lives in the application layer and names only domain and application types; the adapter lives
in infrastructure and is the only place `$transaction`, `PrismaClient`, and Prisma error codes appear.
A use case depends on the `UnitOfWork` interface and receives a `TransactionContext` whose members are
themselves interfaces — `UserRepository`, `RoleRepository`, `EmailVerificationCodeRepository`,
`PasswordResetTokenRepository` (domain), `PermissionRepository`, `UserRoleRepository` (application
ports) — so no application file imports Prisma. Dependencies point
inward throughout, and `PrismaUnitOfWork` binds to the `unitOfWork` port in `src/composition/persistence.ts` alone.
Each repository is paired with a **mapper**: a module of two pure functions that translates between the
Prisma row type and the domain entity, keeping the persistence schema and the domain model free to
diverge.

| Component                         | Layer              | Responsibility                                                                                                             | File                                                            |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `UnitOfWork`                      | Application (port) | The contract: `run<T>(work)` executes a callback atomically and returns its result                                         | `src/application/shared/ports/unit-of-work.ts`                  |
| `TransactionalRepositories`       | Application (port) | The six repositories a transactional callback may write through                                                            | `src/application/shared/ports/unit-of-work.ts`                  |
| `OutboxStaging`                   | Application (port) | `stage(events)` — hands domain events to the running transaction                                                           | `src/application/shared/ports/unit-of-work.ts`                  |
| `TransactionContext`              | Application (port) | `TransactionalRepositories` plus a readonly `outbox`; the callback's single parameter                                      | `src/application/shared/ports/unit-of-work.ts`                  |
| `PermissionRepository`            | Application (port) | `findAll`, `upsertByKey`, `deleteByKeys` over `PermissionRecord` (a flat record, not an aggregate)                         | `src/application/shared/ports/permission-repository.ts`         |
| `UserRoleRepository`              | Application (port) | The user↔role join table: `listRoleIdsForUser`, `assign`, `revoke`                                                         | `src/application/shared/ports/user-role-repository.ts`          |
| `UserRepository`                  | Domain             | `list`, `findById`, `findByEmail`, `save` — the first two exclude soft-deleted users                                       | `src/domain/user/user-repository.ts`                            |
| `RoleRepository`                  | Domain             | `list`, `findById`, `findByKey`, `findByName`, `save`                                                                      | `src/domain/authorization/role-repository.ts`                   |
| `EmailVerificationCodeRepository` | Domain             | `create`, `update`, `findActiveByUserId`                                                                                   | `src/domain/verification/email-verification-code-repository.ts` |
| `PasswordResetTokenRepository`    | Domain             | `create`, `update`, `findByTokenHash`, `invalidateAllForUser`, `deleteExpired`                                             | `src/domain/password-reset/password-reset-token-repository.ts`  |
| `RefreshTokenRepository`          | Domain             | Session tokens — deliberately **outside** the transactional bundle (see Design decisions)                                  | `src/domain/auth/refresh-token-repository.ts`                   |
| `PrismaUnitOfWork`                | Infrastructure     | Opens `$transaction`, builds per-tx repositories, runs the callback, flushes staged events                                 | `src/infrastructure/persistence/prisma-unit-of-work.ts`         |
| `PrismaTransactionalClient`       | Infrastructure     | `PrismaClient \| Prisma.TransactionClient` — lets one adapter serve both modes                                             | `src/infrastructure/persistence/prisma-transactional-client.ts` |
| `createPrismaClient`              | Infrastructure     | Builds the root `PrismaClient` over the `PrismaMariaDb` driver adapter from `DATABASE_URL`                                 | `src/infrastructure/persistence/prisma-client.ts`               |
| `mapPrismaError`                  | Infrastructure     | Translates `PrismaClientKnownRequestError` codes into the shared error types; returns `never`                              | `src/infrastructure/persistence/prisma-error.ts`                |
| `PrismaUserRepository`            | Infrastructure     | Representative adapter: `save` inserts or applies a version-guarded update, delegates row↔entity translation to the mapper | `src/infrastructure/persistence/prisma-user-repository.ts`      |
| `toDomain` / `toPersistence`      | Infrastructure     | The user mapper: `UserRow` → `User.hydrate(...)` and `User` → `UserRow`                                                    | `src/infrastructure/persistence/prisma-user-mapper.ts`          |
| `PrismaOutboxWriter`              | Infrastructure     | `write(events, tx)` — serializes staged events into `outbox_messages` on the given client                                  | `src/infrastructure/persistence/prisma-outbox-writer.ts`        |

## Public surface

The contract an application-layer consumer programs against is the `unitOfWork` cradle registration,
typed as:

```ts
export interface UnitOfWork {
  run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
```

`run` is generic in `T`: whatever the callback resolves to is what `run` resolves to, so a use case can
either ignore the return value (`await this.uow.run(...)`) or hand its result straight back
(`return this.unitOfWork.run(...)`, as `SyncAuthorization.execute` does).

The callback receives one `TransactionContext`:

```ts
export interface TransactionalRepositories {
  userRepository: UserRepository;
  roleRepository: RoleRepository;
  permissionRepository: PermissionRepository;
  userRoleRepository: UserRoleRepository;
  emailVerificationCodeRepository: EmailVerificationCodeRepository;
  passwordResetTokenRepository: PasswordResetTokenRepository;
}

export interface OutboxStaging {
  stage(events: readonly DomainEvent[]): void;
}

export interface TransactionContext extends TransactionalRepositories {
  readonly outbox: OutboxStaging;
}
```

`stage` is synchronous and returns `void` — it only buffers. Nothing is written until `run` flushes
after the callback resolves.

Every current caller and what it makes atomic:

| Caller                 | File                                                  | Atomic unit                                                                                                     |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CreateUser`           | `src/application/user/create-user.ts`                 | Save the user + stage its `user.created` event                                                                  |
| `RegisterUser`         | `src/application/auth/register-user.ts`               | Save the user + create its verification code + stage its events                                                 |
| `EditUser`             | `src/application/user/edit-user.ts`                   | Save the edited user + create or reissue the email-verification code when the email changed                     |
| `VerifyEmail`          | `src/application/auth/verify-email.ts`                | Save the now-active user + update the consumed verification code                                                |
| `RequestPasswordReset` | `src/application/auth/request-password-reset.ts`      | Invalidate all outstanding reset tokens + create the new one                                                    |
| `ResetPassword`        | `src/application/auth/reset-password.ts`              | Save the user's new password hash + mark the reset token consumed                                               |
| `SyncAuthorization`    | `src/application/authorization/sync-authorization.ts` | Upsert the permission catalogue + prune removed keys + create the superadmin role + promote the bootstrap admin |

Repository adapters are also usable **outside** a transaction. Each is registered as a container
singleton over the root `PrismaClient` and injected directly into use cases for reads and standalone
writes; `PrismaUserRepository`, `PrismaRoleRepository`, `PrismaPermissionRepository`,
`PrismaUserRoleRepository`, `PrismaEmailVerificationCodeRepository`, and
`PrismaPasswordResetTokenRepository` all declare their constructor dependency as
`PrismaTransactionalClient`, which is what lets one class serve both modes unchanged.

## Configuration

| Variable       | Default                                          | Meaning                                                                                                                                     |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | none — required (`str()` in `src/config/env.ts`) | MariaDB/MySQL connection string passed to `new PrismaMariaDb(...)` in `createPrismaClient`; e.g. `mysql://user:password@localhost:3306/app` |

Transaction behaviour itself is not configurable: `run` calls `$transaction` without a `maxWait`,
`timeout`, or `isolationLevel` option, so Prisma's defaults apply.

## Usage & extension

**Using it in a use case.** Declare `unitOfWork: UnitOfWork` in the dependency interface, assign it in
the constructor, then keep the callback to writes only:

```ts
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';

export interface ArchiveUserDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  clock: Clock;
}

export class ArchiveUser {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly clock: Clock;

  constructor({ unitOfWork, userRepository, clock }: ArchiveUserDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.clock = clock;
  }

  async execute(id: string): Promise<void> {
    const user = await this.users.findById(id);
    if (!user) throw new UserNotFoundError(id);

    user.softDelete(this.clock.now());

    await this.uow.run(async ({ userRepository, outbox }) => {
      await userRepository.save(user);
      outbox.stage(user.pullDomainEvents());
    });
  }
}
```

Three rules follow from how `run` is built. Read and validate _before_ opening the transaction so it
stays short. Use the destructured repositories from the context, never `this.users`, inside the
callback — the injected singleton writes on the root client and would commit independently. And put
non-database side effects (`jobQueue.enqueue`, email sends) _after_ `run` returns, so a rollback cannot
leave a job pointing at a row that was never committed; `RegisterUser`, `EditUser`, `ResetPassword`, and
`RequestPasswordReset` all enqueue only once the transaction has committed.

**Adding a repository to the transactional bundle.** Say a new `Invoice` aggregate must be written
atomically alongside a user.

1. Define the interface in the domain, `src/domain/invoice/invoice-repository.ts`:

   ```ts
   import type { Invoice } from './invoice-entity';

   export interface InvoiceRepository {
     create(invoice: Invoice): Promise<void>;

     findById(id: string): Promise<Invoice | null>;
   }
   ```

2. Write the mapper `src/infrastructure/persistence/prisma-invoice-mapper.ts` — two pure functions,
   mirroring `prisma-user-mapper.ts`:

   ```ts
   import { Invoice } from '@/domain/invoice/invoice-entity';
   import type { Invoice as InvoiceRow } from '@/generated/prisma/client';

   export function toDomain(row: InvoiceRow): Invoice {
     return Invoice.hydrate({
       id: row.id,
       userId: row.userId,
       amountCents: row.amountCents,
       createdAt: row.createdAt,
       updatedAt: row.updatedAt,
     });
   }

   export function toPersistence(invoice: Invoice): InvoiceRow {
     return {
       id: invoice.id,
       userId: invoice.userId,
       amountCents: invoice.amountCents,
       createdAt: invoice.createdAt,
       updatedAt: invoice.updatedAt,
     };
   }
   ```

3. Write the adapter `src/infrastructure/persistence/prisma-invoice-repository.ts`. Type the injected
   client as `PrismaTransactionalClient` — this is the step that makes the class usable both inside and
   outside a transaction — and route write failures through `mapPrismaError`:

   ```ts
   import { toDomain, toPersistence } from './prisma-invoice-mapper';
   import { mapPrismaError } from './prisma-error';
   import type { InvoiceRepository } from '@/domain/invoice/invoice-repository';
   import type { Invoice } from '@/domain/invoice/invoice-entity';
   import type { PrismaTransactionalClient } from './prisma-transactional-client';

   interface PrismaInvoiceRepositoryDeps {
     prisma: PrismaTransactionalClient;
   }

   export class PrismaInvoiceRepository implements InvoiceRepository {
     private readonly prisma: PrismaTransactionalClient;

     constructor({ prisma }: PrismaInvoiceRepositoryDeps) {
       this.prisma = prisma;
     }

     async create(invoice: Invoice): Promise<void> {
       try {
         await this.prisma.invoice.create({ data: toPersistence(invoice) });
       } catch (error) {
         mapPrismaError(error);
       }
     }

     async findById(id: string): Promise<Invoice | null> {
       const row = await this.prisma.invoice.findUnique({ where: { id } });
       return row ? toDomain(row) : null;
     }
   }
   ```

4. Add the field to `TransactionalRepositories` in `src/application/shared/ports/unit-of-work.ts`:

   ```ts
   import type { InvoiceRepository } from '@/domain/invoice/invoice-repository';

   export interface TransactionalRepositories {
     userRepository: UserRepository;
     roleRepository: RoleRepository;
     permissionRepository: PermissionRepository;
     userRoleRepository: UserRoleRepository;
     emailVerificationCodeRepository: EmailVerificationCodeRepository;
     passwordResetTokenRepository: PasswordResetTokenRepository;
     invoiceRepository: InvoiceRepository;
   }
   ```

5. Construct it inside `PrismaUnitOfWork.run`, alongside the others. TypeScript will point at this spot
   as soon as step 4 lands, because the object literal is annotated `TransactionalRepositories`:

   ```ts
   const repos: TransactionalRepositories = {
     userRepository: new PrismaUserRepository({ prisma: tx }),
     roleRepository: new PrismaRoleRepository({ prisma: tx }),
     permissionRepository: new PrismaPermissionRepository({ prisma: tx }),
     userRoleRepository: new PrismaUserRoleRepository({ prisma: tx }),
     emailVerificationCodeRepository: new PrismaEmailVerificationCodeRepository({ prisma: tx }),
     passwordResetTokenRepository: new PrismaPasswordResetTokenRepository({ prisma: tx }),
     invoiceRepository: new PrismaInvoiceRepository({ prisma: tx }),
   };
   ```

6. Register the non-transactional singleton in `src/composition/persistence.ts` — add
   `invoiceRepository: InvoiceRepository;` to that module's `Cradle` slice and
   `invoiceRepository: asClass(PrismaInvoiceRepository).singleton(),` to `persistenceRegistrations`,
   next to the existing `userRepository` / `roleRepository` entries. Awilix injects the cradle as the
   single constructor argument, which is why every adapter takes one destructured object.

## Design decisions & trade-offs

- **A callback-scoped port rather than an ambient/`AsyncLocalStorage` transaction.** `run(work)` makes
  the transaction boundary a lexically visible block: you can see exactly which writes are atomic by
  reading the callback. An ambient transaction propagated through async context would let any injected
  repository silently join a transaction opened three frames up — less code at the call site, but the
  boundary becomes invisible and accidental enlistment becomes the default failure mode. The cost of the
  explicit form is the discipline in "Usage & extension": you must remember to use the _context's_
  repositories, since the injected singletons remain in scope and still compile.
- **A fixed `TransactionalRepositories` bundle rather than a generic `getRepository<T>()`.** The bundle
  is a plain interface, so a callback destructures exactly the repositories it needs and TypeScript
  checks the names; a service-locator-style lookup would push those errors to runtime. The trade-off is
  that adding an aggregate touches the port and the adapter (steps 4 and 5 above) instead of nothing —
  accepted deliberately, because the compiler then enforces that every transactional repository has a
  transaction-scoped construction.
- **Repositories are constructed per `run` call rather than reused.** Each adapter holds its client in a
  `readonly` field, so a transaction-scoped instance cannot be shared across concurrent transactions.
  Constructing six small objects per transaction is cheap next to a database round-trip, and it removes
  an entire class of cross-request leakage.
- **`PrismaTransactionalClient` as a union type instead of two class hierarchies.** Declaring the
  dependency as `PrismaClient | Prisma.TransactionClient` lets one adapter class serve both the
  container singleton and the per-transaction instance. The alternative — a base class plus a
  transactional subclass per repository — would double the adapter count to encode a distinction that is
  purely about which client object is passed in.
- **The outbox flush lives in the unit of work, not in the use case.** `run` always calls
  `outboxWriter.write(staged, tx)` after the callback, so a use case cannot forget to persist the events
  it staged, and cannot persist them on the wrong client. It also means every transaction pays one extra
  method call even with nothing staged — `PrismaOutboxWriter.write` returns immediately on an empty
  array, so no query is issued. See [domain-events.md](./domain-events.md) for what the relay does with
  those rows afterwards.
- **Reads happen before the transaction, and uniqueness is enforced by the database.** `CreateUser` and
  `RegisterUser` call `findByEmail` outside `run`, which leaves a check-then-act window where two
  concurrent registrations both see no existing user. That window is closed at the storage layer: the
  unique index on `users.email` rejects the loser, Prisma raises `P2002`, and `mapPrismaError` turns it
  into a `ConflictError`. Holding the read inside the transaction instead would lengthen every
  transaction to guard against a rare race the database already handles.
- **`RefreshTokenRepository` is intentionally not in the bundle.** `PrismaRefreshTokenRepository` takes a
  plain `PrismaClient`, because session issuance and rotation are their own consistency unit and never
  need to commit together with a user or role change — see [authentication.md](./authentication.md). Its
  absence is a statement about the aggregate boundary, not an omission. `PrismaGrantsReader` is likewise
  root-client-only: it is a read model for permission checks, with nothing to make atomic.
- **`mapPrismaError` translates only `P2002` and `P2025`.** Those are the two conditions the domain has
  a meaningful response to (a conflict and a missing record). Everything else — connection failures,
  schema drift, deadlocks — becomes a non-operational `InternalError` with the original error as
  `cause`, which is the honest answer: the application cannot recover from them, and the HTTP layer
  should surface a 500 rather than invent a client-facing meaning. Expanding the map is a one-line
  change when a new code earns domain significance.
- **Mappers are free functions, not methods on the entity or a base `Mapper` class.** `toDomain` and
  `toPersistence` are pure, individually testable, and keep the Prisma row type out of the domain
  entirely — `User` never imports from `@/generated/prisma/client`. Rehydration goes through
  `User.hydrate(...)` rather than a constructor, which is what lets the aggregate reconstruct without
  re-emitting its creation event.
- **`save` is a version-guarded insert-or-update with immutable-column handling.**
  `PrismaUserRepository.save` splits `toPersistence(user)` into `{ id, createdAt, ...mutable }` and
  writes the first two only on insert, so an update can never rewrite an entity's identity or creation
  time. An aggregate at `UNSAVED_VERSION` is inserted; otherwise `updateMany` is filtered on
  `{ id, version }` and a zero `count` raises `StaleAggregateError` (`409`). One method
  covers both insert and update, which keeps the domain interface at a single `save` verb instead of
  making callers know whether the aggregate is new.

## Testing

Unit tests use Vitest with mocked Prisma clients; integration tests drive a real database.

- **`src/infrastructure/persistence/prisma-unit-of-work.test.ts`** — the core contract, against a mock
  whose `$transaction` hands the callback a sentinel `tx` object. Covers: the callback runs inside
  `prisma.$transaction` (called exactly once) and receives a context carrying `userRepository`,
  `roleRepository`, `permissionRepository`, `userRoleRepository`, and `outbox` — the two token
  repositories in the bundle are exercised indirectly by the integration tests rather than asserted
  here — and `run` returns the callback's value; staged events are flushed to the outbox writer with
  _that same_ `tx` client; an empty array is flushed when nothing was staged; and a rejecting callback
  propagates its error while the writer is never called — the assertion that stands in for "Prisma rolls
  back and no outbox row is written".
- **`src/infrastructure/persistence/prisma-error.test.ts`** — the translation table: `P2002` →
  `ConflictError` with code `UNIQUE_VIOLATION`, `P2025` → `NotFoundError` with code `RECORD_NOT_FOUND`,
  both preserving the Prisma error as `cause`; an unrecognised Prisma code, a plain `Error`, and a
  non-`Error` value all become `InternalError`; and that `InternalError` is marked non-operational.
- **`src/infrastructure/persistence/prisma-user-repository.test.ts`** — the representative adapter:
  `list` returns mapped domain items with a total, handles the empty case, computes the right `skip` for
  page 2, and filters `deletedAt: null`; `findById` and `findByEmail` map a hit and return `null` on a
  miss, querying by `id` + `deletedAt: null` and by email string respectively; `save` inserts at
  version `1` when unsaved and otherwise guards `updateMany` on the loaded version, writes
  `id`/`createdAt` on insert but never on update, raises `StaleAggregateError` when no row matched,
  and surfaces a `P2002` as `ConflictError`.
- **`src/infrastructure/persistence/prisma-user-mapper.test.ts`** — round-tripping a `User` through
  `toPersistence` and `toDomain`. Sibling mapper tests cover the other aggregates:
  `prisma-refresh-token-mapper.test.ts` and `prisma-email-verification-code-mapper.test.ts`.
- **`src/infrastructure/persistence/prisma-outbox-writer.test.ts`** — one `createMany` row per staged
  event with correct columns, written on the transactional client, and no query at all for an empty
  batch.
- **`test/integration/outbox.int.test.ts`** — atomicity proven against a real database: creating a user
  writes exactly one unpublished outbox row, and a forced throw inside `unitOfWork.run` after
  `outbox.stage(user.pullDomainEvents())` leaves neither the user nor any outbox row committed.
- **`test/integration/sync.int.test.ts`, `test/integration/verify-email.int.test.ts`,
  `test/integration/password-reset.int.test.ts`, `test/integration/edit-user-verification.int.test.ts`**
  — the multi-repository callers exercised end-to-end through real transactions.

Run the unit tests with `npm test` (`vitest run`). Run the integration tests with
`npm run test:integration` (`vitest run -c vitest.integration.config.ts`), which requires the
integration prerequisites (a reachable database, and Redis via Testcontainers for the job-backed cases).
