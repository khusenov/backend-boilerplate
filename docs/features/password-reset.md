# Password Reset

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation, composition root · **Verified against:** `7150871`

## Purpose

A user who forgets their password has no way back in: login needs the password, and every other credentialed path needs a session. This feature is the self-service recovery route — the user proves they still control the account's mailbox by clicking an emailed, single-use, time-limited link, then chooses a new password. The single use and the short lifetime are what make a mailed link safe to send at all: the link lingers in the inbox, in browser history, and in whatever mail scanners and proxy logs it passed through, so anyone who later reads that mailbox could replay it unless it burns on redemption and dies on a clock. The request endpoint answers identically whether or not the address maps to an account, so it cannot be used to enumerate accounts. The database stores only a SHA-256 hash of the token, so a leaked row yields no working reset link, and a successful reset revokes every existing session rather than leaving a suspect credential signed in.

## How it works

Two anonymous HTTP endpoints and one email make up the flow: `POST /v1/auth/forgot-password` mails a link, and `POST /v1/auth/reset-password` redeems the token carried in that link. Both reply `204` and carry no auth guard — the caller, by definition, cannot authenticate — and both share the stricter auth-endpoint rate limit (`RATE_LIMIT_AUTH_MAX` requests per `RATE_LIMIT_WINDOW`).

Those full paths assemble in three files: both routes are declared in `authRoutes` (`src/presentation/http/routes/auth-routes.ts`), which `apiV1Routes` (`src/presentation/http/routes/api-v1-routes.ts`) mounts under `/auth`, itself registered at `API_V1_PREFIX` (`/v1`) in `src/presentation/http/app.ts`. Each handler pulls its use case out of `request.diScope.cradle`; the _cradle_ is Awilix's typed registry of everything the container can resolve by name, and `diScope` is the per-request child scope `fastifyAwilixPlugin` derives from the application container that `createAppContainer` (`src/container.ts`) builds at boot.

**Requesting a reset (`POST /v1/auth/forgot-password`).** The route validates `{ email }` with Zod, resolves `requestPasswordReset` from the request's DI scope, and always replies `204`. Inside `RequestPasswordReset.execute`:

1. **Resolve the account — silently.** The input is parsed into the `Email` value object and looked up with `userRepository.findByEmail`. Unlike `findById`, `findByEmail` does **not** exclude soft-deleted users — _soft-deleted_ meaning the row survives with `deletedAt` set rather than being removed ([User CRUD](./user-crud.md)) — so the use case checks `user.isDeleted` itself; an unknown email and a deleted account's email both return without error, indistinguishable from success. Pending (never-verified) and inactive users are deliberately _not_ excluded — either can still prove mailbox ownership, though only the pending case ends in restored access.
2. **Issue a token.** `PasswordResetTokenIssuer.issue(user.id, now)` asks the `OpaqueTokenService` port to `generate()` a raw **opaque** token — opaque meaning a random string that carries no readable payload of its own and is meaningless without the database row it points at, unlike a self-describing signed JWT. The `CryptoOpaqueTokenService` adapter returns 32 random bytes as a 43-character base64url string, 256 bits of entropy. The issuer then builds a `PasswordResetToken` entity via `PasswordResetToken.issue`, storing only `tokenHash` (the SHA-256 hex of the raw token) and `expiresAt = now + ttlSeconds × 1000`, with `ttlSeconds` coming from `PasswordResetConfig` (env `PASSWORD_RESET_TOKEN_TTL`). The raw token is returned alongside the entity and is never persisted.
3. **Supersede, then store — atomically.** Both writes happen inside one `unitOfWork.run`. On the `passwordResetTokenRepository` the callback hands it, the use case calls `invalidateAllForUser(user.id, now)` — which stamps `usedAt` on every still-unused token the user has — then `create(token)`. At most one live token exists per user, and it is always the newest one; requesting again quietly kills the earlier link.
4. **Enqueue the email after the commit.** Once the transaction has committed, `jobQueue.enqueue(SEND_PASSWORD_RESET_EMAIL_JOB, payload)` runs with payload `{ email, token: rawToken }` — the only place the raw token leaves the process.
5. **The worker sends the mail.** The BullMQ worker routes `email.send-password-reset` to `SendPasswordResetEmailHandler`, which builds `${PASSWORD_RESET_URL_BASE}?token=${encodeURIComponent(payload.token)}`, renders subject, plain-text, and HTML bodies with the pure `renderPasswordResetEmail(resetUrl)`, and sends through the `EmailSender` port (`NodemailerEmailSender` over SMTP). Queue and worker mechanics are the shared transport described in [Background Jobs](./background-jobs.md); the SMTP adapter and its configuration are described in [Email Sending](./email-sending.md).

