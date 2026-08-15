# Password Reset

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `5156995`

## Purpose

A user who forgets their password has no way back in: login needs the password, and every other credentialed path needs a session. This feature is the self-service recovery route — the user proves they still control the account's mailbox by clicking an emailed, single-use, time-limited link, then chooses a new password. The request endpoint answers identically whether or not the address maps to an account, so it cannot be used to enumerate accounts. The database stores only a SHA-256 hash of the token, so a leaked row yields no working reset link, and a successful reset revokes every existing session rather than leaving a suspect credential signed in.

## How it works

Two anonymous HTTP endpoints and one email make up the flow: `POST /v1/auth/forgot-password` mails a link, and `POST /v1/auth/reset-password` redeems the token carried in that link. Both reply `204` and carry no auth guard — the caller, by definition, cannot authenticate — and both share the stricter auth-endpoint rate limit (`RATE_LIMIT_AUTH_MAX` requests per `RATE_LIMIT_WINDOW`).

Those full paths assemble in three files: both routes are declared in `authRoutes` (`src/presentation/http/routes/auth-routes.ts`), which `apiV1Routes` (`src/presentation/http/routes/api-v1-routes.ts`) mounts under `/auth`, itself registered at `API_V1_PREFIX` (`/v1`) in `src/presentation/http/app.ts`.

**Requesting a reset (`POST /v1/auth/forgot-password`).** The route validates `{ email }` with Zod, resolves `requestPasswordReset` from the request's DI scope, and always replies `204`. Inside `RequestPasswordReset.execute`:

1. **Resolve the account — silently.** The input is parsed into the `Email` value object and looked up with `userRepository.findByEmail`. Unlike `findById`, `findByEmail` does **not** exclude soft-deleted users, so the use case checks `user.isDeleted` itself; an unknown email and a deleted account's email both return without error, indistinguishable from success. Pending (never-verified) and inactive users are deliberately _not_ excluded — either can still prove mailbox ownership, though only the pending case ends in restored access (what happens to each on redemption is below).
2. **Issue a token.** `PasswordResetTokenIssuer.issue(user.id, now)` asks the `OpaqueTokenService` port to `generate()` a raw **opaque** token — opaque meaning a random string that carries no readable payload of its own and is meaningless without the database row it points at, unlike a self-describing signed JWT. The `CryptoOpaqueTokenService` adapter returns 32 random bytes as a 43-character base64url string, 256 bits of entropy. The issuer then builds a `PasswordResetToken` entity via `PasswordResetToken.issue`, storing only `tokenHash` (the SHA-256 hex of the raw token) and `expiresAt = now + ttlSeconds × 1000`, with `ttlSeconds` coming from `PasswordResetConfig` (env `PASSWORD_RESET_TOKEN_TTL`). The raw token is returned alongside the entity and is never persisted.
3. **Supersede, then store — atomically.** Both writes happen inside one `unitOfWork.run`. Note what `run` hands its callback: a `TransactionContext` (`src/application/shared/ports/unit-of-work.ts`) of **transaction-scoped repository handles**, freshly constructed against the open Prisma transaction. They are distinct objects from the identically named repositories a use case receives through its constructor, which write on their own connection outside any transaction — see [unit of work](./unit-of-work.md). So the `passwordResetTokenRepository` destructured from the callback here is the transactional handle, and on it the use case calls `invalidateAllForUser(user.id, now)` — which stamps `usedAt` on every still-unused token the user has — then `create(token)`. At most one live token exists per user, and it is always the newest one; requesting again quietly kills the earlier link.
4. **Enqueue the email after the commit.** `jobQueue.enqueue(SEND_PASSWORD_RESET_EMAIL_JOB, payload)` runs after the transaction, with payload `{ email, token: rawToken }` — the only place the raw token leaves the process. A rolled-back transaction therefore never emails a link that does not exist in the database.
5. **The worker sends the mail.** The BullMQ worker routes `email.send-password-reset` to `SendPasswordResetEmailHandler`, which builds `${PASSWORD_RESET_URL_BASE}?token=${encodeURIComponent(payload.token)}`, renders subject, plain-text, and HTML bodies with the pure `renderPasswordResetEmail(resetUrl)`, and sends through the `EmailSender` port (`NodemailerEmailSender` over SMTP). Queue and worker mechanics are the shared transport described in [background jobs](./background-jobs.md); the SMTP adapter and its configuration are described in [email sending](./email-sending.md).

