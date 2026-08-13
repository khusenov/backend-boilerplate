# User CRUD

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `9044a23`

## Purpose

This feature owns the lifecycle of a user account — listing, reading, creating, editing, and
deleting users over HTTP. It is the reference _vertical slice_ of the codebase: one feature wired
through every architectural layer end-to-end, which every other feature copies in shape. It
therefore deliberately exercises the full clean-architecture stack — a rich `User` domain entity
with an `Email` _value object_ (an immutable type compared by value, not identity), one use-case
class per operation, a Prisma-backed repository behind a domain interface, permission-guarded
Fastify routes, and a domain event emitted on creation and committed transactionally with the user
row. Deletion is a **soft delete** (the row is retained and stamped, never physically removed) so
that history and foreign-key references survive.

## How it works

Every operation enters through a Fastify route mounted under the `/users` prefix
(`src/presentation/http/routes/user-routes.ts`). The plugin registers an `onRequest` hook that runs
`app.authenticate` first, so a request without a valid bearer access token is rejected with `401`
before any handler runs (the hook populates `request.user` with the caller's `sub`, `permissions`,
and `systemRoleKeys`). A per-route `preHandler` guard then enforces authorization, and the route's
Zod schema validates the querystring / params / body, rejecting malformed input with `400`. The
handler resolves the matching use-case from the request's Awilix scope (`request.diScope.cradle`)
and calls its single `execute()` method.

The route maps `request.user` to a domain `Actor` with `toRequestActor`
(`src/presentation/http/identity/actor-from-token-payload.ts`) and passes it as the last argument of
`execute`. Each use case then calls one of two policy functions from
`src/domain/authorization/access-policy.ts` as its first statement:

- `ensurePermission(actor, key)` — demands the named `PermissionKey`.
- `ensureSelfOrPermission(actor, targetUserId, key)` — allows a caller acting on their **own** record
  (`actor.userId === targetUserId`) and otherwise demands the permission.

Both short-circuit for a **superadmin** — a caller whose `systemRoleKeys` include
`SUPERADMIN_ROLE_KEY` (`'super-admin'`) — who bypasses every permission and self check. A failed
check throws `PermissionDeniedError` → `403`.

The happy paths:

- **Create** (`CreateUser.execute`) builds an `Email` value object (validating and normalizing the
  address), checks `findByEmail` for a duplicate (throwing `EmailAlreadyTakenError` → `409` if
  found), hashes the plaintext password through the `PasswordHasher` port, and constructs the entity
  with `User.create(params, this.clock.now())` — a single reading of the `Clock` port that stamps
  `createdAt`, `updatedAt`, and the recorded event's `occurredAt` with the same instant. It then opens
  a `UnitOfWork` transaction — `this.uow.run(...)` — and,
  inside it, saves the user through the **transaction-scoped** `userRepository` and stages the
  entity's buffered domain events into the transaction's `outbox`:

  ```ts
  await this.uow.run(async ({ userRepository, outbox }) => {
    await userRepository.save(newUser);
    outbox.stage(newUser.pullDomainEvents());
  });
  ```

  So the user row and its `UserCreatedEvent` commit atomically. The route returns `201` with the
  `UserDto`.

- **List** (`ListUsers.execute`) normalizes the pagination query (defaulting and clamping
  `page`/`pageSize`), asks the repository for a page slice (which excludes soft-deleted rows), and
  wraps the mapped DTOs in a `Page<UserDto>` envelope carrying `total`/`hasNext`/`hasPrev`. Returns
  `200`.
- **Get** (`GetUser.execute`) loads by id via `findById` (which returns `null` for soft-deleted
  rows), throwing `UserNotFoundError` → `404` on a miss. Returns `200`.
- **Edit** (`EditUser.execute`) loads the user (404 on miss). When `email` is present it re-validates
  and, only if the value actually changed, checks uniqueness against another account before calling
  `changeEmail(email, now)`; `firstName`/`lastName` are applied through their domain mutators
  (`changeFirstName(raw, now)` / `changeLastName(raw, now)`) when present. All of them share one `now`
  hoisted from a single `clock.now()` reading, so a request that changes several fields records one
  `updatedAt`. Persists via `save` and returns `200`.