> **The same name is not the same object.** `unitOfWork.run` hands its callback a `TransactionContext` (`src/application/shared/ports/unit-of-work.ts`) of **transaction-scoped repository handles**, freshly constructed against the open Prisma transaction. They are distinct objects from the identically named repositories a use case receives through its constructor, which write on their own connection outside any transaction — see [Unit of Work](./unit-of-work.md). So the `passwordResetTokenRepository` destructured from the callback is the transactional handle; a write placed outside the callback silently escapes the transaction while still compiling and still appearing to use "the same" collaborator. Both use cases in this feature follow that pattern.

**Redeeming it (`POST /v1/auth/reset-password`).** No frontend ships in this repository. `PASSWORD_RESET_URL_BASE` points at whatever page the integrator hosts; that page reads the `token` query parameter, collects a new password, and posts `{ token, newPassword }`. The backend's contract ends at this endpoint. Inside `ResetPassword.execute`:

1. **Look up by hash.** The presented token is hashed with `opaqueTokenService.hash` and looked up via `findByTokenHash` against the unique `tokenHash` column. This read runs on the **injected** `passwordResetTokenRepository`, outside any transaction. No row → `PasswordResetTokenInvalidError` → `400` with code `PASSWORD_RESET_TOKEN_INVALID`.
2. **Resolve the user before spending the token.** `userRepository.findById(resetToken.userId)` excludes soft-deleted users; a missing user raises the same `PasswordResetTokenInvalidError`, and because the lookup happens before `consume`, the token is rejected without being marked used. (Why that ordering is deliberate is in Design decisions below.)
3. **Consume.** `resetToken.consume(now)` enforces single use inside the domain entity: an already-used token throws `PasswordResetTokenInvalidError`; a `now` at or past `expiresAt` throws `PasswordResetTokenExpiredError` (`400`, code `PASSWORD_RESET_TOKEN_EXPIRED`); otherwise the entity stamps `usedAt = now` and touches `updatedAt`.
4. **Change the password — and maybe activate.** The new password is hashed through the `PasswordHasher` port (`Argon2PasswordHasher`) and applied with `user.changePassword(newPasswordHash, now)`. If the user `isPending`, the reset also calls `user.activate(now)`. A deliberately deactivated account keeps its status, which makes that case a dead end rather than a recovery: the password changes, the caller still gets a `204`, and login still fails — see Design decisions.
5. **Persist atomically.** One `unitOfWork.run` saves the user and updates the token row together, so a token is never burned without the password change landing, and vice versa. Both writes go through the transaction-scoped `userRepository` and `passwordResetTokenRepository` destructured from the callback.
6. **Revoke every session — asynchronously.** After the commit the use case enqueues `REVOKE_USER_SESSIONS_JOB` (`auth.revoke-user-sessions`) with `{ userId: user.id }`. The worker's `RevokeUserSessionsHandler` calls `refreshTokenRepository.revokeAllForUser(payload.userId, now)`, ending every existing session (see [Authentication](./authentication.md)).

**Cleanup.** Consumed and expired rows are not deleted inline. `PasswordResetTokenRetentionTask` (resource label `password_reset_tokens`) is one of the `RetentionTask`s handed to `EnforceDataRetentionJob`, which the worker schedules every `DATA_RETENTION_INTERVAL_MS` (hourly) in `src/start-worker.ts`. On each sweep it delegates to `passwordResetTokenRepository.deleteExpired(cutoff)` — a `deleteMany` where `expiresAt < cutoff` — so a row is pruned once it has been expired for the full retention window (`DATA_RETENTION_TTL`, 30 days by default). See [Data Retention](./data-retention.md).

## Architecture