**Redeeming it (`POST /v1/auth/reset-password`).** The frontend page at `PASSWORD_RESET_URL_BASE` reads the `token` query parameter, collects a new password, and posts `{ token, newPassword }`. Inside `ResetPassword.execute`:

1. **Look up by hash.** The presented token is hashed with `opaqueTokenService.hash` and looked up via `findByTokenHash` against the unique `tokenHash` column. This read runs on the **injected** `passwordResetTokenRepository`, outside any transaction. No row → `PasswordResetTokenInvalidError` → `400` with code `PASSWORD_RESET_TOKEN_INVALID`.
2. **Resolve the user before spending the token.** `userRepository.findById(resetToken.userId)` excludes soft-deleted users, which is what stops a link issued _before_ an account's deletion from reactivating it. A missing user raises the same `PasswordResetTokenInvalidError` — and because this happens before `consume`, the token is rejected without being marked used.
3. **Consume.** `resetToken.consume(now)` enforces single use inside the domain entity: an already-used token throws `PasswordResetTokenInvalidError`; a `now` at or past `expiresAt` throws `PasswordResetTokenExpiredError` (`400`, code `PASSWORD_RESET_TOKEN_EXPIRED`); otherwise the entity stamps `usedAt = now`.
4. **Change the password — and maybe activate.** The new password is hashed through the `PasswordHasher` port (Argon2 adapter) and applied with `user.changePassword(newPasswordHash, now)`. If the user `isPending`, the reset also calls `user.activate(now)`: a clicked, mailed link proves mailbox ownership at least as strongly as the code [email verification](./email-verification.md) would otherwise demand. A deliberately deactivated account keeps its status. That case is a dead end rather than a recovery: the password changes but the account stays inactive, so the caller still gets a `204` and then cannot log in, because `Login.execute` (`src/application/auth/login.ts`) rejects any user for whom `isActive` is false — `isActive` means `status === UserStatus.Active` — with `InvalidCredentialsError` (`401`, code `INVALID_CREDENTIALS`). Reactivation is an administrative action, not something this flow performs.
5. **Persist atomically.** One `unitOfWork.run` saves the user and updates the token row together, so a token is never burned without the password change landing, and vice versa. Both writes go through the transaction-scoped `userRepository` and `passwordResetTokenRepository` destructured from the callback — the _same names_ as the injected repositories the earlier lookups used, but different objects bound to the open transaction.
6. **Revoke every session — asynchronously.** After the commit the use case enqueues `REVOKE_USER_SESSIONS_JOB` (`auth.revoke-user-sessions`) with `{ userId: user.id }`. The worker's `RevokeUserSessionsHandler` calls `refreshTokenRepository.revokeAllForUser(payload.userId, now)`, ending every existing session (see [authentication](./authentication.md)): whoever knew the old password — or holds a stolen refresh token — is signed out.

**Cleanup.** Consumed and expired rows are not deleted inline. `PasswordResetTokenRetentionTask` (resource label `password_reset_tokens`) participates in the hourly [data retention](./data-retention.md) sweep, delegating to `passwordResetTokenRepository.deleteExpired(cutoff)` — a `deleteMany` where `expiresAt < cutoff` — so a row is pruned once it has been expired for the full retention window (`DATA_RETENTION_TTL`, 30 days by default).

## Architecture

The domain layer owns the security invariant, not the plumbing: `PasswordResetToken` encodes "single use, before expiry" in `consume`, and `PasswordResetTokenRepository` is the persistence _interface_, defined next to the entity. The application layer orchestrates both flows exclusively through ports — `OpaqueTokenService`, `PasswordHasher`, `UnitOfWork`, `JobQueue`, `EmailSender`, `Clock`, `IdGenerator` — so `RequestPasswordReset` and `ResetPassword` name no Prisma model, BullMQ queue, or SMTP transport. Infrastructure supplies the adapters (Prisma repository and mapper, `node:crypto` token service, Nodemailer sender, retention task), presentation contributes only two route declarations, and every concrete is bound to its abstraction in `src/container.ts` — dependencies point inward throughout.