- **Delete** (`DeleteUser.execute`) loads the user (404 on miss), calls
  `user.softDelete(this.clock.now())` — which also deactivates the account and stamps `deletedAt` with
  that same instant — and persists. Returns `204`.

The decisive failure paths are `400` for schema / `Email` / name-validation failures, `401` for a
missing or invalid access token, `403` when the caller lacks the required permission and is not
acting on their own record, `404` for an unknown (or already soft-deleted) user, and `409` for a
duplicate email. Each is thrown as a typed error and translated to an HTTP status by the central
error handler (`src/presentation/http/error-handler.ts`) via the error's `ErrorKind`.

**The domain event, committed transactionally.** `User.create` records a `UserCreatedEvent` (name
`user.created`, carrying the new user's id as `aggregateId` and its email) into the entity's internal
event buffer. `CreateUser` drains that buffer with `newUser.pullDomainEvents()` and stages it via the
transaction context's `OutboxStaging` (`outbox.stage(...)`) **inside the same database transaction**
as the user insert, so the event row lands in the outbox exactly when — and only when — the user is
persisted. Delivery is therefore **at-least-once and asynchronous**: a background relay later reads
the committed outbox rows and hands each event to its subscribers (for `user.created`,
`UserCreatedLogHandler` writes a structured log line). The event is **not** dispatched synchronously
within the request. That relay, serialization, and dispatch pipeline is a separate cross-cutting
feature — see [domain-events.md](./domain-events.md) — and this use case's only responsibility is to
stage the event inside the transaction.

## Architecture

The dependency rule points inward. The domain (`User`, `Email`, the domain errors,
`UserCreatedEvent`, and the `UserRepository` **interface**) depends on nothing outside `src/domain`.
The application use-cases depend only on the domain and on **ports** — `UserRepository`,
`PasswordHasher`, `IdGenerator`, `Clock`, and `UnitOfWork` (whose `TransactionContext` exposes both the
transaction-scoped repositories and the `OutboxStaging` role `CreateUser` stages its event through) —
never on Prisma or Fastify. The domain takes time as a plain `Date` parameter and depends on no clock
at all. Infrastructure supplies the **adapters** (`PrismaUserRepository`,
`PrismaUnitOfWork`, `Argon2PasswordHasher`, `UuidIdGenerator`, `SystemClock`) that implement those
ports. The
presentation layer adapts HTTP to use-case calls. Concretes are bound to ports in exactly one place —
the composition root `src/container.ts`.

| Component                                                                                                      | Layer              | Responsibility                                                                                                                                            | File                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `User`                                                                                                         | Domain             | Rich aggregate: normalizes names, guards status / soft-delete invariants, records `UserCreatedEvent` on `create`                                          | `src/domain/user/user-entity.ts`                                |
| `Email`                                                                                                        | Domain             | Value object: trims, lowercases, and format-validates an address; equality by value                                                                       | `src/domain/user/email-vo.ts`                                   |
| `UserRepository`                                                                                               | Domain             | Persistence **interface** the domain owns: `list`, `findById`, `findByEmail`, `save`                                                                      | `src/domain/user/user-repository.ts`                            |
| `UserNotFoundError`, `EmailAlreadyTakenError`, `UserInvalidNameError`, `UserDeletedError`, `InvalidEmailError` | Domain             | Typed domain errors mapped to HTTP status by `ErrorKind`                                                                                                  | `src/domain/user/user-errors.ts`, `src/domain/user/email-vo.ts` |
| `UserCreatedEvent`                                                                                             | Domain             | Domain event carrying `aggregateId` + `email`, name `user.created`                                                                                        | `src/domain/user/events/user-created-event.ts`                  |
| `UnitOfWork` / `OutboxStaging`                                                                                 | Application (port) | Transaction boundary `CreateUser` saves within; `outbox.stage(...)` records the `UserCreatedEvent` in that same transaction (adapter: `PrismaUnitOfWork`) | `src/application/shared/ports/unit-of-work.ts`                  |
| `PasswordHasher`                                                                                               | Application (port) | Hashes the plaintext password before the entity is built (adapter: `Argon2PasswordHasher`)                                                                | `src/application/shared/ports/password-hasher.ts`               |
| `IdGenerator`                                                                                                  | Application (port) | Generates the new user's id passed to `User.create` (adapter: `UuidIdGenerator`)                                                                          | `src/application/shared/ports/id-generator.ts`                  |
| `Clock`                                                                                                        | Application (port) | `now(): Date` — read once per operation and threaded into `User.create` and every mutator (adapter: `SystemClock`)                                        | `src/application/shared/ports/clock.ts`                         |
| `CreateUser`                                                                                                   | Application        | Validate email, dedupe, hash password, create, then save + stage `UserCreatedEvent` in one `UnitOfWork` transaction                                       | `src/application/user/create-user.ts`                           |
| `ListUsers`                                                                                                    | Application        | Normalize the page query, fetch the slice, map to a `Page<UserDto>`                                                                                       | `src/application/user/list-users.ts`                            |
| `GetUser`                                                                                                      | Application        | Load by id or throw `UserNotFoundError`                                                                                                                   | `src/application/user/get-user.ts`                              |
| `EditUser`                                                                                                     | Application        | Partial update of name/email with re-dedupe on an email change                                                                                            | `src/application/user/edit-user.ts`                             |
| `DeleteUser`                                                                                                   | Application        | Soft-delete an existing user                                                                                                                              | `src/application/user/delete-user.ts`                           |
| `UserDto` / `toUserDto`                                                                                        | Application        | Outbound shape (no `passwordHash`) and the entity→DTO mapper                                                                                              | `src/application/user/user-dto.ts`                              |
| `PrismaUserRepository`                                                                                         | Infrastructure     | `UserRepository` adapter over Prisma; filters `deletedAt: null` on identity reads (`findById`, `list`), upserts on `save`                                 | `src/infrastructure/persistence/prisma-user-repository.ts`      |
| `toDomain` / `toPersistence`                                                                                   | Infrastructure     | Maps a Prisma `User` row ↔ the `User` aggregate                                                                                                           | `src/infrastructure/persistence/prisma-user-mapper.ts`          |
| `userRoutes`                                                                                                   | Presentation       | Fastify plugin: auth hook, actor mapping, Zod schemas, handlers                                                                                           | `src/presentation/http/routes/user-routes.ts`                   |
| `userResponse` / `paginatedUsers`                                                                              | Presentation       | Zod **response** schemas that serialize the DTO on the wire                                                                                               | `src/presentation/http/schemas/user-response-schema.ts`         |

## Public surface

All endpoints are mounted under the `/users` prefix (registered in `src/presentation/http/app.ts`
with `app.register(userRoutes, { prefix: '/users' })`). Every route first requires a valid bearer
access token (the `onRequest` → `app.authenticate` hook); the **Auth** column below is the
_additional_ authorization check applied by the route's `preHandler`. A **superadmin** (holder of the
`super-admin` system role) bypasses every permission and self check.