The domain layer owns the security invariant, not the plumbing: `PasswordResetToken` encodes "single use, before expiry" in `consume`, and `PasswordResetTokenRepository` is the persistence _interface_, defined next to the entity. The application layer orchestrates both flows exclusively through ports — `OpaqueTokenService`, `PasswordHasher`, `UnitOfWork`, `JobQueue`, `EmailSender`, `Clock`, `IdGenerator` — so `RequestPasswordReset` and `ResetPassword` name no Prisma model, BullMQ queue, or SMTP transport. Infrastructure supplies the adapters (Prisma repository and mapper, `node:crypto` token service, Nodemailer sender, retention task), and presentation contributes only two route declarations. Every concrete is bound to its abstraction in the composition root: the per-module registration maps under `src/composition/**` (`authRegistrations`, `persistenceRegistrations`, `jobsRegistrations`, `retentionRegistrations`), merged by `createRegistrations` in `src/composition/compose.ts` and handed to the Awilix container by `createAppContainer` in `src/container.ts`. Dependencies point inward throughout.

| Component                                                          | Layer            | Responsibility                                                                                                                                                             | File                                                                         |
| ------------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `PasswordResetToken`                                               | Domain           | Token entity: `issue` creates it unused; `consume(now)` enforces single use before expiry and stamps `usedAt`                                                              | `src/domain/password-reset/password-reset-token-entity.ts`                   |
| `PasswordResetTokenRepository`                                     | Domain           | Persistence interface: `create`, `update`, `findByTokenHash`, `invalidateAllForUser`, `deleteExpired`                                                                      | `src/domain/password-reset/password-reset-token-repository.ts`               |
| `PasswordResetTokenInvalidError`, `PasswordResetTokenExpiredError` | Domain           | `ValidationError` subclasses carrying the stable codes `PASSWORD_RESET_TOKEN_INVALID` / `PASSWORD_RESET_TOKEN_EXPIRED`                                                     | `src/domain/password-reset/password-reset-errors.ts`                         |
| `RequestPasswordReset`                                             | Application      | Forgot-password use case: silent account resolution, supersede-and-store in one transaction, email job enqueue                                                             | `src/application/auth/request-password-reset.ts`                             |
| `ResetPassword`                                                    | Application      | Reset use case: hash lookup, consume, change password, activate a pending user, enqueue session revocation                                                                 | `src/application/auth/reset-password.ts`                                     |
| `PasswordResetTokenIssuer`                                         | Application      | Mints the raw token and the hashed entity with an expiry derived from the configured TTL                                                                                   | `src/application/auth/password-reset-token-issuer.ts`                        |
| `PasswordResetConfig`                                              | Application      | Config shape `{ ttlSeconds }` the issuer consumes; bound from env in `authRegistrations`                                                                                   | `src/application/auth/password-reset-config.ts`                              |
| `renderPasswordResetEmail`                                         | Application      | Pure function producing the email's subject, text, and HTML around the reset URL                                                                                           | `src/application/auth/password-reset-email-content.ts`                       |
| `SEND_PASSWORD_RESET_EMAIL_JOB` / `SendPasswordResetEmailPayload`  | Application      | Job name `email.send-password-reset` and payload `{ email, token }` — the only carrier of the raw token                                                                    | `src/application/jobs/send-password-reset-email-job.ts`                      |
| `SendPasswordResetEmailHandler`                                    | Application      | Worker-side consumer: build the reset URL, render it, send through the `EmailSender` port                                                                                  | `src/application/jobs/send-password-reset-email-handler.ts`                  |
| `REVOKE_USER_SESSIONS_JOB` / `RevokeUserSessionsPayload`           | Application      | Job name `auth.revoke-user-sessions` and payload `{ userId }` — a general-purpose contract, not reset-specific                                                             | `src/application/jobs/revoke-user-sessions-job.ts`                           |
| `RevokeUserSessionsHandler`                                        | Application      | Worker-side consumer: revokes all of a user's refresh tokens at the current instant                                                                                        | `src/application/jobs/revoke-user-sessions-handler.ts`                       |
| `PrismaPasswordResetTokenRepository`                               | Infrastructure   | Repository adapter over the `password_reset_tokens` table; `invalidateAllForUser` is an `updateMany` stamping `usedAt` on unused rows                                      | `src/infrastructure/persistence/prisma-password-reset-token-repository.ts`   |
| `toDomain` / `toPersistence`                                       | Infrastructure   | Row ↔ entity mapping; the table has no soft-delete column, so hydration fixes `deletedAt: null` and `toPersistence` emits no such key                                      | `src/infrastructure/persistence/prisma-password-reset-token-mapper.ts`       |
| `PasswordResetToken` model                                         | Infrastructure   | Table `password_reset_tokens`: `token_hash VarChar(64)` **unique**, nullable `used_at`, indexes on `[userId]` and `[expiresAt]`, `onDelete: Cascade` from `User`           | `prisma/schema.prisma`                                                       |
| `CryptoOpaqueTokenService`                                         | Infrastructure   | `OpaqueTokenService` adapter: 256-bit base64url `generate`, deterministic SHA-256 hex `hash`                                                                               | `src/infrastructure/security/crypto-opaque-token-service.ts`                 |
| `PasswordResetTokenRetentionTask`                                  | Infrastructure   | `RetentionTask` (resource `password_reset_tokens`) delegating to `deleteExpired` on the retention sweep                                                                    | `src/infrastructure/persistence/password-reset-token-retention-task.ts`      |
| `authRoutes`                                                       | Presentation     | Validate bodies with Zod, resolve the use cases from `request.diScope.cradle`, reply `204`                                                                                 | `src/presentation/http/routes/auth-routes.ts`                                |
| Registration maps                                                  | Composition root | Bind repository, config, issuer, use cases, and both job handlers; file the handlers into the worker's handler record and add the retention task to the sweep's task list  | `src/composition/{auth,persistence,jobs,retention}.ts`                       |
| `createRegistrations` / `createAppContainer`                       | Composition root | Merge every module's map into one `CompleteRegistrations` object and register it on a container built from `APP_CONTAINER_OPTIONS` (`InjectionMode.PROXY`, `strict: true`) | `src/composition/compose.ts`, `src/container.ts`, `src/container-options.ts` |