| Component                                                          | Layer            | Responsibility                                                                                                                                                               | File                                                                       |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PasswordResetToken`                                               | Domain           | Token entity: `issue` creates it unused; `consume(now)` enforces single use before expiry and stamps `usedAt`                                                                | `src/domain/password-reset/password-reset-token-entity.ts`                 |
| `PasswordResetTokenRepository`                                     | Domain           | Persistence interface: `create`, `update`, `findByTokenHash`, `invalidateAllForUser`, `deleteExpired`                                                                        | `src/domain/password-reset/password-reset-token-repository.ts`             |
| `PasswordResetTokenInvalidError`, `PasswordResetTokenExpiredError` | Domain           | `ValidationError` subclasses carrying the stable codes `PASSWORD_RESET_TOKEN_INVALID` / `PASSWORD_RESET_TOKEN_EXPIRED`                                                       | `src/domain/password-reset/password-reset-errors.ts`                       |
| `RequestPasswordReset`                                             | Application      | Forgot-password use case: silent account resolution, supersede-and-store in one transaction, email job enqueue                                                               | `src/application/auth/request-password-reset.ts`                           |
| `ResetPassword`                                                    | Application      | Reset use case: hash lookup, consume, change password, activate a pending user, enqueue session revocation                                                                   | `src/application/auth/reset-password.ts`                                   |
| `PasswordResetTokenIssuer`                                         | Application      | Mints the raw token and the hashed entity with an expiry derived from the configured TTL                                                                                     | `src/application/auth/password-reset-token-issuer.ts`                      |
| `PasswordResetConfig`                                              | Application      | Config shape `{ ttlSeconds }` the issuer consumes; bound from env in the container                                                                                           | `src/application/auth/password-reset-config.ts`                            |
| `renderPasswordResetEmail`                                         | Application      | Pure function producing the email's subject, text, and HTML around the reset URL                                                                                             | `src/application/auth/password-reset-email-content.ts`                     |
| `SEND_PASSWORD_RESET_EMAIL_JOB` / `SendPasswordResetEmailPayload`  | Application      | Job name `email.send-password-reset` and payload `{ email, token }` — the only carrier of the raw token                                                                      | `src/application/jobs/send-password-reset-email-job.ts`                    |
| `SendPasswordResetEmailHandler`                                    | Application      | Worker-side consumer: build the reset URL, render it, send through the `EmailSender` port                                                                                    | `src/application/jobs/send-password-reset-email-handler.ts`                |
| `REVOKE_USER_SESSIONS_JOB` / `RevokeUserSessionsPayload`           | Application      | Job name `auth.revoke-user-sessions` and payload `{ userId }` — a general-purpose contract, not reset-specific                                                               | `src/application/jobs/revoke-user-sessions-job.ts`                         |
| `RevokeUserSessionsHandler`                                        | Application      | Worker-side consumer: revokes all of a user's refresh tokens at the current instant                                                                                          | `src/application/jobs/revoke-user-sessions-handler.ts`                     |
| `PrismaPasswordResetTokenRepository`                               | Infrastructure   | Repository adapter over the `password_reset_tokens` table; `invalidateAllForUser` is an `updateMany` stamping `usedAt` on unused rows                                        | `src/infrastructure/persistence/prisma-password-reset-token-repository.ts` |
| `toDomain` / `toPersistence`                                       | Infrastructure   | Row ↔ entity mapping; the table has no soft-delete column, so hydration fixes `deletedAt: null` and `toPersistence` emits no such key                                        | `src/infrastructure/persistence/prisma-password-reset-token-mapper.ts`     |
| `PasswordResetToken` model                                         | Infrastructure   | Table `password_reset_tokens`: `token_hash VarChar(64)` **unique**, nullable `used_at`, indexes on `[userId]` and `[expiresAt]`, `onDelete: Cascade` from `User`             | `prisma/schema.prisma`                                                     |
| `CryptoOpaqueTokenService`                                         | Infrastructure   | `OpaqueTokenService` adapter: 256-bit base64url `generate`, deterministic SHA-256 hex `hash`                                                                                 | `src/infrastructure/security/crypto-opaque-token-service.ts`               |
| `PasswordResetTokenRetentionTask`                                  | Infrastructure   | `RetentionTask` (resource `password_reset_tokens`) delegating to `deleteExpired` on the retention sweep                                                                      | `src/infrastructure/persistence/password-reset-token-retention-task.ts`    |
| `authRoutes`                                                       | Presentation     | Validate bodies with Zod, resolve the use cases from the request DI scope, reply `204`                                                                                       | `src/presentation/http/routes/auth-routes.ts`                              |
| Container wiring                                                   | Composition root | Binds repository, config, issuer, use cases, and both job handlers; files the handlers into the worker's handler record and adds the retention task to the sweep's task list | `src/container.ts`                                                         |

## Public surface

### HTTP endpoints

Both endpoints live under the `/v1/auth` prefix, are tagged `Auth` in the OpenAPI document (an `onRoute` hook in `authRoutes` stamps the tag on every route in the plugin), and are public but rate-limited (`max: env.RATE_LIMIT_AUTH_MAX`, `timeWindow: env.RATE_LIMIT_WINDOW` — default 5 per minute). Errors surface in the standard envelope; the codes below appear as `error.code`.

| Method | Path                       | Auth                  | Purpose                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/forgot-password` | Public (rate-limited) | Body `{ email }`. Start recovery. Always `204`, whether or not the email maps to a live account; `400` only for a malformed body. For a real, non-deleted account it supersedes any earlier token and emails a fresh reset link.                                                                                                                   |
| `POST` | `/v1/auth/reset-password`  | Public (rate-limited) | Body `{ token, newPassword }` (password 8–128 chars). Redeem the link and set the new password. `204` on success (all sessions are then revoked via a background job). `400 PASSWORD_RESET_TOKEN_INVALID` for an unknown, already-used, or superseded token, or one whose owner was soft-deleted; `400 PASSWORD_RESET_TOKEN_EXPIRED` past the TTL. |