| Method   | Path         | Auth                                  | Purpose                                                                                                                                                            |
| -------- | ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/users`     | permission `users.read`               | List users (paginated, excludes soft-deleted). Query: `page`, `pageSize` — optional, coerced ints ≥ 1. Returns `200` with a paginated envelope.                    |
| `GET`    | `/users/:id` | self **or** permission `users.read`   | Fetch one user by id. `:id` must be a UUID. Returns `200`, or `404` if unknown/deleted.                                                                            |
| `POST`   | `/users`     | permission `users.create`             | Create a user. Body: `firstName`, `lastName` (1–100 chars), `email`, `password` (8–128 chars). Returns `201` with the created user, or `409` on a duplicate email. |
| `PATCH`  | `/users/:id` | self **or** permission `users.update` | Partial update of `firstName`, `lastName`, and/or `email` (all optional, non-empty). Returns `200`, `404` if unknown, or `409` if the new email is taken.          |
| `DELETE` | `/users/:id` | permission `users.delete`             | Soft-delete a user. Returns `204`, or `404` if unknown/already deleted.                                                                                            |

> The same route file also mounts `POST /users/:id/roles` and `DELETE /users/:id/roles/:roleId`
> (both permission `roles.assign`). Those belong to the **authorization** feature (`AssignRole` /
> `RevokeRole` use cases), not to User CRUD, and are documented in
> [role-based-authorization.md](./role-based-authorization.md).

The **response contract** every single-user read/write endpoint returns (except `DELETE`, which
sends no body) is the `UserDto`; the list endpoint wraps it in a `Page<UserDto>` envelope. The DTO is
serialized by the `userResponse` Zod schema, which never includes `passwordHash`:

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

This feature defines **no environment variables of its own**. It relies transitively on the
infrastructure and framework configuration parsed in `src/config/env.ts` (and mirrored in
`.env.example`). The keys that materially affect a `/users` request:

| Variable            | Default                | Meaning                                                                                                           |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | (required, no default) | Connection string for the Prisma client that `PrismaUserRepository` reads and writes.                             |
| `JWT_ACCESS_SECRET` | (required, no default) | HMAC signing key used to verify the bearer access token the `authenticate` hook requires on every `/users` route. |
| `JWT_ISSUER`        | `finflow`              | Expected `iss` claim on the access token.                                                                         |
| `JWT_AUDIENCE`      | `finflow-api`          | Expected `aud` claim on the access token.                                                                         |
| `RATE_LIMIT_MAX`    | `100`                  | Max requests per window the global rate-limit plugin applies to the API (including `/users`).                     |
| `RATE_LIMIT_WINDOW` | `1 minute`             | Rate-limit window length.                                                                                         |

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
   `deactivate(now)`; a new rule would be a method on `src/domain/user/user-entity.ts` that takes
   `now: Date` as its last parameter, guards its own invariants, and calls `this.touch(now)` when it
   mutates state. Entities never read a clock — they receive the instant.

2. **Write the use-case class** in `src/application/user/`. Depend only on ports via constructor DI,
   and expose a single `execute()`:

   ```ts
   // src/application/user/deactivate-user.ts
   import type { UserRepository } from '@/domain/user/user-repository';
   import type { Clock } from '@/application/shared/ports/clock';
   import { UserNotFoundError } from '@/domain/user/user-errors';
   import { toUserDto, type UserDto } from '@/application/user/user-dto';

   export interface DeactivateUserInput {
     id: string;
   }
   export type DeactivateUserOutput = UserDto;

   interface DeactivateUserDeps {
     userRepository: UserRepository;
     clock: Clock;
   }

   export class DeactivateUser {
     private readonly users: UserRepository;
     private readonly clock: Clock;

     constructor({ userRepository, clock }: DeactivateUserDeps) {
       this.users = userRepository;
       this.clock = clock;
     }

     async execute(input: DeactivateUserInput): Promise<DeactivateUserOutput> {
       const user = await this.users.findById(input.id);
       if (!user) throw new UserNotFoundError(input.id);
       user.deactivate(this.clock.now());
       await this.users.save(user);
       return toUserDto(user);
     }
   }
   ```

3. **Register it in the composition root** `src/container.ts`. Add the type to the `Cradle` interface
   and bind it alongside the other user use cases (near lines 257–261):

   ```ts
   // in the Cradle interface
   deactivateUser: DeactivateUser;

   // in registerDependencies(...)'s container.register({ ... })
   deactivateUser: asClass(DeactivateUser).singleton(),
   ```

   Awilix injects `userRepository` (and any other cradle key) by matching the constructor
   destructuring names, so no manual dependency wiring is needed.

4. **Expose it over HTTP** in `src/presentation/http/routes/user-routes.ts`: declare Zod schemas for
   the params/body, pick a guard, resolve the use case from `request.diScope.cradle`, and call
   `execute()`:

   ```ts
   const deactivateParams = getUserParams; // { id: z.uuid() }

   app.post(
     '/:id/deactivate',
     {
       schema: { params: deactivateParams, response: { 200: userResponse, 404: errorResponse } },
     },
     async (request, reply) => {
       const { deactivateUser } = request.diScope.cradle;
       const user = await deactivateUser.execute(
         { id: request.params.id },
         toRequestActor(request.user),
       );
       return reply.status(200).send(user);
     },
   );
   ```

   The permission check itself belongs in the use case, as the first statement of `execute`:
   `ensurePermission(actor, PERMISSIONS.UsersUpdate.key);`

If the operation needs a _new_ permission, add it to `PERMISSIONS` in
`src/domain/authorization/permission-catalogue.ts` first so `ensurePermission(...)` stays type-safe
against `PermissionKey`. Add the route→permission row to `ROUTE_PERMISSIONS` in
`test/integration/authorization-enforcement.int.test.ts` as well — that suite enumerates the app's own
routes and fails on any it cannot account for.

### Subscribing to `user.created`

To react when a user is created (e.g. send a welcome email), implement a domain-event handler,
register it in `src/container.ts`, and add it to the `domainEventHandlers` array — the list the
`DomainEventHandlerRegistry` is built from. The existing `UserCreatedLogHandler`
(`src/application/user/events/user-created-log-handler.ts`) is the reference implementation. Because
the event is delivered asynchronously through the outbox, a new event type also needs a
deserialization factory, and its handler must be **idempotent** (at-least-once delivery can invoke it
more than once for the same event). The full recipe — event → factory → handler → registration —
lives in [domain-events.md](./domain-events.md).

## Design decisions & trade-offs

- **Rich domain entity over an anemic record.** `User` enforces its own invariants — names are
  trimmed and rejected when blank, status transitions and edits are refused on a deleted user, and
  `touch()` bumps `updatedAt` only on a real change. Concentrating these rules in the entity keeps
  the use cases thin and prevents an invalid `User` from ever existing in memory. The cost is more
  ceremony (private constructor, `create` vs `hydrate` factories, getters over `props`) than a plain
  interface would need.
- **`Email` value object rather than a bare `string`.** Modelling the address as a type makes
  validation and normalization (trim + lowercase) unavoidable and centralized: a `User` can only hold
  a well-formed email, and equality is by value, so `ADA@example.com` and `ada@example.com` compare
  equal — which is exactly what the "email unchanged" fast-path in `EditUser` (and `User.changeEmail`)
  relies on to skip a needless uniqueness lookup. The trade-off is an extra unwrap
  (`email.toString()`) at the persistence and DTO boundaries.
- **Two factory methods: `create` vs `hydrate`.** `User.create(params, now)` is the only path that
  stamps timestamps, sets `status = active`, and records `UserCreatedEvent`; `User.hydrate(props)`
  reconstructs an existing user from a stored row and records **nothing**. Splitting them prevents
  rehydration from re-emitting a "created" event or resetting audit fields — a subtle bug that a single
  constructor would invite. The signatures encode the split: `create` always takes `now`, `hydrate`
  never does, because every timestamp on a hydrated entity already comes from the database row.
- **Domain event recorded in the entity, staged into a transactional outbox by the use case.**
  `User.create` buffers the event; `CreateUser` drains it with `pullDomainEvents()` and stages it via
  `outbox.stage(...)` **inside the same `UnitOfWork` transaction** as the user insert, so
  `PrismaUnitOfWork` writes the event row and the user row in one commit. Either both land or neither
  does — no "user created" signal escapes for a user that failed to persist, and no user persists
  without its event. Delivery is then **at-least-once**: a background relay reads the committed outbox
  rows and dispatches them to subscribers, retrying until each is delivered, so a handler may observe
  the same event more than once and must be idempotent. The trade-off against a
  save-then-dispatch-in-process design is eventual consistency — a subscriber runs a short while after
  the request rather than synchronously within it — bought in exchange for never losing an event to a
  crash between save and dispatch. The relay, serialization, and dispatch machinery is documented in
  [domain-events.md](./domain-events.md).
- **Save-and-stage inside `uow.run`, dedupe check outside it.** `CreateUser` runs `findByEmail`
  (through its injected `userRepository`) _before_ opening the transaction, and does the `save` +
  `stage` through the **transaction-scoped** `userRepository`/`outbox` handed to the `run` callback.
  The pre-check keeps the common duplicate case cheap (no transaction, no argon2 hash), while the
  in-transaction write plus the database's unique `email` constraint (surfaced as `409`, see below)
  closes the race the pre-check alone cannot.
- **Mapper split from the repository.** `toDomain` / `toPersistence` (`prisma-user-mapper.ts`) are
  pure functions kept separate from `PrismaUserRepository`. The repository owns _querying_ (the
  `deletedAt: null` filter, the pagination `$transaction`, the upsert) while the mapper owns the
  _field-by-field translation_ between the persistence row and the aggregate. This keeps each side
  single-responsibility and lets the mapping be reasoned about (and reused) without a database.
- **Soft delete instead of a hard `DELETE`.** `DeleteUser` calls `user.softDelete(this.clock.now())`,
  which stamps `deletedAt` and deactivates the account rather than removing the row. The identity reads `findById`
  and `list` filter `deletedAt: null`, so a deleted user disappears from the API while its record —
  and any foreign-key references to it — survive for audit and integrity. `findByEmail` deliberately
  does **not** filter soft-deleted rows: it queries the unique `email` column directly, so a
  soft-deleted account's email still counts as taken and blocks re-registration under the same address
  (the create/edit uniqueness checks depend on this). The cost is that `deletedAt: null` must be
  threaded through the identity reads, and a "resurrect" path (`User.restore(now)`) has to exist for
  completeness.
- **Deleted-user guards are defence in depth, not a reachable HTTP path.** `changeEmail`,
  `changeFirstName`, `deactivate`, etc. throw `UserDeletedError` (a `409`) when the user is deleted,
  but because `findById` excludes soft-deleted rows, the edit/delete/get use cases never load one —
  they get `null` and return `404` first. The entity guard protects any _future_ caller that obtains a
  deleted aggregate by another route, without weakening the current API's `404` behaviour.
- **`save` as an upsert with immutable `id`/`createdAt`.** `PrismaUserRepository.save` destructures
  `id` and `createdAt` out of the mutable set and upserts: it writes them only on the `create` branch,
  never on `update`. One method covers both create and edit, and identity/creation time cannot be
  mutated by an edit. A Prisma unique-constraint failure (`P2002`) is translated to a `ConflictError`
  by `mapPrismaError`, yielding the same `409` as the application-level duplicate check that guards
  the common case.
- **Response Zod schema as an output contract.** `userResponse` re-declares the shape the endpoint
  returns and is used as the Fastify serializer. It guarantees no accidental field leak (notably
  `passwordHash`) regardless of what the DTO grows to hold, and it feeds the generated OpenAPI docs.
- **Authorization split: `ensurePermission` vs `ensureSelfOrPermission`.** Reads and edits of a
  _single_ user (`GET`/`PATCH /users/:id`) use `ensureSelfOrPermission`, so a user can view and edit
  their own record without holding an admin permission, while acting on _another_ user requires the
  permission. Collection and destructive operations (`GET`/`POST /users`, `DELETE /users/:id`) require
  the permission outright. Superadmins short-circuit both checks.

- **The trusted route parameter goes last in the input spread.** `PATCH /users/:id` builds its input
  as `{ ...request.body, id: request.params.id }`, not the reverse. Because `ensureSelfOrPermission`
  reads `input.id`, a body key named `id` placed after the route parameter would be an IDOR — the
  caller could point the self-check at their own id while editing someone else's record. Ordering it
  this way makes the trusted value win regardless of what the body schema does; the integration test
  "forbids editing another user even when the body spoofs the caller id" pins it.

## Testing

Tests live alongside the code (unit) and under `test/integration` (integration). The two run under
separate Vitest configs — the default config (`vitest.config.ts`) includes only `src/**/*.test.ts`
and excludes `test/**` and `**/*.int.test.ts`, so integration tests have their own command:

```bash
npm test                          # unit tests only (vitest run)
npm test -- user                  # narrow the unit run to files matching "user"
npm run test:integration          # the /users HTTP integration test (needs a database)
```

**Domain unit tests**

- `src/domain/user/user-entity.test.ts` — name normalization; `create` vs `hydrate` (only `create`
  records exactly one `UserCreatedEvent`, and `pullDomainEvents` has pull-once semantics; `hydrate`
  records nothing, and `create` gives `createdAt`, `updatedAt` and the event's `occurredAt` equal
  instants); `activate`/`deactivate` no-op and deleted-user guards; `changeFirstName` /
  `changeLastName` / `changeEmail` (including the value-equality no-op on `ADA@…` vs `ada@…`);
  `softDelete` (deactivates + stamps `deletedAt`) and `restore` (clears `deletedAt`, stays inactive);
  and `equals`. Every mutator is asserted against the explicit instant it was passed — the file uses no
  fake timers.
- `src/domain/user/email-vo.test.ts` — trimming/lowercasing, format validation (`InvalidEmailError`
  across a table of malformed inputs), value equality, and `toString`.
- `src/domain/user/user-errors.test.ts` — each error's `instanceof` base, `code`, `kind`, message
  content, and `name`.

**Application unit tests** (each uses in-memory port fakes, no database)

- `src/application/user/create-user.test.ts` — malformed email short-circuits before any collaborator;
  a duplicate email is rejected before hashing and **without opening a transaction**; the password is
  hashed and an id generated; the user is saved through the unit of work exactly once; exactly one
  `UserCreatedEvent` is **staged inside the transaction** with `save` provably preceding `stage`; and
  the DTO is mapped — all driven through a fake `UnitOfWork`.
- `src/application/user/edit-user.test.ts` — not-found, invalid email, duplicate email on change, the
  "email unchanged → skip the uniqueness lookup" path, per-field updates, persistence, and DTO
  mapping.
- `src/application/user/get-user.test.ts`, `.../list-users.test.ts`, `.../delete-user.test.ts` — the
  read, list-pagination (defaults `page=1`/`pageSize=10`, `pageSize` capped at 100, `hasNext`/`hasPrev`
  flags), and soft-delete happy/`404` paths.

**Infrastructure unit tests** (drive the adapters against a mocked Prisma client, no database)

- `src/infrastructure/persistence/prisma-user-repository.test.ts` — `list` maps rows to domain items
  with a `total`, computes the right `skip`/`take` for a later page, and constrains every query to
  `where: { deletedAt: null }`; `findById` returns a mapped `User` or `null` and always queries
  `{ id, deletedAt: null }`; `findByEmail` maps-or-returns-`null` and queries the unique `email`
  column **without** a `deletedAt` filter (so a soft-deleted account's email still reads as taken);
  `save` upserts keyed on `id`, writes the immutable `id`/`createdAt` only on the `create` branch
  (never on `update`), and translates a Prisma `P2002` violation into `ConflictError`.
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

- `POST /users`: `201` + persistence; that a `UserCreatedEvent` is **staged as an unpublished outbox
  row (`publishedAt: null`) rather than dispatched synchronously** — the in-process
  `userCreatedLogHandler.handle` spy is asserted _not_ called during the request; plus `401`
  unauthenticated, `409` duplicate email, and `400` invalid input. The full
  create → relay → worker → handler round-trip is proved separately (see
  [domain-events.md](./domain-events.md)).
- `GET /users`: pagination metadata, `page`/`pageSize` honouring across multiple pages, and `401`.
- `GET /users/:id`: `200`, `404` unknown, `400` malformed id, `401`, and the exact public field set
  (no `passwordHash`; `createdAt` serialized to an ISO-8601 string on the wire).
- `PATCH /users/:id`: partial update, email change, `409` duplicate, `404`, `400`, `401`.
- `DELETE /users/:id`: `204` + soft-delete (row retained, `deletedAt` set, hidden from later reads),
  exclusion from the list, `404` unknown, `404` on double-delete, and `401`.
- Authorization: a role-less user is `403` (`FORBIDDEN`) on list; a `users.read` holder can list but
  not create (`403`); a user can read and edit their **own** record without any permission; reading
  another user without permission is `403`.