## Public surface

### HTTP endpoints

Both endpoints live under the `/v1/auth` prefix, are tagged `Auth` in the OpenAPI document (an `onRoute` hook in `authRoutes` stamps the tag on every route in the plugin), and are public but rate-limited (`max: env.RATE_LIMIT_AUTH_MAX`, `timeWindow: env.RATE_LIMIT_WINDOW` — default 5 per minute). Errors surface in the standard envelope; the codes below appear as `error.code`.

| Method | Path                       | Auth                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/forgot-password` | Public (rate-limited) | Body `{ email }`. Start recovery. Always `204`, whether or not the email maps to a live account; `400 VALIDATION` only for a malformed body; `429 RATE_LIMITED` over budget. For a real, non-deleted account it supersedes any earlier token and emails a fresh reset link.                                                                                                                                                                                                                  |
| `POST` | `/v1/auth/reset-password`  | Public (rate-limited) | Body `{ token, newPassword }` (password 8–128 chars). Redeem the link and set the new password. `204` on success (all sessions are then revoked via a background job). `400 VALIDATION` for a malformed body; `400 PASSWORD_RESET_TOKEN_INVALID` for an unknown, already-used, or superseded token, or one whose owner was soft-deleted; `400 PASSWORD_RESET_TOKEN_EXPIRED` past the TTL; `409 STALE_AGGREGATE` if a concurrent write moved the user row on; `429 RATE_LIMITED` over budget. |

The `429` body is not special-cased here: `rateLimitOptions` (`src/presentation/http/security.ts`) builds a `FastifyError` carrying `statusCode` and `code = 'RATE_LIMITED'`, and the central error handler renders it in the same `error` envelope as every other client error — see [HTTP Infrastructure](./http-infrastructure.md).

`409 STALE_AGGREGATE` is the one status a client can usefully retry on, so it is worth spelling out. The user row carries a `version` that `userRepository.save` checks on every update ([User CRUD](./user-crud.md), [Domain Events](./domain-events.md)); if a simultaneous write to the same user lands first, the version-guarded update matches no row and `save` raises `StaleAggregateError`. The transaction rolls back, which leaves the token unspent — so the caller may post the same link again.

Neither endpoint returns a body on success, and `forgot-password` never reveals whether an account exists — clients should show "if that address has an account, an email is on its way" regardless.

One caveat for anyone consuming the generated API reference: both routes declare only `schema: { body: … }` — unlike `/register`, `/login`, and `/verify-email`, neither declares a `response` map, so Fastify applies no response serializer and the error handler's envelope is sent through unfiltered. The statuses and error codes stated above are **runtime behaviour**, produced by the handlers and the central error handler (`src/presentation/http/error-handler.ts`, which maps `ErrorKind.Validation` to `400` and `ErrorKind.Conflict` to `409`), but they are not part of the OpenAPI document, so generated clients will not see them. Declaring a `response` map on each route — as `/verify-email` does with the shared `errorResponse` schema — would close that gap.

### Job contract

Producers and the worker meet at `src/application/jobs/send-password-reset-email-job.ts`:

```ts
export const SEND_PASSWORD_RESET_EMAIL_JOB = 'email.send-password-reset';

