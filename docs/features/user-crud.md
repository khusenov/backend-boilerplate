# User CRUD

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `46c4a07`

## Purpose

This feature owns the lifecycle of a user account: listing, reading, creating, editing, and
deleting users over HTTP. It is the reference _vertical slice_ — one feature wired through every
architectural layer end-to-end — for the whole codebase, and every other feature copies its shape,
so it deliberately exercises the full clean-architecture stack: a rich `User` domain entity with an
`Email` _value object_ (an immutable type compared by value rather than identity), use-case classes
per operation, a Prisma-backed repository behind a domain interface, permission-guarded Fastify
routes, and a domain event emitted on creation. Deletion is a **soft delete** (the row is retained
and stamped, never physically removed) so that history and foreign-key references survive.

## How it works

Every operation enters through a Fastify route under the `/users` prefix
(`src/presentation/http/routes/user-routes.ts`). An `onRequest` hook runs `app.authenticate` first,
so an unauthenticated request is rejected with `401` before any handler runs. A per-route
`preHandler` guard (`requirePermission`, or `requireSelfOrPermission` — which lets a caller act on
their own record and otherwise demands the named permission) then enforces authorization, and a Zod
schema validates the querystring / params / body, rejecting malformed input with `400`.
The handler resolves the matching use-case from the request's Awilix scope
(`request.diScope.cradle`) and calls its single `execute()` method.

The happy paths:

- **Create** (`CreateUser.execute`) builds an `Email` value object (which validates and normalizes
  the address), checks `findByEmail` for a duplicate (throwing `EmailAlreadyTakenError` → `409` if
  found), hashes the plaintext password via the `PasswordHasher` port, constructs the entity with
  `User.create(...)`. It then opens a `UnitOfWork` transaction (`this.uow.run(...)`) and, inside it,
  saves the user through the transaction-scoped `userRepository` and stages the buffered
  `UserCreatedEvent` into the outbox (`outbox.stage(newUser.pullDomainEvents())`), so the user row
  and its event commit atomically. The route returns `201` with the `UserDto`.
- **List** (`ListUsers.execute`) normalizes the pagination query (clamping `page`/`pageSize`), asks
  the repository for a page slice (which excludes soft-deleted rows), and wraps the mapped DTOs in a
  `Page<UserDto>` envelope with `total`/`hasNext`/`hasPrev` metadata. Returns `200`.
- **Get** (`GetUser.execute`) loads by id via `findById` (which returns `null` for soft-deleted
  rows), throwing `UserNotFoundError` → `404` on a miss. Returns `200`.
- **Edit** (`EditUser.execute`) loads the user (404 on miss), and for each field present in the
  input applies the corresponding domain mutator. A changed email is re-validated and checked for
  uniqueness against another account before `changeEmail` is called. Persists and returns `200`.
- **Delete** (`DeleteUser.execute`) loads the user (404 on miss), calls `user.softDelete()` — which
  also deactivates the account and stamps `deletedAt` — and persists. Returns `204`.

The decisive failure paths are: `400` for schema/`Email`/name-validation failures, `401` for a
missing or invalid access token, `403` when the caller lacks the required permission and is not
acting on their own record, `404` for an unknown (or already soft-deleted) user, and `409` for a
duplicate email. All of these are thrown as typed errors and translated to HTTP status codes by the
central error handler (`src/presentation/http/error-handler.ts`) via each error's `ErrorKind`.

On create, `User.create` records a `UserCreatedEvent` into the entity's internal event buffer. The
use case drains that buffer with `newUser.pullDomainEvents()` and stages it via the transaction
context's `OutboxStaging` (`outbox.stage(...)`) **in the same database transaction** as the user
insert, so the event row lands in the outbox exactly when — and only when — the user is persisted.
Delivery is therefore **at-least-once**: a background relay later reads the committed outbox rows and
hands each event to its subscribers (for `user.created`, `UserCreatedLogHandler` writes a structured
log line). That relay, serialization, and dispatch pipeline is a separate cross-cutting feature —
see [domain-events.md](./domain-events.md) — and this use case's only responsibility is to stage the
event inside the transaction.

## Architecture