Neither endpoint returns a body on success, and `forgot-password` never reveals whether an account exists — clients should show "if that address has an account, an email is on its way" regardless.

One caveat for anyone consuming the generated API reference: both routes declare only `schema: { body: … }` — unlike `/register`, `/login`, and `/verify-email`, neither declares a `response` map. The statuses and error codes stated above are **runtime behaviour**, produced by the handlers and the central error handler, but they are not part of the OpenAPI document, so generated clients will not see them. Declaring a `response` map on each route — as `/verify-email` does with the shared `errorResponse` schema — would close that gap.

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

A component that needs to start a reset cycle programs against `PasswordResetTokenIssuer` (`src/application/auth/password-reset-token-issuer.ts`) rather than against the token primitives:

```ts
export interface IssuedPasswordResetToken {
  token: PasswordResetToken;
  rawToken: string;
}

issue(userId: string, now: Date): IssuedPasswordResetToken;
```

`issue` returns a brand-new, unpersisted `PasswordResetToken` alongside its `rawToken`; the caller is responsible for `create`-ing it (and, if it wants the one-live-token invariant, for calling `invalidateAllForUser` first, in the same transaction).

## Configuration

Read from `src/config/env.ts`; `.env.example` mirrors the two password-reset keys verbatim.

| Variable                   | Default                                                                        | Meaning                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_RESET_TOKEN_TTL` | `1800` (`60 * 30`, 30 minutes, in seconds)                                     | Token lifetime. Bound to `passwordResetConfig.ttlSeconds` in `container.ts`; the issuer computes `expiresAt = now + ttlSeconds × 1000`, and `consume` treats the expiry instant itself as already expired.                         |
| `PASSWORD_RESET_URL_BASE`  | `http://localhost:3000/reset-password` (dev/test only; required in production) | The frontend URL the reset email links to; `SendPasswordResetEmailHandler` appends the raw token as `?token=<url-encoded>`. Bound to `passwordResetUrlBase` in `container.ts` and consumed in [email sending](./email-sending.md). |
| `RATE_LIMIT_AUTH_MAX`      | `5`                                                                            | Per-route request cap applied to both endpoints; the stricter budget shared with the other `/auth` routes ([authentication](./authentication.md)).                                                                                 |
| `RATE_LIMIT_WINDOW`        | `1 minute`                                                                     | Length of that window; also the global limiter's window, and shared with the other `/auth` routes.                                                                                                                                 |

Three further keys are read elsewhere but govern this feature's code path. `DATA_RETENTION_TTL` (default `2592000` — 30 days, in seconds) sets the prune cutoff `PasswordResetTokenRetentionTask` applies to `password_reset_tokens`: a row survives until `expiresAt` is older than that window — see [data retention](./data-retention.md). SMTP transport settings (`SMTP_HOST`, `EMAIL_FROM`, …) belong to [email sending](./email-sending.md); queue settings (`REDIS_URL`, `QUEUE_PREFIX`, `QUEUE_CONCURRENCY`) to [background jobs](./background-jobs.md).

## Usage & extension