export interface SendPasswordResetEmailPayload {
  email: string;
  token: string;
}
```

`token` is the raw opaque token; this payload is the only place it exists outside the recipient's inbox.

The revocation job is deliberately not reset-specific — anything that must end a user's sessions can enqueue it (`src/application/jobs/revoke-user-sessions-job.ts`):

```ts
export const REVOKE_USER_SESSIONS_JOB = 'auth.revoke-user-sessions';

export interface RevokeUserSessionsPayload {
  userId: string;
}
```

### Ports

The feature defines one application-layer port, `OpaqueTokenService` (`src/application/shared/ports/opaque-token-service.ts`) — the abstraction behind both halves of the token: the secret that is mailed and the digest that is stored.

```ts
export interface OpaqueTokenService {
  generate(): string;

  hash(raw: string): string;
}
```

`CryptoOpaqueTokenService` is its `node:crypto` adapter. `hash` must stay deterministic — the reset lookup depends on hashing the presented token to the same value the row holds — and both flows call it: the issuer at mint time, `ResetPassword` at redemption.

### Repository interface

Persistence is programmed against the domain interface, never the Prisma adapter (`src/domain/password-reset/password-reset-token-repository.ts`):

```ts
export interface PasswordResetTokenRepository {
  create(token: PasswordResetToken): Promise<void>;

  update(token: PasswordResetToken): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null>;

  invalidateAllForUser(userId: string, now: Date): Promise<void>;

  deleteExpired(cutoff: Date): Promise<number>;
}
```

### Issuer

A component that needs to start a reset cycle programs against `PasswordResetTokenIssuer` (`src/application/auth/password-reset-token-issuer.ts`) — a concrete application-layer class, injected by name — rather than against the token primitives:

```ts
export interface IssuedPasswordResetToken {
  token: PasswordResetToken;
  rawToken: string;
}

export declare class PasswordResetTokenIssuer {
  issue(userId: string, now: Date): IssuedPasswordResetToken;
}
```

`issue` returns a brand-new, unpersisted `PasswordResetToken` alongside its `rawToken`; the caller is responsible for `create`-ing it (and, if it wants the one-live-token invariant, for calling `invalidateAllForUser` first, in the same transaction).

## Configuration

Read from `src/config/env.ts`; `.env.example` mirrors the two password-reset keys verbatim.

| Variable                   | Default                                                                        | Meaning                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_RESET_TOKEN_TTL` | `1800` (`60 * 30`, 30 minutes, in seconds)                                     | Token lifetime. Bound to `passwordResetConfig.ttlSeconds` in `src/composition/auth.ts`; the issuer computes `expiresAt = now + ttlSeconds × 1000`, and `consume` treats the expiry instant itself as already expired.                                                                                                                                               |
| `PASSWORD_RESET_URL_BASE`  | `http://localhost:5173/reset-password` (dev/test only; required in production) | The URL of the reset page you host — no such page ships in this repository. `SendPasswordResetEmailHandler` appends the raw token as `?token=<url-encoded>`. Bound to `passwordResetUrlBase` in `src/composition/auth.ts` and injected into the handler; the SMTP leg that delivers the message is [Email Sending](./email-sending.md).                             |
| `DATA_RETENTION_TTL`       | `2592000` (30 days, in seconds)                                                | Prune cutoff `PasswordResetTokenRetentionTask` applies to `password_reset_tokens`: a row survives until `expiresAt` is older than that window — see [Data Retention](./data-retention.md).                                                                                                                                                                          |
| `RATE_LIMIT_AUTH_MAX`      | `5`                                                                            | Per-route request cap applied to both endpoints; the stricter budget shared with the other credential-bearing `/auth` routes — `/register`, `/login`, and `/verify-email` ([Authentication](./authentication.md), [Email Verification](./email-verification.md)). `/refresh`, `/logout`, and `/me` declare no route-level tier and fall back to the global limiter. |
| `RATE_LIMIT_WINDOW`        | `1 minute`                                                                     | Length of that window; also the global limiter's window, and shared with those same five credential-bearing `/auth` routes.                                                                                                                                                                                                                                         |