The dependency rule points inward. The domain (`User`, `Email`, the errors, `UserCreatedEvent`, and
the `UserRepository` **interface**) depends on nothing outside `src/domain`. The application
use-cases depend only on the domain and on **ports** — `UserRepository`, `PasswordHasher`,
`IdGenerator`, and the `UnitOfWork` (whose `TransactionContext` exposes the `OutboxStaging` role
`CreateUser` uses to persist its event) — never on Prisma or Fastify. Infrastructure supplies the
**adapters** (`PrismaUserRepository`, `PrismaUnitOfWork`, `Argon2PasswordHasher`, `UuidIdGenerator`)
that implement those ports. The presentation layer adapts HTTP to
use-case calls. Concretes are bound to ports in exactly one place — the composition root
`src/container.ts`.

| Component                                                                                                      | Layer              | Responsibility                                                                                                                                            | File                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `User`                                                                                                         | Domain             | Rich aggregate: normalizes names, guards status/soft-delete invariants, records `UserCreatedEvent` on `create`                                            | `src/domain/user/user-entity.ts`                                |
| `Email`                                                                                                        | Domain             | Value object: trims, lowercases, and format-validates an address; equality by value                                                                       | `src/domain/user/email-vo.ts`                                   |
| `UserRepository`                                                                                               | Domain             | Persistence **interface** the domain owns: `list`, `findById`, `findByEmail`, `save`                                                                      | `src/domain/user/user-repository.ts`                            |
| `UserNotFoundError`, `EmailAlreadyTakenError`, `UserInvalidNameError`, `UserDeletedError`, `InvalidEmailError` | Domain             | Typed domain errors mapped to HTTP status by kind                                                                                                         | `src/domain/user/user-errors.ts`, `src/domain/user/email-vo.ts` |
| `UserCreatedEvent`                                                                                             | Domain             | Domain event carrying `aggregateId` + `email`, name `user.created`                                                                                        | `src/domain/user/events/user-created-event.ts`                  |
| `UnitOfWork` / `OutboxStaging`                                                                                 | Application (port) | Transaction boundary `CreateUser` saves within; `outbox.stage(...)` records the `UserCreatedEvent` in that same transaction (adapter: `PrismaUnitOfWork`) | `src/application/shared/ports/unit-of-work.ts`                  |
| `PasswordHasher`                                                                                               | Application (port) | Hashes the plaintext password before the entity is built (adapter: `Argon2PasswordHasher`)                                                                | `src/application/shared/ports/password-hasher.ts`               |
| `IdGenerator`                                                                                                  | Application (port) | Generates the new user's id passed to `User.create` (adapter: `UuidIdGenerator`)                                                                          | `src/application/shared/ports/id-generator.ts`                  |
| `CreateUser`                                                                                                   | Application        | Use case: validate email, dedupe, hash password, create, then save + stage `UserCreatedEvent` in one `UnitOfWork` transaction                             | `src/application/user/create-user.ts`                           |
| `ListUsers`                                                                                                    | Application        | Use case: normalize page query, fetch slice, map to a `Page<UserDto>`                                                                                     | `src/application/user/list-users.ts`                            |
| `GetUser`                                                                                                      | Application        | Use case: load by id or throw `UserNotFoundError`                                                                                                         | `src/application/user/get-user.ts`                              |
| `EditUser`                                                                                                     | Application        | Use case: partial update of name/email with re-dedupe on email change                                                                                     | `src/application/user/edit-user.ts`                             |
| `DeleteUser`                                                                                                   | Application        | Use case: soft-delete an existing user                                                                                                                    | `src/application/user/delete-user.ts`                           |
| `UserDto` / `toUserDto`                                                                                        | Application        | Outbound shape (no `passwordHash`) and the entity→DTO mapper                                                                                              | `src/application/user/user-dto.ts`                              |
| `UserCreatedLogHandler`                                                                                        | Application        | Subscriber for `user.created`; writes a structured log line                                                                                               | `src/application/user/events/user-created-log-handler.ts`       |
| `PrismaUserRepository`                                                                                         | Infrastructure     | `UserRepository` adapter over Prisma; filters `deletedAt: null` on identity reads (`findById`, `list`), upserts on save                                   | `src/infrastructure/persistence/prisma-user-repository.ts`      |
| `toDomain` / `toPersistence`                                                                                   | Infrastructure     | Maps a Prisma `User` row ↔ the `User` aggregate                                                                                                           | `src/infrastructure/persistence/prisma-user-mapper.ts`          |
| `userRoutes`                                                                                                   | Presentation       | Fastify plugin: auth hook, permission guards, Zod schemas, handlers                                                                                       | `src/presentation/http/routes/user-routes.ts`                   |
| `userResponse` / `paginatedUsers`                                                                              | Presentation       | Zod **response** schemas that serialize the DTO on the wire                                                                                               | `src/presentation/http/schemas/user-response-schema.ts`         |