**The client flow.** Request a reset:

```bash
curl -i -X POST http://localhost:8000/v1/auth/forgot-password \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com"}'
```

The reply is `204` either way. If the account exists, an email arrives (with the dev SMTP defaults it lands in the local Mailpit catcher on port 1025) linking to `http://localhost:3000/reset-password?token=<raw-token>`. The frontend page reads the `token` query parameter, collects the new password, and redeems it:

```bash
curl -i -X POST http://localhost:8000/v1/auth/reset-password \
  -H 'content-type: application/json' \
  -d '{"token":"<raw-token-from-the-link>","newPassword":"BrandNewPass1"}'
```

`204` — the old password stops working immediately, and every existing session is revoked as soon as the worker processes `auth.revoke-user-sessions`.

**Tuning.** Shorten or lengthen the link's validity with `PASSWORD_RESET_TOKEN_TTL`; point the link at a different frontend route with `PASSWORD_RESET_URL_BASE`. The email copy is the single pure function `renderPasswordResetEmail` in `src/application/auth/password-reset-email-content.ts` — edit it there and its unit test alongside.

**Adding a post-reset side effect.** The established pattern for "something extra must happen after a successful reset" is a new queued job, mirroring `RevokeUserSessionsHandler`. Example: notify the user their password changed.

**Step 1 — declare the job name and payload**, `src/application/jobs/send-password-changed-email-job.ts`:

```ts
export const SEND_PASSWORD_CHANGED_EMAIL_JOB = 'email.send-password-changed';

export interface SendPasswordChangedEmailPayload {
  email: string;
}
```

**Step 2 — implement the handler**, `src/application/jobs/send-password-changed-email-handler.ts`:

```ts
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { EmailSender } from '@/application/shared/ports/email-sender';
import {
  SEND_PASSWORD_CHANGED_EMAIL_JOB,
  type SendPasswordChangedEmailPayload,
} from '@/application/jobs/send-password-changed-email-job';

export interface SendPasswordChangedEmailHandlerDeps {
  emailSender: EmailSender;
}

export class SendPasswordChangedEmailHandler implements JobHandler<
  SendPasswordChangedEmailPayload,
  typeof SEND_PASSWORD_CHANGED_EMAIL_JOB
> {
  readonly jobName = SEND_PASSWORD_CHANGED_EMAIL_JOB;
  private readonly emailSender: EmailSender;

  constructor({ emailSender }: SendPasswordChangedEmailHandlerDeps) {
    this.emailSender = emailSender;
  }

  async handle(payload: SendPasswordChangedEmailPayload): Promise<void> {
    await this.emailSender.send({
      to: payload.email,
      subject: 'Your password was changed',
      text: 'Your password was just changed. If this was not you, reset it again immediately.',
    });
  }
}
```

**Step 3 — add the job name to the catalogue**, `src/job-catalogue.ts`. Do this _before_ touching the container: `toJobHandlerList` takes a `JobHandlersByName`, a mapped type over the `JOB_NAMES` tuple (`{ readonly [T in JobName]: JobHandler<unknown, T> }`), so it is exhaustive by construction. Until the new name is in that tuple, adding its entry to the container's handler record is `TS2353` — "Object literal may only specify known properties". `src/job-catalogue.test.ts` enforces the same thing from the other side: it scans the source for every handler's `readonly jobName` and fails if `JOB_NAMES` omits one.

```ts
// in src/job-catalogue.ts — import the constant, then append it to JOB_NAMES
import { SEND_PASSWORD_CHANGED_EMAIL_JOB } from '@/application/jobs/send-password-changed-email-job';

export const JOB_NAMES = [
  EXAMPLE_JOB,
  SEND_VERIFICATION_EMAIL_JOB,
  SEND_PASSWORD_RESET_EMAIL_JOB,
  REVOKE_USER_SESSIONS_JOB,
  DATA_RETENTION_JOB,
  OUTBOX_RELAY_JOB,
  DISPATCH_DOMAIN_EVENT_JOB,
  SEND_PASSWORD_CHANGED_EMAIL_JOB,
] as const;
```

**Step 4 — wire it** in the three places in `src/container.ts` where the existing handlers appear (the `Cradle` interface, `registerDependencies`, and the `jobWorker` factory), plus the import block they share:

```ts
// at the top of src/container.ts, beside the existing handler imports
import { SendPasswordChangedEmailHandler } from '@/application/jobs/send-password-changed-email-handler';
import {
  SEND_PASSWORD_CHANGED_EMAIL_JOB,
  type SendPasswordChangedEmailPayload,
} from '@/application/jobs/send-password-changed-email-job';
```

On the `Cradle` interface, beside `revokeUserSessionsHandler` — declared by its port type, not its class:

```ts
sendPasswordChangedEmailHandler: JobHandler<
  SendPasswordChangedEmailPayload,
  typeof SEND_PASSWORD_CHANGED_EMAIL_JOB
>;
```

In `registerDependencies`, beside the other handler registrations:

```ts
sendPasswordChangedEmailHandler: asClass(SendPasswordChangedEmailHandler).singleton(),
```

And three additions inside the `jobWorker` factory — the handler must be destructured, named in the factory's `Pick<Cradle, …>` union, and filed in the handler record passed to `toJobHandlerList`. Omitting any one of them is a compile error:

```ts
// 1. in the factory's destructuring list, after revokeUserSessionsHandler
sendPasswordChangedEmailHandler,

// 2. in the factory's Pick<Cradle, ...> union, after 'revokeUserSessionsHandler'
| 'sendPasswordChangedEmailHandler'

// 3. in the handler record, after the REVOKE_USER_SESSIONS_JOB entry
[SEND_PASSWORD_CHANGED_EMAIL_JOB]: sendPasswordChangedEmailHandler,
```

**Step 5 — enqueue it** from `ResetPassword.execute`, after the existing revocation enqueue (the `User` entity's `email` getter returns the `Email` value object, hence `toString()`):

```ts
await this.queue.enqueue(SEND_PASSWORD_CHANGED_EMAIL_JOB, { email: user.email.toString() });
```

No change to the worker, the routes, or the domain — only the job catalogue and the container: `toJobHandlerList` flattens the record into the `handlers` array `JobWorker` indexes by `jobName`, so the new handler is routed on the next boot.

## Design decisions & trade-offs

- **An opaque random token stored as a SHA-256 hash — not a signed JWT link.** Server-side state is what makes the guarantees possible: single use (`usedAt`), supersession on re-request (`invalidateAllForUser`), and a database that never holds a redeemable secret. A stateless signed link could carry expiry but could not be burned after use or superseded without a denylist — which is the same state this design keeps, minus the indirection.
- **Deterministic SHA-256 for the token, Argon2 only for passwords.** The raw token carries 256 bits of entropy (`randomBytes(32)`), so brute-forcing its hash is infeasible and a slow, salted hash would add nothing — while determinism is required for the O(1) lookup on the unique `tokenHash` column. Passwords are low-entropy and human-chosen; they get `Argon2PasswordHasher`.
- **Uniform `204` on `forgot-password`, with an explicit soft-delete check.** Success, unknown email, and deleted account are indistinguishable to the caller, so the endpoint cannot enumerate accounts. Because `findByEmail` does not filter `deletedAt` (unlike `findById`), `RequestPasswordReset` repeats the `user.isDeleted` check itself. The cost — a user who typos their address gets no feedback — is accepted; the auth rate limit bounds both probing and mail-bombing.
- **Pending users are included and a successful reset activates them; inactive users stay inactive, which makes that case a dead end.** The mailed link proves mailbox ownership at least as strongly as the code [email verification](./email-verification.md) would otherwise demand, so it also clears a never-verified account's pending status instead of stranding it. A deliberate deactivation is an administrative decision this flow refuses to silently undo. The consequence is worth stating plainly: an inactive account's reset succeeds — `204`, new password stored — but does not restore access, because `Login` rejects any non-active user with `INVALID_CREDENTIALS`. Reactivation is an administrative action.
- **Supersede-then-create in one transaction: at most one live token per user.** `invalidateAllForUser` before `create`, inside one `unitOfWork.run`, means the newest link is the only valid one and tokens cannot accumulate. A user who requests twice and clicks the older email gets `PASSWORD_RESET_TOKEN_INVALID` — a small usability cost for a smaller attack surface.
- **The single-use invariant lives in the domain entity, not the repository query.** `consume` throws on reuse and on expiry (the expiry instant itself counts as expired) and stamps `usedAt`, so no caller can redeem a token without passing the guard, and the rule is unit-testable without a database.
- **The user is resolved before the token is consumed.** In `ResetPassword`, `findById`'s soft-delete filter rejects a token whose owner was deleted after issuance — reported as the indistinct `PASSWORD_RESET_TOKEN_INVALID`, and _before_ `consume`, so the rejection does not spend the token. Soft-deleted users are not cascade-removed (the schema's `onDelete: Cascade` fires only on physical deletion), so this lookup is the guard that a stale link cannot reactivate a deleted account.
- **Reads run on the injected repositories; writes run on the transaction-scoped ones.** Both flows do their lookups and pure domain work first, then open the shortest possible transaction containing only writes ([unit of work](./unit-of-work.md)). The trap this creates is naming: the handle destructured from the `unitOfWork.run` callback shares its name with the injected repository but is a different object, so a write placed outside the callback silently escapes the transaction while still compiling and still appearing to use "the same" collaborator.
- **Email delivery and session revocation ride the job queue, enqueued only after the commit.** The HTTP path never blocks on SMTP or bulk token updates, a failed transaction never triggers a side effect, and the worker retries transient failures — both handlers deliberately propagate errors, and `revokeAllForUser` is naturally idempotent so retries are safe. Two accepted costs: the raw token transits Redis inside the job payload, and there is a short window after a reset before revocation lands, during which an old refresh token still works.
- **Session revocation is a general contract, not a reset detail.** `REVOKE_USER_SESSIONS_JOB` takes only `{ userId }`, so any future flow that must sign a user out everywhere — an admin lockout, a suspected-compromise sweep — reuses the same job and handler rather than duplicating the revoke.
- **Distinct `INVALID` and `EXPIRED` codes.** Expiry is the one failure the legitimate user can act on (request a new link), so it is worth disclosing; it tells an attacker nothing useful, since the message only appears to someone already holding the actual token.
- **Rows are pruned by the shared retention sweep, not inline.** Redemption marks a token used but leaves the row (a short-lived audit trail); `PasswordResetTokenRetentionTask` deletes rows once `expiresAt` is older than the retention cutoff. Reusing the [data retention](./data-retention.md) mechanism keeps this feature free of its own scheduler.