Further keys are read elsewhere but govern this feature's code path: SMTP transport settings (`SMTP_HOST`, `EMAIL_FROM`, …) belong to [Email Sending](./email-sending.md); queue settings (`REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_CONCURRENCY`) to [Background Jobs](./background-jobs.md); the sweep interval `DATA_RETENTION_INTERVAL_MS` to [Data Retention](./data-retention.md).

## Usage & extension

**The client flow.** Request a reset:

```bash
curl -i -X POST http://localhost:8000/v1/auth/forgot-password \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com"}'
```

The reply is `204` either way. If the account exists, the worker sends the mail through the dev SMTP defaults, which point at the local Mailpit catcher (SMTP on port 1025). Open Mailpit's web UI at `http://localhost:8025`, open the message, and copy the `token` query parameter out of the link — the link itself points at `http://localhost:5173/reset-password?token=<raw-token>`, and nothing in this repository listens on that port, because the reset page is the integrator's to host. Paste the token into the second call:

```bash
curl -i -X POST http://localhost:8000/v1/auth/reset-password \
  -H 'content-type: application/json' \
  -d '{"token":"<raw-token-from-the-link>","newPassword":"BrandNewPass1"}'
```

`204` — the old password stops working immediately, and every existing session is revoked as soon as the worker processes `auth.revoke-user-sessions`.

**Tuning.** `PASSWORD_RESET_TOKEN_TTL` shortens or lengthens the link's validity; it is a security knob, not a convenience one — see the trade-off in Design decisions before moving it. `PASSWORD_RESET_URL_BASE` points the link at a different page. The email copy is the single pure function `renderPasswordResetEmail` in `src/application/auth/password-reset-email-content.ts` — edit it there and its unit test alongside.