## Public surface

All endpoints are mounted under the `/users` prefix (registered in
`src/presentation/http/app.ts`). Every route first requires a valid bearer access token (the
`onRequest` → `app.authenticate` hook); the **Auth** column below is the _additional_ authorization
check applied by the route's `preHandler`. A **superadmin** (holder of the `super-admin` system
role) bypasses every permission and self check.

| Method   | Path         | Auth                                  | Purpose                                                                                                                                                            |
| -------- | ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/users`     | permission `users.read`               | List users (paginated, excludes soft-deleted). Query: `page`, `pageSize` (optional, coerced ints ≥ 1). Returns `200` with a paginated envelope.                    |
| `GET`    | `/users/:id` | self **or** permission `users.read`   | Fetch one user by id. `:id` must be a UUID. Returns `200`, or `404` if unknown/deleted.                                                                            |
| `POST`   | `/users`     | permission `users.create`             | Create a user. Body: `firstName`, `lastName` (1–100 chars), `email`, `password` (8–128 chars). Returns `201` with the created user, or `409` on a duplicate email. |
| `PATCH`  | `/users/:id` | self **or** permission `users.update` | Partial update of `firstName`, `lastName`, and/or `email` (all optional). Returns `200`, `404` if unknown, or `409` if the new email is taken.                     |
| `DELETE` | `/users/:id` | permission `users.delete`             | Soft-delete a user. Returns `204`, or `404` if unknown/already deleted.                                                                                            |

> The same route file also mounts `POST /users/:id/roles` and `DELETE /users/:id/roles/:roleId`
> (permission `roles.assign`). Those belong to the **authorization** feature (`AssignRole` /
> `RevokeRole` use cases), not to User CRUD, and are documented with that feature in
> [role-based-authorization.md](./role-based-authorization.md).

The **response contract** every single-user read/write endpoint returns (except `DELETE`, which
sends no body) is the `UserDto`; the list endpoint wraps it in a `Page<UserDto>` envelope. The DTO
is serialized by the `userResponse` Zod schema — note it never includes `passwordHash`:

```ts
export interface UserDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  status: UserStatusType; // 'active' | 'inactive'
  createdAt: Date; // serialized to an ISO-8601 string on the wire
  updatedAt: Date;
}
```

The `GET /users` list envelope is `Page<UserDto>`:

```ts
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
}
```

## Configuration

This feature defines **no environment variables of its own**. It relies transitively on
infrastructure and framework configuration parsed in `src/config/env.ts` (and mirrored in
`.env.example`). The keys that materially affect a `/users` request are:

| Variable            | Default                | Meaning                                                                                                      |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`      | (required, no default) | Connection string for the Prisma client that `PrismaUserRepository` reads and writes.                        |
| `JWT_ACCESS_SECRET` | (required, no default) | Secret used to verify the bearer access token that the `authenticate` hook requires on every `/users` route. |
| `JWT_ISSUER`        | `finflow`              | Expected `iss` claim on the access token.                                                                    |
| `JWT_AUDIENCE`      | `finflow-api`          | Expected `aud` claim on the access token.                                                                    |
| `RATE_LIMIT_MAX`    | `100`                  | Max requests per window applied to the API (including `/users`) by the global rate-limit plugin.             |
| `RATE_LIMIT_WINDOW` | `1 minute`             | Rate-limit window length.                                                                                    |

## Usage & extension

### Calling an endpoint

Obtain an access token via the auth feature, then call an endpoint with a bearer header:

```bash
# Create a user (caller must hold users.create, or be superadmin)
curl -X POST http://localhost:8000/users \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"John","lastName":"Doe","email":"john@finflow.test","password":"password123"}'
```

### Adding a new user operation (e.g. "deactivate user")