## Testing

**Unit tests** (Vitest with fakes, no database or Redis) sit beside each source file and run with `npm test` (`vitest run`):

- `src/domain/password-reset/password-reset-token-entity.test.ts` — the expiry boundary (the `expiresAt` instant itself is expired) and that a second `consume` on the same in-memory entity is rejected, not just a reload of a used row.
- `src/application/auth/password-reset-token-issuer.test.ts` — the raw token never lands on the entity, only its hash; expiry derives from the configured TTL.
- `src/application/auth/request-password-reset.test.ts` — invalidate-before-create ordering inside a single transaction; a failed transaction enqueues nothing; unknown and soft-deleted emails are silent no-ops.
- `src/application/auth/reset-password.test.ts` — pending users are activated while deactivated users stay inactive; a soft-deleted owner is rejected _without_ consuming the token; revocation is enqueued only after a successful commit.
- `src/application/auth/password-reset-email-content.test.ts` — the URL reaches both bodies but never the subject (subjects leak into notification previews).
- `src/application/jobs/send-password-reset-email-handler.test.ts` — a token containing URL-sensitive characters is percent-encoded into the link; delivery failures propagate for worker retry.
- `src/application/jobs/revoke-user-sessions-handler.test.ts` — revokes at the injected clock's instant and propagates failures, which is safe because the revoke is naturally idempotent.
- `src/infrastructure/security/crypto-opaque-token-service.test.ts` — 43-character base64url generation, unique across successive calls; 64-character deterministic hex hashing (the width `token_hash VarChar(64)` expects).
- `src/infrastructure/persistence/password-reset-token-retention-task.test.ts` — names its resource and delegates `prune(cutoff)` to `deleteExpired`, returning the count.

**Integration test** — `test/integration/password-reset.int.test.ts` drives both endpoints through the real app and database with a `CapturingJobQueue` standing in for BullMQ (the raw token is never persisted, so the captured job payload is the only place a test can read it). It proves the stored `tokenHash` differs from the mailed token; silent `204`s for unknown and soft-deleted emails with no job captured; end-to-end supersession (the first of two tokens is rejected, the second works); a successful reset that enqueues `REVOKE_USER_SESSIONS_JOB` and swaps which password logs in; pending-user activation observable via login; and `400`s for expired, replayed, unknown, and deleted-owner tokens with the exact error codes. Run it with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`); it requires Docker for the testcontainers the harness spins up.