**Adding a post-reset side effect.** The established pattern for "something extra must happen after a successful reset" is a new queued job, mirroring `RevokeUserSessionsHandler` — for example, notifying the user that their password changed. Declare the job name and payload in `src/application/jobs/`, implement the `JobHandler` beside it, add the name to `JOB_NAMES` in `src/job-catalogue.ts`, and wire the handler in the three places in `src/composition/jobs.ts` where the existing handlers appear (the module's slice of the `Cradle` interface — the union of every injectable name — the `jobsRegistrations` map, and the `jobWorker` factory). The full walkthrough with snippets is in [Background Jobs](./background-jobs.md).

Two details save a confusing compile error. The catalogue must learn the name **before** the composition root does: `toJobHandlerList` takes a `JobHandlersByName`, a mapped type over the `JOB_NAMES` tuple, so it is exhaustive by construction, and adding an entry to the worker's handler record for a name the tuple does not carry is `TS2353` — "Object literal may only specify known properties".

```ts
export type JobHandlersByName = {
  readonly [TJobName in JobName]: JobHandler<unknown, TJobName>;
};
```

And the check runs from the other side too: `src/job-catalogue.test.ts` scans the source for every handler's `readonly jobName` and fails if `JOB_NAMES` omits one.

Only the final step is specific to this feature — enqueue from `ResetPassword.execute`, after the existing revocation enqueue (the `User` entity's `email` getter returns the `Email` value object, hence `toString()`):

```ts
await this.queue.enqueue(SEND_PASSWORD_CHANGED_EMAIL_JOB, { email: user.email.toString() });
```

Nothing else changes — not the worker, not the routes, not the domain: `toJobHandlerList` flattens the handler record into the `handlers` array `JobWorker` indexes by `jobName`, so the new handler is routed on the next boot.

## Design decisions & trade-offs

- **An opaque random token stored as a SHA-256 hash — not a signed JWT link.** Server-side state is what makes the guarantees possible: single use (`usedAt`), supersession on re-request (`invalidateAllForUser`), and a database that never holds a redeemable secret. A stateless signed link could carry expiry but could not be burned after use or superseded without a denylist — which is the same state this design keeps, minus the indirection.
- **Single use plus a short TTL bound the replay window.** A reset link is a bearer credential delivered over a channel nobody controls: it sits in the mailbox, in browser history, and in whatever scanners and proxy logs it crossed. Burning it on redemption and expiring it on a clock are what limit how long an intercepted or merely lingering copy stays redeemable. Raising `PASSWORD_RESET_TOKEN_TTL` widens that window; lowering it strands users who read mail late and drives them to request again. The `1800`-second default sits at that balance.
- **Deterministic SHA-256 for the token, Argon2 only for passwords.** The raw token carries 256 bits of entropy (`randomBytes(32)`), so brute-forcing its hash is infeasible and a slow, salted hash would add nothing — while determinism is required for the O(1) lookup on the unique `tokenHash` column. Passwords are low-entropy and human-chosen; they get `Argon2PasswordHasher`.
- **Uniform `204` on `forgot-password`, with an explicit soft-delete check.** Success, unknown email, and deleted account are indistinguishable to the caller, so the endpoint cannot enumerate accounts. Because `findByEmail` does not filter `deletedAt` (unlike `findById`), `RequestPasswordReset` repeats the `user.isDeleted` check itself. The cost — a user who typos their address gets no feedback — is accepted; the auth rate limit bounds both probing and mail-bombing.
- **Pending users are included and a successful reset activates them; inactive users stay inactive, which makes that case a dead end.** The mailed link proves mailbox ownership at least as strongly as the code [Email Verification](./email-verification.md) would otherwise demand, so it also clears a never-verified account's pending status instead of stranding it. A deliberate deactivation is an administrative decision this flow refuses to silently undo. The consequence is worth stating plainly: an inactive account's reset succeeds — `204`, new password stored — but does not restore access, because `Login.execute` (`src/application/auth/login.ts`) rejects any user for whom `isActive` is false (`status === UserStatus.Active`) with `InvalidCredentialsError` (`401`, code `INVALID_CREDENTIALS`). Reactivation is an administrative action.
- **Supersede-then-create in one transaction: at most one live token per user.** `invalidateAllForUser` before `create`, inside one `unitOfWork.run`, means the newest link is the only valid one and tokens cannot accumulate. A user who requests twice and clicks the older email gets `PASSWORD_RESET_TOKEN_INVALID` — a small usability cost for a smaller attack surface.
- **The single-use invariant lives in the domain entity, not the repository query.** `consume` throws on reuse and on expiry (the expiry instant itself counts as expired) and stamps `usedAt`, so no caller can redeem a token without passing the guard, and the rule is unit-testable without a database.
- **The user is resolved before the token is consumed.** In `ResetPassword`, `findById`'s soft-delete filter rejects a token whose owner was deleted after issuance — reported as the indistinct `PASSWORD_RESET_TOKEN_INVALID`, and _before_ `consume`, so the rejection does not spend the token. Soft-deleted users are not cascade-removed (the schema's `onDelete: Cascade` fires only on physical deletion), so this lookup is the guard that a stale link cannot reactivate a deleted account.
- **Reads run on the injected repositories; writes run on the transaction-scoped ones.** Both flows do their lookups and pure domain work first, then open the shortest possible transaction containing only writes ([Unit of Work](./unit-of-work.md)). The trap this creates is naming — the handle from the callback shares its name with the injected repository but is a different object — which is why it gets a callout in "How it works" rather than a footnote.
- **The reset token row is not version-guarded, unlike the user aggregate.** `PasswordResetToken` extends the plain `Entity` base with no `version` prop, so `update` is a straight Prisma write; the single-use guarantee comes from `consume` plus the fact that a redemption is the token's last write. `userRepository.save` does carry optimistic concurrency, which is why a concurrent edit of the same user can surface as `409 STALE_AGGREGATE` on a reset.
- **Email delivery and session revocation ride the job queue, enqueued only after the commit.** The HTTP path never blocks on SMTP or bulk token updates, a rolled-back transaction never mails a link that does not exist in the database or revokes sessions for a password change that did not land, and the worker retries transient failures — both handlers deliberately propagate errors, and `revokeAllForUser` is naturally idempotent so retries are safe. Two accepted costs: the raw token transits Redis inside the job payload, and there is a short window after a reset before revocation lands, during which an old refresh token still works.
- **Session revocation is a general contract, not a reset detail.** `REVOKE_USER_SESSIONS_JOB` takes only `{ userId }`, so any future flow that must sign a user out everywhere — an admin lockout, a suspected-compromise sweep — reuses the same job and handler rather than duplicating the revoke.
- **Distinct `INVALID` and `EXPIRED` codes.** Expiry is the one failure the legitimate user can act on (request a new link), so it is worth disclosing; it tells an attacker nothing useful, since the message only appears to someone already holding the actual token.
- **Rows are pruned by the shared retention sweep, not inline.** Redemption marks a token used but leaves the row (a short-lived audit trail); `PasswordResetTokenRetentionTask` deletes rows once `expiresAt` is older than the retention cutoff. Reusing the [Data Retention](./data-retention.md) mechanism keeps this feature free of its own scheduler.

## Testing

**Unit tests** (Vitest with fakes, no database or Redis) sit beside each source file and run with `npm test` (`vitest run`):

- `src/domain/password-reset/password-reset-token-entity.test.ts` — a freshly issued token starts unused with both timestamps from one instant; the expiry boundary (the `expiresAt` instant itself is expired); a second `consume` on the same in-memory entity is rejected, not just a reload of a used row.
- `src/application/auth/password-reset-token-issuer.test.ts` — the entity carries only the hash of a freshly generated raw token, never the raw token itself; expiry derives from the configured TTL.
- `src/application/auth/request-password-reset.test.ts` — invalidate-before-create ordering inside a single transaction; the raw token (not the hash) reaches the job payload; enqueue happens after the commit and not at all when the transaction fails; pending users still get a token; unknown and soft-deleted emails are silent no-ops.
- `src/application/auth/reset-password.test.ts` — the presented token is hashed before lookup; the new password is saved and the token marked used; pending users are activated while deactivated users stay inactive; unknown, expired, and already-used tokens are rejected without writes; a soft-deleted owner is rejected _without_ consuming the token; revocation is enqueued only after a successful commit.
- `src/application/auth/password-reset-email-content.test.ts` — the URL reaches both bodies but never the subject (subjects leak into notification previews), and rendering is pure.
- `src/application/jobs/send-password-reset-email-handler.test.ts` — one message per payload address; the link is built from the configured base; a token containing URL-sensitive characters is percent-encoded; delivery failures propagate for worker retry.
- `src/application/jobs/revoke-user-sessions-handler.test.ts` — revokes at the injected clock's instant and propagates failures, which is safe because the revoke is naturally idempotent.
- `src/infrastructure/security/crypto-opaque-token-service.test.ts` — 43-character base64url generation, unique across successive calls; 64-character deterministic lowercase-hex hashing (the width `token_hash VarChar(64)` expects).
- `src/infrastructure/persistence/password-reset-token-retention-task.test.ts` — names its resource and delegates `prune(cutoff)` to `deleteExpired`, returning the count.

**Integration test** — `test/integration/password-reset.int.test.ts` drives both endpoints through the real app and database.

The containers are not the harness's doing: `test/integration/global-setup.ts`, registered as `globalSetup` in `vitest.integration.config.ts`, starts the MariaDB and Redis testcontainers once for the whole run and applies the migrations. `createHarness` (`test/integration/support/harness.ts`) only calls `createAppContainer`, replaces individual cradle entries with `asValue`, and builds the app. This suite replaces `jobQueue` with a `CapturingJobQueue`, because the raw token is never persisted — the captured job payload is the only place a test can read it, and the substitution also keeps the suite off the real BullMQ worker. What it covers:

- the `tokenHash` stored in the database differs from the token that reaches the job payload;
- silent `204`s for an unregistered email and for a soft-deleted user, with no job captured;
- supersession end to end — a repeat request invalidates the first token, and only the second redeems;
- a successful reset that enqueues `REVOKE_USER_SESSIONS_JOB` and swaps which password logs in;
- pending-user activation, observable by logging in afterwards;
- `400`s with the exact error codes for expired, replayed, unknown, and deleted-owner tokens;
- `400`s for malformed bodies on both endpoints.

Run it with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`); it requires Docker for the testcontainers.