The pattern is identical for every use case; follow these steps.

1. **Add the behaviour to the domain** if it is a new invariant. `User` already exposes
   `deactivate()`; a new rule would be a method on `src/domain/user/user-entity.ts` that guards its
   own invariants and calls `this.touch()` when it mutates state.

2. **Write the use-case class** in `src/application/user/`. Depend only on ports via constructor DI,
   and expose a single `execute()`:

   ```ts
   // src/application/user/deactivate-user.ts
   import type { UserRepository } from '@/domain/user/user-repository';
   import { UserNotFoundError } from '@/domain/user/user-errors';
   import { toUserDto, type UserDto } from '@/application/user/user-dto';

   export interface DeactivateUserInput {
     id: string;
   }
   export type DeactivateUserOutput = UserDto;

   interface DeactivateUserDeps {
     userRepository: UserRepository;
   }

   export class DeactivateUser {
     private readonly users: UserRepository;

     constructor({ userRepository }: DeactivateUserDeps) {
       this.users = userRepository;
     }

     async execute(input: DeactivateUserInput): Promise<DeactivateUserOutput> {
       const user = await this.users.findById(input.id);
       if (!user) throw new UserNotFoundError(input.id);
       user.deactivate();
       await this.users.save(user);
       return toUserDto(user);
     }
   }
   ```

3. **Register it in the composition root** `src/container.ts`. Add the type to the `Cradle`
   interface and bind it under the "use cases" block:

   ```ts
   // in the Cradle interface
   deactivateUser: DeactivateUser;

   // in registerDependencies(...)'s container.register({ ... })
   deactivateUser: asClass(DeactivateUser).singleton(),
   ```

   Awilix injects `userRepository` (and any other cradle key) by matching the constructor
   destructuring names, so no manual wiring of dependencies is needed.

4. **Expose it over HTTP** in `src/presentation/http/routes/user-routes.ts`: declare Zod schemas for
   the params/body, pick a guard, resolve the use case from `request.diScope.cradle`, and call
   `execute()`:

   ```ts
   const deactivateParams = getUserParams; // { id: z.uuid() }

   app.post(
     '/:id/deactivate',
     {
       preHandler: requirePermission('users.update'),
       schema: { params: deactivateParams, response: { 200: userResponse, 404: errorResponse } },
     },
     async (request, reply) => {
       const { deactivateUser } = request.diScope.cradle;
       const user = await deactivateUser.execute({ id: request.params.id });
       return reply.status(200).send(user);
     },
   );
   ```

If the operation needs a _new_ permission, add it to `PERMISSIONS` in
`src/domain/authorization/permission-catalogue.ts` first so `requirePermission(...)` stays type-safe
against `PermissionKey`.

### Subscribing to `user.created`

To react when a user is created (e.g. send a welcome email), implement `DomainEventHandler`,
register it in `src/container.ts`, and add it to the `domainEventHandlers` array — the list the
`DomainEventHandlerRegistry` (which the dispatch job handler resolves handlers from) is built from.
The existing
`UserCreatedLogHandler` (`src/application/user/events/user-created-log-handler.ts`) is the reference
implementation. Because the event is delivered asynchronously through the outbox, a new event type
also needs a deserialization factory, and its handler must be **idempotent** (at-least-once delivery
can invoke it more than once for the same event). The full recipe — event → factory → handler →
registration — lives in [domain-events.md](./domain-events.md).

## Design decisions & trade-offs

- **Rich domain entity over an anemic record.** `User` enforces its own invariants — names are
  trimmed and rejected when blank, status transitions and edits are refused on a deleted user, and
  `touch()` bumps `updatedAt` only on real changes. Concentrating these rules in the entity keeps
  the use cases thin and prevents an invalid `User` from ever existing in memory. The cost is more
  ceremony (private constructor, `create` vs `hydrate` factories, getters over `props`) than a plain
  interface would need.
- **`Email` value object rather than a bare `string`.** Modelling the address as a type makes
  validation and normalization (trim + lowercase) unavoidable and centralized: a `User` can only
  hold a well-formed email, and equality is value-based, so `ADA@example.com` and `ada@example.com`
  compare equal — which is exactly what the "email unchanged" fast-path in `EditUser` relies on. The
  trade-off is an extra unwrap (`email.toString()`) at persistence and DTO boundaries.
