# User CRUD

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `5156995`

## Purpose

An account is the anchor every other record in the system hangs off, and it does not hold still:
people are added, rename themselves, move to a new address, and leave. Without one owner for that
lifecycle, the rules that keep it coherent — who may act on whom, what a departed account leaves
behind, whether an address nobody has proved ownership of still carries trust — get re-decided at
every call site that touches a user. This feature owns them. It also exists as much to be copied as
to be used: it is the codebase's reference _vertical slice_, the one feature wired through every
architectural layer end-to-end, so the structural decisions are made once here and every later
feature inherits them rather than re-litigating them.

## How it works

Every operation enters through a Fastify route in
`src/presentation/http/routes/user-routes.ts`; the public paths are `/v1/users…` (the mount chain is
under _Public surface_). The plugin registers an `onRequest` hook that runs `app.authenticate`
first, so a request without a valid bearer access token is rejected with `401` before any handler
runs (the hook populates `request.user` with the caller's `sub`, `permissions`, and
`systemRoleKeys`). An `onRoute` hook stamps every route's schema with `tags: ['Users']` and
`security: [{ bearerAuth: [] }]` so the generated OpenAPI document groups and marks them correctly.
Each route's Zod schema validates the querystring / params / body, rejecting malformed input with
`400`. The handler resolves the matching use case from the request's Awilix scope
(`request.diScope.cradle`), maps `request.user` to a domain `Actor` with `toRequestActor`
(`src/presentation/http/identity/actor-from-token-payload.ts`) — the framework-free identity the
domain reasons about, carrying only `userId`, `permissions`, and `systemRoleKeys`, with no HTTP or
token detail attached — and calls the use case's single `execute(input, actor)` method.

**Authorization happens inside the use case, not in a route guard.** The first statement of every
`execute` is a call to one of two pure domain policy functions from
`src/domain/authorization/access-policy.ts`:

- `ensurePermission(actor, key)` — demands the named `PermissionKey`.
- `ensureSelfOrPermission(actor, targetUserId, key)` — allows a caller acting on their **own**
  record (`actor.userId === targetUserId`) and otherwise demands the permission.

A superadmin (holder of the `'super-admin'` system role key) bypasses both checks; a failed check
throws `PermissionDeniedError` → `403`. Which endpoint demands which permission is listed under
_Public surface_ below; the grant model, token claims, and policy mechanics belong to the
[role-based-authorization.md](./role-based-authorization.md) feature.

The happy paths:

- **Create** (`CreateUser.execute`) builds an `Email` _value object_ — an immutable type compared by
  its value rather than by identity, which validates and normalizes the address on the way in —
  checks `findByEmail` for a duplicate (throwing `EmailAlreadyTakenError` → `409` if found), hashes
  the plaintext password through the `PasswordHasher` port, and constructs the entity with
  `User.create(params, this.clock.now())` — a single reading of the `Clock` port that stamps
  `createdAt`, `updatedAt`, and the recorded event's `occurredAt` with the same instant. It then
  opens a `UnitOfWork` transaction ([unit-of-work.md](./unit-of-work.md)) and, inside it, saves the
  user through the **transaction-scoped** `userRepository` and stages the entity's buffered domain
  events into the transaction's `outbox` — the _transactional outbox_ pattern, in which the event is
  written as a row in the same commit as the user and only then relayed to its subscribers
  asynchronously ([domain-events.md](./domain-events.md)):

  ```ts
  await this.uow.run(async ({ userRepository, outbox }) => {
    await userRepository.save(newUser);
    outbox.stage(newUser.pullDomainEvents());
  });
  ```

  So the user row and its `UserCreatedEvent` commit atomically. The route returns `201` with the
  `UserDto`. An admin-created user starts `active`; the self-service registration path
  (`User.register`, driven by the [email-verification.md](./email-verification.md) feature) starts
  `pending` instead.

- **List** (`ListUsers.execute`) normalizes the pagination query (defaulting and clamping
  `page`/`pageSize`), asks the repository for a page slice (which excludes soft-deleted rows and
  orders by `createdAt` descending), and wraps the mapped DTOs in a `Page<UserDto>` envelope
  carrying `total`/`hasNext`/`hasPrev`. Returns `200`.
- **Get** (`GetUser.execute`) loads by id via `findById` (which returns `null` for soft-deleted
  rows), throwing `UserNotFoundError` → `404` on a miss. Returns `200`.
- **Edit** (`EditUser.execute`) loads the user (`404` on miss) and applies the requested fields
  through the domain mutators (`changeFirstName` / `changeLastName` / `changeEmail`), all sharing
  one `now` hoisted from a single `clock.now()` reading so a multi-field request records one
  `updatedAt`. An email change takes the long path described next; a name-only edit persists via
  the `UnitOfWork` and returns `200`.
- **Delete** (`DeleteUser.execute`) loads the user (`404` on miss), calls
  `user.softDelete(this.clock.now())` — which also deactivates the account and stamps `deletedAt`
  with that same instant — and persists. Returns `204`.

**The email-change path re-verifies ownership.** When `EditUser` receives an `email` that actually
differs from the current one (`Email` equality is by normalized value, so a case-only change is a
no-op), it checks uniqueness against another account (`EmailAlreadyTakenError` → `409`), then calls
`user.changeEmail(email, now)` — which demotes an `active` user to `pending` (a user already
`pending` or `inactive` keeps their status). It then resolves a verification code through the
`VerificationCodeIssuer`: if the user already has an active code row
(`emailVerificationCodeRepository.findActiveByUserId`), that row is **reissued** with a fresh raw
code and expiry; otherwise a new `EmailVerificationCode` is issued — so a user holds at most one
active code no matter how many times they change their address. The user row and the code row are
persisted in the **same** `UnitOfWork` transaction, and only after that transaction commits does
the use case enqueue the delivery job:

```ts
const payload: SendVerificationEmailPayload = {
  email: newEmail,
  code: verificationCode.rawCode,
};
await this.queue.enqueue(SEND_VERIFICATION_EMAIL_JOB, payload);
```

`SEND_VERIFICATION_EMAIL_JOB` (`'email.send-verification'`,
`src/application/jobs/send-verification-email-job.ts`) is processed by the background worker, which
emails the code to the **new** address; the user completes the loop through
`POST /v1/auth/verify-email`, returning to `active`. The code format, hashing, TTL/attempt policy,
and the verify endpoint belong to the [email-verification.md](./email-verification.md) feature —
`EditUser`'s responsibility ends at "demote, persist a code, enqueue the email". That last `await`
is outside the transaction and is **not** guarded; what a failed enqueue leaves behind is covered
under _Design decisions_.

The decisive failure paths are `400 VALIDATION` for a Zod schema rejection — by far the most common
failure on all five endpoints, and what a caller sees for a malformed email, because the route
schemas' `z.email()` is strictly stricter than the domain's own check — `400 USER_NAME_INVALID` for
a name that passes `z.string().min(1)` but is blank once trimmed (`"   "`), `401` for a missing or
invalid access token (`MISSING_ACCESS_TOKEN` when the `Authorization` header is absent), `403`
(`FORBIDDEN`) when the caller lacks the required permission and is not acting on their own record,
`404` (`USER_NOT_FOUND`) for an unknown or already soft-deleted user, `409`
(`EMAIL_ALREADY_TAKEN`) for a duplicate email, and `429` (`RATE_LIMITED`) once the caller exhausts
its request budget — the stricter `RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_WINDOW` on
`PATCH /v1/users/:id`, the app-wide `RATE_LIMIT_MAX` on the other `/v1/users` routes. Every case
except the last is thrown as a typed error and translated to an HTTP status by the central error
handler (`src/presentation/http/error-handler.ts`) via the error's `ErrorKind`; the `429` is
produced by the rate-limit plugin's own `errorResponseBuilder` into the same envelope
([http-infrastructure.md](./http-infrastructure.md)).