- **Two factory methods: `create` vs `hydrate`.** `User.create` is the only path that stamps
  timestamps, sets `status = active`, and records `UserCreatedEvent`; `User.hydrate` reconstructs an
  existing user from a stored row and records **nothing**. Splitting them prevents rehydration from
  re-emitting a "created" event or resetting audit fields — a subtle bug that a single constructor
  would invite.
- **Mapper split from the repository.** `toDomain` / `toPersistence`
  (`prisma-user-mapper.ts`) are pure functions kept separate from `PrismaUserRepository`. The
  repository owns _querying_ (the `deletedAt: null` filter, the pagination `$transaction`, the
  upsert) while the mapper owns the _field-by-field translation_ between the persistence row and the
  aggregate. This keeps each side single-responsibility and lets the mapping be reasoned about (and
  reused) without a database.
- **Domain event recorded in the entity, staged into a transactional outbox by the use case.**
  `User.create` buffers the event; `CreateUser` drains it with `pullDomainEvents()` and stages it via
  `outbox.stage(...)` **inside the same `UnitOfWork` transaction** as the user insert, so
  `PrismaUnitOfWork` writes the event row and the user row in one commit. Either both land or neither
  does — no "user created" signal escapes for a user that failed to persist, and no user is persisted
  without its event. Delivery is **at-least-once**: a background relay reads the committed outbox rows
  and dispatches them to subscribers, retrying until each is delivered, so a handler may observe the
  same event more than once and must be idempotent. The trade-off against the previous
  save-then-dispatch-in-process design is eventual consistency — a subscriber runs a short while
  after the request rather than synchronously within it — bought in exchange for never losing an event
  to a crash between save and dispatch. The relay, serialization, and dispatch machinery is documented
  in [domain-events.md](./domain-events.md).
- **Soft delete instead of a hard `DELETE`.** `DeleteUser` calls `user.softDelete()`, which stamps
  `deletedAt` and deactivates the account rather than removing the row. The identity reads
  `findById` and `list` filter `deletedAt: null`, so a deleted user disappears from the API while
  its record — and any foreign-key references to it — survive for audit and integrity. `findByEmail`
  deliberately does **not** filter soft-deleted rows: it queries the unique `email` column directly,
  so a soft-deleted account's email still counts as taken and blocks re-registration under the same
  address (the create/edit uniqueness checks depend on this). The cost is that `deletedAt: null`
  must be threaded through the identity reads, and a "resurrect" path (`User.restore`) has to exist
  for completeness.
- **`save` as an upsert with immutable `id`/`createdAt`.** `PrismaUserRepository.save` destructures
  `id` and `createdAt` out of the mutable set and upserts: it inserts them on create and never
  writes them on update. One method covers both create and edit, and identity/creation time cannot
  be mutated by an edit. Prisma unique-constraint failures (`P2002`) are translated to a
  `ConflictError` by `mapPrismaError`, giving the same `409` as the application-level duplicate
  check that guards the common case.
- **Response Zod schema as an output contract.** `userResponse` re-declares the shape the endpoint
  returns and is used as the Fastify serializer. It guarantees no accidental field leak (notably
  `passwordHash`) regardless of what the DTO grows to hold, and it feeds the generated OpenAPI docs.
- **Authorization split: `requirePermission` vs `requireSelfOrPermission`.** Reads and edits of a
  _single_ user (`GET`/`PATCH /users/:id`) use `requireSelfOrPermission`, so a user can view and
  edit their own record without holding an admin permission, while acting on _another_ user requires
  the permission. Collection and destructive operations (`GET`/`POST /users`, `DELETE /users/:id`)
  require the permission outright. Superadmins short-circuit both checks.

## Testing

Tests live alongside the code (unit) and under `test/integration` (integration). The two run under
separate Vitest configs — the default config excludes `test/**` and `**/*.int.test.ts`, so
integration tests have their own command:

```bash
npm test                          # unit tests only (vitest run)
npm test -- user                  # narrow the unit run to files matching "user"
npm run test:integration          # the /users HTTP integration test (needs a database)
```

**Domain unit tests**