**The domain event, committed transactionally.** `User.create` (and `User.register`) records a
`UserCreatedEvent` (name `user.created`, carrying the new user's id as `aggregateId` and its email)
into the entity's internal event buffer. `CreateUser` drains that buffer with
`newUser.pullDomainEvents()` and stages it via the transaction context's `OutboxStaging`
(`outbox.stage(...)`) **inside the same database transaction** as the user insert, so the event row
lands in the outbox exactly when — and only when — the user is persisted. Delivery is
**at-least-once and asynchronous**: a background relay later reads the committed outbox rows and
hands each event to its subscribers (for `user.created`, `UserCreatedLogHandler` writes a
structured log line). The event is **not** dispatched synchronously within the request. That relay,
serialization, and dispatch pipeline is a separate cross-cutting feature — see
[domain-events.md](./domain-events.md).

## Architecture

The slice is assembled from five kinds of part: a rich `User` domain _aggregate_ — the consistency
boundary a single transaction writes, one entity that owns its invariants and is loaded and saved
whole — carrying an `Email` value object, one use-case class per operation, a Prisma-backed
repository sitting behind a domain-owned interface, permission-guarded Fastify routes, and a domain
event emitted on creation and committed transactionally with the user row.

The dependency rule points inward. The domain (`User`, `Email`, the domain errors,
`UserCreatedEvent`, and the `UserRepository` **interface**) depends on no framework, no ORM, and no
I/O — only on the framework-free primitives in `src/shared`: the semantic error base classes
`ValidationError` / `ConflictError` / `NotFoundError` from `@/shared/errors` (which
`user-errors.ts` and `email-vo.ts` extend to get their `ErrorKind` and stable code), and the
`PageQuery` / `PageSlice` types from `@/shared/pagination` that shape `UserRepository.list`. Those
are plain types and classes with no dependencies of their own, which is what keeps the domain
testable without a database or an HTTP server. The application use cases depend only on the domain
and on **ports** — `UserRepository`, `PasswordHasher`, `IdGenerator`, `Clock`, `UnitOfWork` (whose
`TransactionContext` exposes the transaction-scoped repositories and the `OutboxStaging` role), and
for the email-change path `JobQueue`, the domain's `EmailVerificationCodeRepository` interface, and
the `VerificationCodeIssuer` application service shared with the registration flow — never on
Prisma or Fastify. The domain takes time as a plain `Date` parameter and depends on no clock at
all. Infrastructure supplies the **adapters** (`PrismaUserRepository`, `PrismaUnitOfWork`,
`Argon2PasswordHasher`, `UuidIdGenerator`, `SystemClock`, `BullMqJobQueue`,
`PrismaEmailVerificationCodeRepository`) that implement those ports. The presentation layer adapts
HTTP to use-case calls. Concretes are bound to ports in exactly one place — the composition root
`src/container.ts` (`userRepository`, `idGenerator`, `clock`, `passwordHasher`, `unitOfWork`,
`jobQueue`, `emailVerificationCodeRepository`, `verificationCodeIssuer`, and the five use cases
`listUsers` / `getUser` / `createUser` / `editUser` / `deleteUser`, all registered as singletons).

| Component                                                                                                      | Layer              | Responsibility                                                                                                                                                                                                   | File                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `User`                                                                                                         | Domain             | Rich aggregate: normalizes names, guards status / soft-delete invariants, demotes to `pending` on email change, records `UserCreatedEvent`                                                                       | `src/domain/user/user-entity.ts`                                |
| `Email`                                                                                                        | Domain             | Value object: trims, lowercases, and format-validates an address; equality by value                                                                                                                              | `src/domain/user/email-vo.ts`                                   |
| `UserRepository`                                                                                               | Domain             | Persistence **interface** the domain owns: `list`, `findById`, `findByEmail`, `save`                                                                                                                             | `src/domain/user/user-repository.ts`                            |
| `UserNotFoundError`, `EmailAlreadyTakenError`, `UserInvalidNameError`, `UserDeletedError`, `InvalidEmailError` | Domain             | Typed domain errors carrying the stable codes listed under _Public surface_; mapped to HTTP status by `ErrorKind`                                                                                                | `src/domain/user/user-errors.ts`, `src/domain/user/email-vo.ts` |
| `UserCreatedEvent`                                                                                             | Domain             | Domain event carrying `aggregateId` + `email`, name `user.created`                                                                                                                                               | `src/domain/user/events/user-created-event.ts`                  |
| `UnitOfWork` / `OutboxStaging`                                                                                 | Application (port) | Transaction boundary `CreateUser` and `EditUser` save within; `outbox.stage(...)` records events in that same transaction (adapter: `PrismaUnitOfWork`)                                                          | `src/application/shared/ports/unit-of-work.ts`                  |
| `PasswordHasher`                                                                                               | Application (port) | Hashes the plaintext password before the entity is built (adapter: `Argon2PasswordHasher`)                                                                                                                       | `src/application/shared/ports/password-hasher.ts`               |
| `IdGenerator`                                                                                                  | Application (port) | Generates the new user's id passed to `User.create` (adapter: `UuidIdGenerator`)                                                                                                                                 | `src/application/shared/ports/id-generator.ts`                  |
| `Clock`                                                                                                        | Application (port) | `now(): Date` — read once per operation and threaded into every mutator (adapter: `SystemClock`)                                                                                                                 | `src/application/shared/ports/clock.ts`                         |
| `JobQueue`                                                                                                     | Application (port) | `enqueue<TPayload>(jobName: string, payload: TPayload, options?: JobOptions): Promise<void>` — carries the post-commit verification-email job; `EditUser` calls it without `options` (adapter: `BullMqJobQueue`) | `src/application/shared/ports/job-queue.ts`                     |
| `VerificationCodeIssuer`                                                                                       | Application        | Issues a fresh `EmailVerificationCode` or reissues the active one, returning the raw code for delivery                                                                                                           | `src/application/auth/verification-code-issuer.ts`              |
| `CreateUser`                                                                                                   | Application        | Guard `users.create`, validate email, dedupe, hash password, create, then save + stage `UserCreatedEvent` in one transaction                                                                                     | `src/application/user/create-user.ts`                           |
| `ListUsers`                                                                                                    | Application        | Guard `users.read`, normalize the page query, fetch the slice, map to a `Page<UserDto>`                                                                                                                          | `src/application/user/list-users.ts`                            |
| `GetUser`                                                                                                      | Application        | Guard self-or-`users.read`, load by id or throw `UserNotFoundError`                                                                                                                                              | `src/application/user/get-user.ts`                              |
| `EditUser`                                                                                                     | Application        | Guard self-or-`users.update`; partial update of name/email; on an email change: dedupe, demote, persist a verification code transactionally, enqueue the email post-commit                                       | `src/application/user/edit-user.ts`                             |
| `DeleteUser`                                                                                                   | Application        | Guard `users.delete`, soft-delete an existing user                                                                                                                                                               | `src/application/user/delete-user.ts`                           |
| `UserDto` / `toUserDto`                                                                                        | Application        | Outbound shape (no `passwordHash`) and the entity→DTO mapper                                                                                                                                                     | `src/application/user/user-dto.ts`                              |
| `normalizePageQuery` / `createPage`                                                                            | Shared             | Normalize and clamp the page query (`page` ≥ 1, `pageSize` 1–100, defaults `1`/`10`), then wrap the mapped DTOs in the `Page<T>` envelope with `total`/`hasNext`/`hasPrev`                                       | `src/shared/pagination.ts`                                      |
| `PrismaUserRepository`                                                                                         | Infrastructure     | `UserRepository` adapter over Prisma; filters `deletedAt: null` on identity reads (`findById`, `list`), upserts on `save`                                                                                        | `src/infrastructure/persistence/prisma-user-repository.ts`      |
| `toDomain` / `toPersistence`                                                                                   | Infrastructure     | Maps a Prisma `User` row ↔ the `User` aggregate                                                                                                                                                                  | `src/infrastructure/persistence/prisma-user-mapper.ts`          |
| `mapPrismaError`                                                                                               | Infrastructure     | Translates Prisma `P2002`/`P2025` into `ConflictError` (`UNIQUE_VIOLATION`) / `NotFoundError` (`RECORD_NOT_FOUND`), everything else into `InternalError` (`INTERNAL`)                                            | `src/infrastructure/persistence/prisma-error.ts`                |
| `userRoutes`                                                                                                   | Presentation       | Fastify plugin: authenticate hook, OpenAPI tagging, Zod schemas, actor mapping, handlers                                                                                                                         | `src/presentation/http/routes/user-routes.ts`                   |
| `apiV1Routes`                                                                                                  | Presentation       | Mounts `userRoutes` (and the sibling route plugins) under the `/v1` API version prefix                                                                                                                           | `src/presentation/http/routes/api-v1-routes.ts`                 |
| `userResponse` / `paginatedUsers`                                                                              | Presentation       | Zod **response** schemas that serialize the DTO on the wire                                                                                                                                                      | `src/presentation/http/schemas/user-response-schema.ts`         |
| `paginated`                                                                                                    | Presentation       | Generic Zod pagination envelope `paginated(item)`; `paginatedUsers` is it instantiated with `userResponse`                                                                                                       | `src/presentation/http/schemas/pagination-schema.ts`            |
| `errorResponse`                                                                                                | Presentation       | Zod contract for the shared error envelope returned on every failure                                                                                                                                             | `src/presentation/http/schemas/error-schema.ts`                 |

## Public surface

All endpoints live under `/v1/users`, assembled in three files: the routes are declared in
`userRoutes`, which `apiV1Routes` (`src/presentation/http/routes/api-v1-routes.ts`) mounts with the
prefix `/users`, itself registered at `API_V1_PREFIX` (`'/v1'`,
`src/presentation/http/api-version.ts`) in `src/presentation/http/app.ts`. Every route first
requires a valid bearer access token (the `onRequest` → `app.authenticate` hook); the **Auth**
column below is the _additional_ check the use case enforces. A superadmin (holder of the
`super-admin` system role) bypasses every permission and self check.

| Method   | Path            | Auth                                  | Purpose                                                                                                                                                                                                                                                                                                                                                              |
| -------- | --------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/users`     | permission `users.read`               | List users (paginated, excludes soft-deleted, newest first). Query: `page`, `pageSize` — optional, coerced ints ≥ 1. Returns `200` with a paginated envelope; `400 VALIDATION` on a malformed query.                                                                                                                                                                 |
| `GET`    | `/v1/users/:id` | self **or** permission `users.read`   | Fetch one user by id. `:id` must be a UUID. Returns `200`, `404 USER_NOT_FOUND` if unknown or soft-deleted, `400 VALIDATION` for a non-UUID id.                                                                                                                                                                                                                      |
| `POST`   | `/v1/users`     | permission `users.create`             | Create an `active` user. Body: `firstName`, `lastName` (1–100 chars), `email`, `password` (8–128 chars). Returns `201` with the created user, `409 EMAIL_ALREADY_TAKEN` on a duplicate address, `400 VALIDATION` on any schema rejection (including a malformed email), or `400 USER_NAME_INVALID` for a whitespace-only name.                                       |
| `PATCH`  | `/v1/users/:id` | self **or** permission `users.update` | Partial update of `firstName`, `lastName`, and/or `email` (all optional, non-empty). An email change demotes the user to `pending` and triggers a verification email. Returns `200`, `404 USER_NOT_FOUND`, `409 EMAIL_ALREADY_TAKEN`, `400 VALIDATION` / `400 USER_NAME_INVALID`, or `429 RATE_LIMITED` past `RATE_LIMIT_AUTH_MAX` requests per `RATE_LIMIT_WINDOW`. |
| `DELETE` | `/v1/users/:id` | permission `users.delete`             | Soft-delete a user. Returns `204`, or `404 USER_NOT_FOUND` if unknown or already deleted.                                                                                                                                                                                                                                                                            |

Two more routes are **declared** in the same file but **owned** elsewhere:

| Method   | Path                          | Feature                                                                                                                            |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/users/:id/roles`         | Assign a role to a user (permission `roles.assign`, `AssignRole`) — [role-based-authorization.md](./role-based-authorization.md)   |
| `DELETE` | `/v1/users/:id/roles/:roleId` | Revoke a role from a user (permission `roles.assign`, `RevokeRole`) — [role-based-authorization.md](./role-based-authorization.md) |

The **response contract** every single-user read/write endpoint returns (except `DELETE`, which
sends no body) is the `UserDto`; the list endpoint wraps it in a `Page<UserDto>` envelope. The DTO
is serialized by the `userResponse` Zod schema, which never includes `passwordHash`:

```ts
export interface UserDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  status: UserStatusType; // 'active' | 'inactive' | 'pending'
  createdAt: Date; // serialized to an ISO-8601 string on the wire
  updatedAt: Date;
}
```

Every failure, on every endpoint above, comes back in the shared error envelope declared by
`errorResponse` (`src/presentation/http/schemas/error-schema.ts`) —
`{ error: { code, message, details?, requestId } }`, where `code` is one of the machine-readable
strings below, `details` is optional, and `requestId` is the request's correlation id. The envelope
itself, its `ErrorKind` → status mapping, and the rate limiter that raises `429 RATE_LIMITED` are
described in [http-infrastructure.md](./http-infrastructure.md).

The codes this feature owns:

| Code                  | Status | Raised by                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USER_NOT_FOUND`      | `404`  | `UserNotFoundError` — `GetUser` / `EditUser` / `DeleteUser` when `findById` misses (an unknown or soft-deleted id).                                                                                                                                                                                                                                                                                                                  |
| `EMAIL_ALREADY_TAKEN` | `409`  | `EmailAlreadyTakenError` — `CreateUser`, and the `EditUser` email change, when the `findByEmail` pre-check finds the address already belongs to an account.                                                                                                                                                                                                                                                                          |
| `UNIQUE_VIOLATION`    | `409`  | `mapPrismaError` on Prisma `P2002` from `PrismaUserRepository.save` — the **race-window variant** of the above: two concurrent creates (or email changes) both clear the pre-check, and the database's unique `email` column rejects the loser. Clients handling `409` must accept either code.                                                                                                                                      |
| `USER_NAME_INVALID`   | `400`  | `UserInvalidNameError` — a first or last name that is blank after trimming. Reachable over HTTP: `"   "` satisfies `z.string().min(1)` and is only rejected by `User.normalizeName`.                                                                                                                                                                                                                                                 |
| `INVALID_EMAIL`       | `400`  | `InvalidEmailError` (`src/domain/user/email-vo.ts`) — `Email.create` on a malformed address. **Defence in depth, not a reachable HTTP path:** every body carrying an email is validated by `z.email()` first, which is strictly stricter than the domain's `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, so a malformed address always comes back as `VALIDATION`. The domain check protects non-HTTP callers (jobs, scripts, a future transport). |
| `USER_DELETED`        | `409`  | `UserDeletedError` — an entity mutator invoked on a soft-deleted aggregate. Defence in depth rather than a reachable HTTP path; see _Design decisions_.                                                                                                                                                                                                                                                                              |

The codes for the layers this feature sits on are documented with those features:

- `VALIDATION` (`400`, [http-infrastructure.md](./http-infrastructure.md)) — **the most common
  failure on all five endpoints.** The error handler emits it for any Fastify/Zod schema rejection
  of the querystring, params, or body, before a use case is ever resolved.
- `MISSING_ACCESS_TOKEN` and the access-token service's own rejections such as
  `INVALID_ACCESS_TOKEN` (`401`, [authentication.md](./authentication.md)).
- `FORBIDDEN`, carrying `details.required` (`403`,
  [role-based-authorization.md](./role-based-authorization.md)).
- `RATE_LIMITED` (`429`, [http-infrastructure.md](./http-infrastructure.md)).
- `RECORD_NOT_FOUND` (`404`) and `INTERNAL` (`500`) — the other two outcomes of `mapPrismaError`
  ([unit-of-work.md](./unit-of-work.md)), raised on Prisma `P2025` and on any other database
  failure respectively. Neither is part of this feature's intended contract, but both can surface
  from any write here when the database misbehaves.

The `GET /v1/users` list envelope is `Page<UserDto>` (`src/shared/pagination.ts`), with `page`
defaulting to `1`, `pageSize` defaulting to `10` and capped at `100`:

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

This feature declares no environment key of its own. Every key below is owned by another feature
and reached only because this one composes that feature's infrastructure — including the two the
route file reads directly. Each row names the owning doc. All keys are parsed in
`src/config/env.ts` and mirrored in `.env.example`.

| Variable                                                                                                | Default                                                                    | Meaning                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_AUTH_MAX`                                                                                   | `5`                                                                        | Requests allowed per window on the stricter auth budget. `user-routes.ts` **reads** it (`env.RATE_LIMIT_AUTH_MAX`) to override the limiter on `PATCH /v1/users/:id`, because an email change sends mail ([authentication.md](./authentication.md)).                                                     |
| `RATE_LIMIT_WINDOW`                                                                                     | `1 minute`                                                                 | Length of the rate-limit window. Also read in `user-routes.ts` for that same `PATCH` override ([authentication.md](./authentication.md)).                                                                                                                                                               |
| `RATE_LIMIT_MAX`                                                                                        | `100`                                                                      | Global per-window budget the rate-limit plugin applies to the other `/v1/users` routes ([http-infrastructure.md](./http-infrastructure.md)).                                                                                                                                                            |
| `DATABASE_URL`                                                                                          | (required, no default)                                                     | Connection string for the Prisma client behind `PrismaUserRepository` and `PrismaUnitOfWork` ([unit-of-work.md](./unit-of-work.md)).                                                                                                                                                                    |
| `JWT_ACCESS_SECRET`                                                                                     | (required, no default; ≥ 32 chars in production)                           | HMAC key verifying the bearer token the `authenticate` hook demands on every route ([authentication.md](./authentication.md)).                                                                                                                                                                          |
| `JWT_ISSUER`                                                                                            | `app`                                                                      | The `iss` claim `JoseAccessTokenService` stamps when signing and **enforces** in `verify`. The `authenticate` hook verifies on every request, so a value that disagrees with the signer's `401`s all five endpoints ([authentication.md](./authentication.md)).                                         |
| `JWT_AUDIENCE`                                                                                          | `app-api`                                                                  | The `aud` claim, enforced by the same `jwtVerify` call and with the same blast radius ([authentication.md](./authentication.md)).                                                                                                                                                                       |
| `VERIFICATION_CODE_TTL`                                                                                 | `900` (15 minutes)                                                         | Lifetime of the code issued on an email change, folded into `verificationConfig` ([email-verification.md](./email-verification.md)).                                                                                                                                                                    |
| `VERIFICATION_MAX_ATTEMPTS`                                                                             | `5`                                                                        | Attempt budget on that code before it is invalidated ([email-verification.md](./email-verification.md)).                                                                                                                                                                                                |
| `VERIFICATION_CODE_SECRET`                                                                              | dev/test: `dev-verification-code-secret-change-me`; production: no default | HMAC pepper `VerificationCodeService.hash` applies to the code `VerificationCodeIssuer` mints on an email change. In production it must be ≥ 32 characters or `assertProductionSecrets` (`src/config/assert-production-secrets.ts`) refuses to boot ([email-verification.md](./email-verification.md)). |
| `REDIS_URL`                                                                                             | dev/test: `redis://127.0.0.1:6379`; production: no default                 | Redis connection BullMQ uses; the email-change branch's `queue.enqueue(SEND_VERIFICATION_EMAIL_JOB, …)` rides it, and an unreachable Redis fails the `PATCH` after the commit (see _Design decisions_) ([background-jobs.md](./background-jobs.md)).                                                    |
| `QUEUE_PREFIX`                                                                                          | `app`                                                                      | Key prefix namespacing this app's BullMQ queues in Redis, so the enqueued job reaches this app's worker ([background-jobs.md](./background-jobs.md)).                                                                                                                                                   |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | dev: `localhost:1025`, no auth, `no-reply@<APP_NAME>.local`                | Transport and From address the worker uses to actually deliver the verification email an email change enqueues. Nothing here is read in-request — a misconfiguration fails inside the worker, long after the `PATCH` returned `200` ([email-sending.md](./email-sending.md)).                           |

## Usage & extension

### Calling an endpoint

Obtain an access token through the [authentication.md](./authentication.md) feature, then call an
endpoint with a bearer header:

```bash
# Create a user (caller must hold users.create, or be superadmin)
curl -X POST http://localhost:8000/v1/users \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"John","lastName":"Doe","email":"john@example.test","password":"password123"}'
```

### Adding a new user operation (e.g. "deactivate user")

The pattern is identical for every use case; follow these steps.

1. **Add the behaviour to the domain** if it is a new invariant. `User` already exposes
   `deactivate(now)`; a new rule would be a method on `src/domain/user/user-entity.ts` that takes
   `now: Date` as its last parameter, guards its own invariants, and calls `this.touch(now)` when
   it mutates state. Entities never read a clock — they receive the instant.

2. **Write the use-case class** in `src/application/user/`. Depend only on ports via constructor
   DI, take the `Actor` as the last `execute` parameter, and make the authorization check the first
   statement. Save directly through `this.users.save(user)` when the operation writes a single
   `User` row and records no domain event — that is what `DeleteUser` does, and what the recipe
   below does. Open `uow.run(...)` when the operation **can** write more than one row: `CreateUser`
   must stage the `UserCreatedEvent` outbox row in the same commit as the user, and `EditUser`
   wraps unconditionally because its email branch may add a verification-code row — the criterion
   is what the operation is capable of writing, not what a given call happens to write:

   ```ts
   // src/application/user/deactivate-user.ts
   import type { UserRepository } from '@/domain/user/user-repository';
   import type { Clock } from '@/application/shared/ports/clock';
   import { UserNotFoundError } from '@/domain/user/user-errors';
   import { toUserDto, type UserDto } from '@/application/user/user-dto';
   import type { Actor } from '@/domain/authorization/actor';
   import { ensurePermission } from '@/domain/authorization/access-policy';
   import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

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

     async execute(input: DeactivateUserInput, actor: Actor): Promise<DeactivateUserOutput> {
       ensurePermission(actor, PERMISSIONS.UsersUpdate.key);

       const user = await this.users.findById(input.id);
       if (!user) throw new UserNotFoundError(input.id);
       user.deactivate(this.clock.now());
       await this.users.save(user);
       return toUserDto(user);
     }
   }
   ```

3. **Register it in the composition root** `src/container.ts`. Add the type to the `Cradle`
   interface and bind it alongside the other user use cases:

   ```ts
   // in the Cradle interface
   deactivateUser: DeactivateUser;

   // in registerDependencies(...)'s container.register({ ... })
   deactivateUser: asClass(DeactivateUser).singleton(),
   ```

   Awilix injects `userRepository` (and any other cradle key) by matching the constructor
   destructuring names, so no manual dependency wiring is needed.

4. **Expose it over HTTP** in `src/presentation/http/routes/user-routes.ts`: declare Zod schemas
   for the params/body, resolve the use case from `request.diScope.cradle`, and call `execute()`:

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

5. **Write the use case's unit test** — `src/application/user/deactivate-user.test.ts`, beside the
   source. This is not optional bookkeeping: `vitest.config.ts` holds `src/domain/**` and
   `src/application/**` at **100%** statements, branches, functions, and lines, and CI runs
   `npm run test:coverage`, so an untested use case is a red build regardless of whether it works.
   Cover the guard rejecting a caller without the permission **before** any collaborator is
   touched, the `404` path, and the happy path (including the single clock reading). The sibling
   `delete-user.test.ts` is the closest template.

6. **Account for the route in the authorization sweep.** Add a
   `'POST /v1/users/{id}/deactivate': PERMISSIONS.UsersUpdate.key` row to `ROUTE_PERMISSIONS` in
   `test/integration/authorization-enforcement.int.test.ts` (or to `SELF_ACCESS_ROUTES` if it uses
   `ensureSelfOrPermission`) — that suite derives every `/v1` route from the app's own OpenAPI
   document and fails on any it cannot account for.

If the operation needs a _new_ permission, three things have to happen, and the code edit alone is
the smallest of them:

- **Declare it** in `PERMISSIONS` (`src/domain/authorization/permission-catalogue.ts`), which
  widens the `PermissionKey` union so `ensurePermission(...)` stays type-safe.
- **Push the catalogue to the database** with `npm run db:sync-auth`. Until that runs, the
  permission row does not exist, so `PrismaRoleRepository.save` cannot resolve the key to a
  `permission.id` and the key is grantable to nobody — the endpoint then `403`s for every caller
  except a superadmin, with nothing in the code to explain why.
- **Grant it to a role** and give a user that role — `POST /v1/roles` with the key in
  `permissions[]` (or `PATCH /v1/roles/:id` to add it to an existing role), then
  `POST /v1/users/:id/roles`. Grants are read into the access token at sign-in, so the holder must
  obtain a new token before the permission takes effect.

All three steps belong to the [role-based-authorization.md](./role-based-authorization.md) feature,
which documents them in full.

### Subscribing to `user.created`

To react when a user is created (e.g. send a welcome email), implement a domain-event handler,
register it in `src/container.ts`, and add it to the `domainEventHandlers` array — the list the
`DomainEventHandlerRegistry` is built from. The existing `UserCreatedLogHandler`
(`src/application/user/events/user-created-log-handler.ts`) is the reference implementation.
Because the event is delivered asynchronously through the outbox, a new event type also needs a
deserialization factory, and its handler must be **idempotent** (at-least-once delivery can invoke
it more than once for the same event). The full recipe — event → factory → handler → registration —
lives in [domain-events.md](./domain-events.md).

## Design decisions & trade-offs

- **Rich domain entity over an anemic record.** `User` enforces its own invariants — names are
  trimmed and rejected when blank, and status transitions and edits are refused on a deleted user.
  It also keeps the audit stamp honest, since `Entity.touch(now)` stamps unconditionally and each
  mutator decides whether to call it (the change and activate/deactivate pairs compare first and
  return early; `changePassword` cannot, because a salted Argon2 hash of the same password differs
  every time). Concentrating these rules in the entity keeps the use cases thin and prevents an
  invalid `User` from ever existing in memory. The cost is more ceremony (private constructor,
  factory methods, getters over `props`) than a plain interface would need.
- **`Email` value object rather than a bare `string`.** Modelling the address as a type makes
  validation and normalization (trim + lowercase) unavoidable and centralized: a `User` can only
  hold a well-formed email, and equality is by value, so `ADA@example.com` and `ada@example.com`
  compare equal — which is exactly what the "email unchanged" fast-path in `EditUser` (and
  `User.changeEmail`) relies on to skip a needless uniqueness lookup and a needless re-verification.
  The trade-off is an extra unwrap (`email.toString()`) at the persistence and DTO boundaries, and
  a domain format check that no HTTP caller can ever trip because `z.email()` at the route is
  stricter — deliberate redundancy, since the domain must hold for non-HTTP callers too.
- **Three factory methods: `create`, `register`, `hydrate`.** `User.create(params, now)` and
  `User.register(params, now)` share one private `build` and differ only in initial status —
  `active` for the admin-driven create in this feature, `pending` for the self-service registration
  owned by the [email-verification.md](./email-verification.md) feature — and both stamp timestamps
  and record `UserCreatedEvent`. `User.hydrate(props)` reconstructs an existing user from a stored
  row and records **nothing**. Splitting construction from rehydration prevents loading a row from
  re-emitting a "created" event or resetting audit fields; the signatures encode the split
  (`create`/`register` always take `now`, `hydrate` never does, because a hydrated entity's
  timestamps come from the database row).
- **Email change demotes to `pending` and restarts verification.** `changeEmail` downgrades an
  `active` user because the new address is unproven — trust attaches to the verified address, not
  the account. `EditUser` then persists a verification code **in the same transaction** as the user
  row (so a demoted user always has a live code) and enqueues `SEND_VERIFICATION_EMAIL_JOB` only
  **after** the transaction commits — a failed save sends nothing. Reissuing the existing active
  code row instead of inserting a new one keeps one live code per user, so an earlier email cannot
  verify a later address and the table cannot accumulate stale codes.
- **The deliberate gap: the post-commit enqueue is unguarded, and its failure is visible.**
  `await this.queue.enqueue(...)` sits outside `uow.run`, after the commit, in no `try`. If Redis
  is unreachable the rejection propagates, so `PATCH /v1/users/:id` answers `500` — but the write
  it appears to have failed has already landed: the row holds the **new** address, the account has
  been demoted to `pending`, and a live code is stored. The caller sees an error, loses `active`
  status, and receives no email. A crash between commit and enqueue produces the same state
  silently. Recovery is manual and slightly counter-intuitive: resubmitting the _same_ address is a
  no-op, because the stored email now equals it and `changeEmailIfRequested` returns early. Only a
  further genuine change (to any address, including back to the old one) re-enters the branch — and
  when it does, `resolveVerificationCode` finds the still-active row and **reissues** it, so the
  retry rotates the one code rather than leaving a second live one behind. Routing the job through
  the outbox, as `user.created` already is, would close the gap at the cost of the extra relay hop;
  the verification flow itself is documented in
  [email-verification.md](./email-verification.md).
- **Domain event recorded in the entity, staged into a transactional outbox by the use case.**
  `User.create` buffers the event; `CreateUser` drains it with `pullDomainEvents()` and stages it
  via `outbox.stage(...)` **inside the same `UnitOfWork` transaction** as the user insert, so
  `PrismaUnitOfWork` writes the event row and the user row in one commit. Either both land or
  neither does — no "user created" signal escapes for a user that failed to persist. Delivery is
  then **at-least-once** through the background relay, so handlers must be idempotent; the cost
  against synchronous dispatch is eventual consistency, bought in exchange for never losing an
  event to a crash between save and dispatch. See [domain-events.md](./domain-events.md).
- **Save-and-stage inside `uow.run`, dedupe check outside it.** `CreateUser` runs `findByEmail`
  (through its injected `userRepository`) _before_ opening the transaction, and does the `save` +
  `stage` through the **transaction-scoped** `userRepository`/`outbox` handed to the `run`
  callback. The pre-check keeps the common duplicate case cheap (no transaction, no argon2 hash),
  while the in-transaction write plus the database's unique `email` column closes the race the
  pre-check alone cannot. The two paths surface as **different codes** — the pre-check throws
  `EMAIL_ALREADY_TAKEN`, the race loses to Prisma `P2002` which `mapPrismaError` turns into
  `UNIQUE_VIOLATION` — both `409`, which is why a client must branch on the status rather than the
  code.
- **Authorization enforced in the use case, not the route.** Because `execute` requires an `Actor`
  and calls `ensurePermission` / `ensureSelfOrPermission` as its first statement, a non-HTTP caller
  (job handler, CLI, future transport) cannot reach the business logic without presenting an
  identity — omitting the argument is a compile error, not a silent bypass. Reads and edits of a
  _single_ user (`GET`/`PATCH /v1/users/:id`) use `ensureSelfOrPermission`, so a user manages their
  own record without admin grants; collection and destructive operations (`GET`/`POST /v1/users`,
  `DELETE /v1/users/:id`) demand the permission outright.
- **The trusted route parameter goes last in the input spread.** `PATCH /v1/users/:id` builds its
  input as `{ ...request.body, id: request.params.id }`, not the reverse. Because
  `ensureSelfOrPermission` reads `input.id`, a body key named `id` spread after the route parameter
  would let a caller point the self-check at their own id while editing someone else's record.
  Ordering it this way makes the trusted value win regardless of what the body schema does; the
  integration test "forbids editing another user even when the body spoofs the caller id" pins it.
- **Stricter rate limit on `PATCH`.** The edit route overrides the global limiter with
  `RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_WINDOW` — the same budget the auth endpoints use — because
  an email change triggers outbound mail and code issuance, and the cheap global budget (`100` per
  window) would let a single caller trigger an unbounded volume of outbound mail.
- **Soft delete instead of a hard `DELETE`.** `DeleteUser` calls
  `user.softDelete(this.clock.now())`, which stamps `deletedAt` and deactivates the account rather
  than removing the row. The identity reads `findById` and `list` filter `deletedAt: null`, so a
  deleted user disappears from the API while its record — and any foreign-key references to it —
  survive for audit and integrity. `findByEmail` deliberately does **not** filter soft-deleted
  rows: it queries the unique `email` column directly, so a soft-deleted account's email still
  counts as taken and blocks re-registration under the same address. The cost is that
  `deletedAt: null` must be threaded through the identity reads, and a "resurrect" path
  (`User.restore(now)`) has to exist for completeness.
- **Deleted-user guards are defence in depth, not a reachable HTTP path.** `changeEmail`,
  `changeFirstName`, `deactivate`, etc. throw `UserDeletedError` (`USER_DELETED`, a `409`) when the
  user is deleted, but because `findById` excludes soft-deleted rows, the edit/delete/get use cases
  never load one — they get `null` and return `404` first. The entity guard protects any _future_
  caller that obtains a deleted aggregate by another route, without weakening the current API's
  `404` behaviour.
- **`save` as an upsert with immutable `id`/`createdAt`.** `PrismaUserRepository.save`
  destructures `id` and `createdAt` out of the mutable set and upserts: it writes them only on the
  `create` branch, never on `update`. One method covers both create and edit, and
  identity/creation time cannot be mutated by an edit.
- **Mapper split from the repository.** `toDomain` / `toPersistence` (`prisma-user-mapper.ts`) are
  pure functions kept separate from `PrismaUserRepository`. The repository owns _querying_ (the
  `deletedAt: null` filter, the pagination `$transaction`, the upsert) while the mapper owns the
  _field-by-field translation_ between the persistence row and the aggregate, so the mapping can be
  reasoned about (and tested) without a database.
- **Response Zod schema as an output contract.** `userResponse` re-declares the shape the endpoint
  returns and is used as the Fastify serializer. It guarantees no accidental field leak (notably
  `passwordHash`) regardless of what the DTO grows to hold, and it feeds the generated OpenAPI
  document — which the authorization-enforcement suite in turn walks to find every route.

## Testing

Unit tests sit beside their subjects and need no database or Redis; integration tests live under
`test/integration` and run against a real Fastify app, database, and Redis under their own Vitest
config:

```bash
npm test                   # unit tests (vitest run)
npm run test:coverage      # the same run under the 100% gate CI enforces
npm run test:integration   # HTTP integration tests (need a database + Redis)
```

`npm run test:coverage` is the one that matters when adding to this slice: the thresholds in
`vitest.config.ts` demand 100% statements, branches, functions, and lines across `src/domain/**`
and `src/application/**`, so any new entity method or use case must arrive with its test.

**Unit tests** (in-memory fakes and a mocked Prisma client; no database)

- `src/domain/user/user-entity.test.ts` — name normalization, the `create`/`register`/`hydrate`
  split, the event buffer's pull-once semantics and shared instant, status transitions and
  deleted-user guards, the change mutators (including the demotion on email change and the
  value-equality no-op), `softDelete`, and `restore`.
- `src/domain/user/email-vo.test.ts` — trimming/lowercasing, format validation across a table of
  malformed inputs, value equality, and `toString`.
- `src/domain/user/user-errors.test.ts` — each error's base class, `code`, `kind`, and message.
- `src/application/user/create-user.test.ts` — malformed and duplicate emails short-circuit before
  hashing or opening a transaction; hashing, id generation, and a single clock reading; exactly one
  `UserCreatedEvent` staged after the save inside one transaction.
- `src/application/user/edit-user.test.ts` — not-found, invalid and duplicate emails, the
  unchanged-email fast path, per-field updates on one shared instant, and the verification branch
  (demote, issue vs reissue, enqueue only after a successful commit, untouched on a name-only edit).
- `src/application/user/get-user.test.ts`, `list-users.test.ts`, `delete-user.test.ts` — the read,
  pagination defaults/clamping with `hasNext`/`hasPrev`, and the soft-delete happy/`404` paths.
- Every application test file also carries an authorization `describe` proving the guard runs
  before any collaborator is touched, plus the self-access cases for get and edit.
- `src/application/user/events/user-created-log-handler.test.ts` — the `user.created` subscriber
  logs the event's `aggregateId` and email, the reference an added handler is modelled on.
- `src/shared/pagination.test.ts` — `normalizePageQuery` defaults and clamping (`page` ≥ 1,
  `pageSize` 1–100) and `createPage`'s `total`/`hasNext`/`hasPrev` arithmetic at the boundaries,
  which is where `GET /v1/users`'s envelope actually comes from.
- `src/infrastructure/persistence/prisma-user-repository.test.ts` — the `deletedAt: null` filter on
  `list`/`findById` and its deliberate absence on `findByEmail`, `skip`/`take` arithmetic, and the
  upsert writing `id`/`createdAt` only on insert with `P2002` → `ConflictError`.
- `src/infrastructure/persistence/prisma-user-mapper.test.ts` — every scalar column maps in both
  directions (including `deletedAt`) and the pair round-trips losslessly.
- `src/presentation/http/schemas/user-response-schema.test.ts` — `userResponse` strips fields
  outside the contract (notably `passwordHash`) and rejects an unknown `status`; `paginatedUsers`
  wraps items in the pagination envelope and strips secrets per item.
- `src/presentation/http/schemas/pagination-schema.test.ts` — the generic `paginated(item)`
  envelope's own shape, independent of the user item type it is instantiated with.

**Integration tests** (the real Fastify app against a real database via `app.inject`)

- `test/integration/users.int.test.ts` — the full `/v1/users` HTTP contract across all five
  endpoints (status codes, the public field set, pagination metadata, soft-delete semantics), the
  `UserCreatedEvent` landing as an unpublished outbox row instead of dispatching in-request, and an
  authorization block ending in the body-spoofed-id IDOR probe.
- `test/integration/edit-user-verification.int.test.ts` — the email-change loop: demotion plus an
  enqueue to the new address (captured through a `CapturingJobQueue` harness override), reissue
  rather than insert on a second change, and the enqueued code completing
  `POST /v1/auth/verify-email`.
- `test/integration/authorization-enforcement.int.test.ts` — derives every `/v1` route from the
app's OpenAPI document, denies each guarded route to a zero-permission caller, and admits a
caller holding exactly the mapped permission — pinning the permission listed for each
`/v1/users` endpoint above.
</content>