- `src/domain/user/user-entity.test.ts` — name normalization, `create` vs `hydrate` (only `create`
  records `UserCreatedEvent`; `pullDomainEvents` has pull-once semantics), `activate`/`deactivate`
  no-op and deleted-user guards, `changeFirstName`/`changeLastName`/`changeEmail` (including the
  value-equality no-op), `softDelete`/`restore`, and `equals`.
- `src/domain/user/email-vo.test.ts` — trimming/lowercasing, format validation
  (`InvalidEmailError`), and value equality.
- `src/domain/user/user-errors.test.ts` — the error types and their codes/kinds.

**Application unit tests** (each uses in-memory port fakes, no database)

- `src/application/user/create-user.test.ts` — malformed email, duplicate email (no transaction is
  opened), password hashing, id generation, that the user is saved through the unit of work exactly
  once, DTO mapping, and that exactly one `UserCreatedEvent` is **staged inside the transaction**
  with `save` preceding `stage` — all driven through a fake `UnitOfWork`.
- `src/application/user/edit-user.test.ts` — not-found, invalid email, duplicate email on change,
  the "email unchanged → skip the uniqueness lookup" path, per-field updates, persistence, and DTO
  mapping.
- `src/application/user/get-user.test.ts`, `.../list-users.test.ts`, `.../delete-user.test.ts` —
  the read, list-pagination, and soft-delete happy/`404` paths.
- `src/application/user/events/user-created-log-handler.test.ts` — the handler logs the expected
  structured fields for a `UserCreatedEvent`.

**Infrastructure unit tests** (drive the adapters against a mocked Prisma client, no database)

- `src/infrastructure/persistence/prisma-user-repository.test.ts` — `list` maps rows to domain
  items with a `total`, computes the right `skip`/`take` for a later page, runs the slice and count
  through `$transaction`, and constrains every query to `where: { deletedAt: null }`; `findById`
  returns a mapped `User` or `null` and always queries `{ id, deletedAt: null }`; `findByEmail`
  maps-or-returns-`null` and queries the unique `email` column **without** a `deletedAt` filter (so a
  soft-deleted account's email still reads as taken); `save` upserts keyed on `id`, writes the
  immutable `id`/`createdAt` only on the `create` branch (never on `update`), and translates a
  Prisma `P2002` unique-constraint violation into `ConflictError`.
- `src/infrastructure/persistence/prisma-user-mapper.test.ts` — `toDomain` maps every scalar column
  (including `null` and non-null `deletedAt`, and the `inactive` status), `toPersistence` serializes
  the `Email` value object back to a plain string, and the pair round-trips losslessly
  (`toPersistence(toDomain(row))` deep-equals the original row, with and without a `deletedAt`).

**Presentation unit tests**

- `src/presentation/http/schemas/user-response-schema.test.ts` — `userResponse` accepts a valid
  `UserDto`, **strips `passwordHash`** (and any field outside the contract) from the serialized
  output, and rejects an unknown `status`; `paginatedUsers` wraps items in the standard pagination
  envelope and strips secrets from each item.

**Integration test** — `test/integration/users.int.test.ts` drives the real Fastify app against a
real database via `app.inject`, covering the full HTTP contract:

- `POST /users`: `201` + persistence, that a `UserCreatedEvent` is **staged as an unpublished outbox
  row rather than dispatched synchronously** (the in-process handler is not invoked during the
  request), `401` unauthenticated, `409` duplicate email, `400` invalid input. The full
  create → relay → worker → handler round-trip is proved separately in
  `test/integration/outbox.int.test.ts` (see [domain-events.md](./domain-events.md)).
- `GET /users`: pagination metadata, `page`/`pageSize` honoring, `401` unauthenticated.
- `GET /users/:id`: `200`, `404` unknown, `400` malformed id, `401`, and the exact public field set
  (no `passwordHash`; `createdAt` serialized to an ISO string).
- `PATCH /users/:id`: partial update, email change, `409` duplicate, `404`, `400`, `401`.
- `DELETE /users/:id`: `204` + soft-delete (row retained, `deletedAt` set, hidden from later reads),
  exclusion from the list, `404` unknown, `404` on double-delete, `401`.
- Authorization: a role-less user is `403` (`FORBIDDEN`) on list; a `users.read` holder can list but
  not create (`403`); a user can read and edit their **own** record without any permission; reading
  another user without permission is `403`.
