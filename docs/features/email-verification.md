# Email Verification

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `5156995`

## Purpose

An account is only as trustworthy as its email address: password resets, notifications, and any future account recovery all flow through it. Email verification proves the caller actually controls the address they claimed before the account gains access — a self-registered user starts `pending` and cannot log in until they echo back a short-lived six-digit code sent to their inbox. The same proof is re-demanded whenever an existing user changes their address, so an account can never quietly migrate onto an inbox its owner does not control. Without this gate, anyone could register (or hijack an account onto) someone else's address, and the platform would send security-sensitive mail to strangers.

## How it works

Verification has two triggers, one shared code-issuing pipeline, and one completion endpoint.

**Trigger 1 — self-service registration.** `POST /v1/auth/register` runs `RegisterUser.execute` (`src/application/auth/register-user.ts`). It normalizes the address through the `Email` value object, rejects a duplicate with `EmailAlreadyTakenError` (`409 EMAIL_ALREADY_TAKEN`), hashes the password, and builds the account with `User.register` — which, unlike the admin-facing `User.create`, sets `status: 'pending'` (`UserStatus.Pending` in `src/domain/user/user-entity.ts`). That duplicate check runs through `PrismaUserRepository.findByEmail`, which is a plain `findUnique` on the unique `users.email` column with no `deletedAt` filter: a soft-deleted account's address therefore keeps counting as taken and permanently blocks re-registration with the same `409` (see [user-crud.md](./user-crud.md) for the soft-delete model). It then asks `VerificationCodeIssuer.issue(user.id, now)` for a fresh code: `VerificationCodeService.generate()` draws a random six-digit string, and `EmailVerificationCode.issue` captures only its keyed hash — an HMAC-SHA256 of the code under the server-side `VERIFICATION_CODE_SECRET`, never the code itself — plus an expiry of `expiresAt = now + ttlSeconds × 1000` (the `× 1000` converts the configured seconds to the milliseconds `Date` arithmetic needs) and the `maxAttempts` cap from `VerificationConfig`.

User row, code row, and the staged `UserCreatedEvent` (see [domain-events.md](./domain-events.md)) are then committed atomically inside `unitOfWork.run`. Two flavours of repository are in play here, and the distinction matters later: `unitOfWork.run` passes its callback a **transaction-scoped** `TransactionContext` whose repositories write inside the open database transaction, while the repositories a use case receives through its own constructor are **directly injected** and write on their own connection, outside any transaction. Only after the transaction commits does the use case call `jobQueue.enqueue(SEND_VERIFICATION_EMAIL_JOB, { email: email.toString(), code: rawCode })` — the single place the raw code leaves the process. The HTTP response is a `201` with the pending `UserDto`; the raw code is never in it.

**Trigger 2 — email change.** `PATCH /v1/users/:id` runs `EditUser.execute` (`src/application/user/edit-user.ts`, owned by [user-crud.md](./user-crud.md)). When the payload carries a genuinely different address (value-object equality makes a case-only change a no-op), it re-checks uniqueness and calls `User.changeEmail`, which demotes an `active` user back to `pending`; a user whose status is already something else — `pending`, or `inactive` (deactivated) — keeps that status. Note that this is an _entity_ rule about status only: `EditUser` itself applies no status guard, and always issues and mails a code for a changed address (see the reactivation-path note in [Design decisions](#design-decisions--trade-offs)).

The code is resolved by `EditUser.resolveVerificationCode`: if `findActiveByUserId` finds an unconsumed row, `VerificationCodeIssuer.reissue` rotates the hash and expiry and resets the attempt counter _on that same row_; otherwise a new one is issued. The user and the code are saved in one `unitOfWork.run`, and the same `email.send-verification` job is enqueued after commit — addressed to the **new** address. The user closes the loop through the very same `POST /v1/auth/verify-email` endpoint, submitting the **new** address with the code; until they do, a demoted user cannot log in again, because `Login` accepts only `active` users.

**The email leg.** The worker process consumes the job: `SendVerificationEmailHandler` (`src/application/jobs/send-verification-email-handler.ts`) calls the pure renderer `renderVerificationEmail(payload.code)` — subject `Verify your email address`, with the code in the text and HTML bodies but deliberately not the subject — and hands the message to the `EmailSender` port. Queue mechanics (retries, backoff, dead-lettering) are documented in [background-jobs.md](./background-jobs.md); SMTP delivery and its configuration in [email-sending.md](./email-sending.md). A delivery failure is rethrown so BullMQ retries it; the HTTP response was never waiting on it.

**Completion.** The user submits the code to `POST /v1/auth/verify-email`, which runs `VerifyEmail.execute` (`src/application/auth/verify-email.ts`). It resolves the user by email, loads the active code, hashes the candidate with the same keyed hash, and calls `EmailVerificationCode.verify(candidateHash, now)`. The entity checks its guards in a fixed order — already consumed → expired → attempt cap reached → hash mismatch — throwing `VerificationCodeInvalidError`, `VerificationCodeExpiredError`, or `TooManyVerificationAttemptsError` respectively (all extend `ValidationError` and surface as HTTP 400 with the error code at `error.code` in the body). On a match it stamps `consumedAt`. The use case then calls `user.activate(now)` and commits both the activated user and the consumed code in one `unitOfWork.run`, returning the now-`active` `UserDto`.

**The failure paths that matter.**

- _Wrong code:_ `EmailVerificationCode.verify` increments `attempts` on the in-memory entity and then throws. Nothing is inside a transaction at that point — the throw happens before `VerifyEmail` ever reaches its success-path `unitOfWork.run` — so unless the increment is written explicitly it is discarded with the request. That is why `VerifyEmail` catches the error and calls `update` on its **directly injected** `emailVerificationCodeRepository` before rethrowing: failed guesses accumulate. Doing the same write inside a transaction would be self-defeating, since the rethrow would roll it back and the cap could never engage. The write is selective rather than unconditional: `VerifyEmail` snapshots `const attemptsBefore = code.attempts` before calling `verify` and only issues the `update` when `code.attempts !== attemptsBefore`. Expired, capped, and consumed rejections therefore leave `attempts` untouched and write nothing.
- _Cap reached:_ once `attempts` equals `maxAttempts`, even the **correct** code is refused with `TOO_MANY_VERIFICATION_ATTEMPTS`; the account stays `pending`. The verification path offers no way out of that state on its own: there is no resend endpoint, and `Login` refuses a non-`active` user, so the account cannot obtain the bearer token `PATCH /v1/users/:id` requires in order to trigger a fresh code. The one existing escape hatch is the password-reset flow — `ResetPassword` activates a user who `isPending` ([password-reset.md](./password-reset.md)) — so a user who still controls the mailbox can recover that way; otherwise the account needs operator action. Adding the missing resend endpoint is sketched in [Usage & extension](#usage--extension).
- _Expired:_ past `expiresAt` the code is rejected with `VERIFICATION_CODE_EXPIRED` and nothing is written, leaving the account in exactly the same dead end as the attempt cap, with the same two ways out.
- _Unknown email / no active code:_ both answer with exactly the same `VERIFICATION_CODE_INVALID` 400 as a wrong guess, so the endpoint cannot be used to probe which addresses have accounts.
- _Soft-deleted user:_ `PrismaUserRepository.findByEmail` (`src/infrastructure/persistence/prisma-user-repository.ts`) applies no `deletedAt` filter, unlike `findById`. A correct code belonging to a soft-deleted user therefore passes every entity guard, and the request fails one line later at `user.activate(now)`, which throws `UserDeletedError` → `409 USER_DELETED`. The code is _not_ consumed: `activate` throws before `unitOfWork.run` is entered, so no write happens at all and the row keeps `consumedAt: null`.

**Cleanup — there is none.** Nothing ever deletes a row from `email_verification_codes`. Consuming a code stamps `consumedAt` and leaves the row in place; an expired code is simply never selected again by `findActiveByUserId`. Unlike every sibling credential table, this feature registers **no** `RetentionTask` — `src/infrastructure/persistence/` contains only `refresh-token-retention-task.ts`, `password-reset-token-retention-task.ts`, and `outbox-retention-task.ts` — so the `DATA_RETENTION_TTL` sweep never touches it, and the table grows monotonically with every registration and every email change. The only automatic removal is the `onDelete: Cascade` from `User`, which fires on a hard delete of the parent row (soft deletes leave the user row, and therefore its codes, in place). See [data-retention.md](./data-retention.md).

**The gate itself.** `Login` (`src/application/auth/login.ts`) refuses any non-`active` user with the same `InvalidCredentialsError` as a wrong password — a pending, unverified account authenticates nowhere until verification completes.

## Architecture

The domain layer owns the rules — what a code _is_ and when it may be consumed (`EmailVerificationCode`), when a user is `pending` versus `active` (`User`) — plus the `EmailVerificationCodeRepository` interface. The application layer orchestrates the two triggers and the completion, and defines the `VerificationCodeService` port for the one thing it must not know how to do: generate and hash secrets. Infrastructure supplies the adapters — `CryptoVerificationCodeService` (Node `crypto`) and `PrismaEmailVerificationCodeRepository` — and email leaves through the existing `EmailSender` port ([email-sending.md](./email-sending.md)) via the job queue ([background-jobs.md](./background-jobs.md)). Dependencies point inward only; the concrete bindings live solely in `src/container.ts`.

| Component                                                                                            | Layer              | Responsibility                                                                                                                                                                                                                                                                                                | File                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `EmailVerificationCode`                                                                              | Domain             | Entity holding `codeHash`, `expiresAt`, `attempts`/`maxAttempts`, `consumedAt`; enforces the consumed → expired → cap → mismatch guard order in `verify`, resets state in `reissue`                                                                                                                           | `src/domain/verification/email-verification-code-entity.ts`                   |
| `EmailVerificationCodeRepository`                                                                    | Domain             | Repository interface: `create`, `update`, `findActiveByUserId`                                                                                                                                                                                                                                                | `src/domain/verification/email-verification-code-repository.ts`               |
| `VerificationCodeInvalidError` / `VerificationCodeExpiredError` / `TooManyVerificationAttemptsError` | Domain             | Typed rejections; all extend `ValidationError`, so the central error handler renders them as HTTP 400                                                                                                                                                                                                         | `src/domain/verification/verification-errors.ts`                              |
| `User.register` / `User.activate` / `User.changeEmail`                                               | Domain             | Pending-on-signup; `activate` promotes any non-`active`, non-deleted user; `changeEmail` demotes to `pending` only from `active`                                                                                                                                                                              | `src/domain/user/user-entity.ts`                                              |
| `RegisterUser`                                                                                       | Application        | Self-service sign-up: dedupe, hash password, pending user + code + staged event in one transaction, enqueue email after commit                                                                                                                                                                                | `src/application/auth/register-user.ts`                                       |
| `VerifyEmail`                                                                                        | Application        | Completion: resolve user and active code, verify the hash, activate + consume atomically; persists failed-attempt counts outside the transaction                                                                                                                                                              | `src/application/auth/verify-email.ts`                                        |
| `VerificationCodeIssuer`                                                                             | Application        | The shared issue/reissue policy: generate → hash → TTL expiry → attempt cap, used by both triggers                                                                                                                                                                                                            | `src/application/auth/verification-code-issuer.ts`                            |
| `VerificationConfig`                                                                                 | Application        | Config shape `{ ttlSeconds, maxAttempts }` the issuer consumes, keeping env parsing out of the layer                                                                                                                                                                                                          | `src/application/auth/verification-config.ts`                                 |
| `renderVerificationEmail`                                                                            | Application        | Pure renderer of the message (subject, text, HTML); code in the body, never the subject                                                                                                                                                                                                                       | `src/application/auth/verification-email-content.ts`                          |
| `SEND_VERIFICATION_EMAIL_JOB` / `SendVerificationEmailPayload`                                       | Application        | Job name `email.send-verification` and payload `{ email, code }` — the only carrier of the raw code                                                                                                                                                                                                           | `src/application/jobs/send-verification-email-job.ts`                         |
| `SendVerificationEmailHandler`                                                                       | Application        | Worker-side consumer: render the payload's code and send through the `EmailSender` port                                                                                                                                                                                                                       | `src/application/jobs/send-verification-email-handler.ts`                     |
| `VerificationCodeService`                                                                            | Application (port) | Contract to `generate()` a raw code and `hash(code)` it deterministically                                                                                                                                                                                                                                     | `src/application/shared/ports/verification-code-service.ts`                   |
| `EditUser`                                                                                           | Application        | Re-verification trigger: demote on email change, reissue-or-issue a code, enqueue to the new address (owned by [user-crud.md](./user-crud.md))                                                                                                                                                                | `src/application/user/edit-user.ts`                                           |
| `CryptoVerificationCodeService`                                                                      | Infrastructure     | Adapter: `randomInt(0, 1_000_000)` zero-padded to six digits; HMAC-SHA256 over the code keyed with `VERIFICATION_CODE_SECRET`, hex-encoded                                                                                                                                                                    | `src/infrastructure/security/crypto-verification-code-service.ts`             |
| `PrismaEmailVerificationCodeRepository`                                                              | Infrastructure     | Prisma adapter; `findActiveByUserId` = newest row with `consumedAt: null`; writes wrapped in `mapPrismaError`                                                                                                                                                                                                 | `src/infrastructure/persistence/prisma-email-verification-code-repository.ts` |
| `toDomain` / `toPersistence`                                                                         | Infrastructure     | Row ↔ entity mapping; the table has no soft-delete column, so hydration fixes `deletedAt: null`                                                                                                                                                                                                               | `src/infrastructure/persistence/prisma-email-verification-code-mapper.ts`     |
| `EmailVerificationCode` model                                                                        | Infrastructure     | Table `email_verification_codes`: `code_hash VarChar(64)`, index on `[userId, consumedAt]`, `onDelete: Cascade` from `User`                                                                                                                                                                                   | `prisma/schema.prisma`                                                        |
| `purge-verification-jobs`                                                                            | Operational script | Removes dead-lettered `email.send-verification` jobs — jobs that exhausted every BullMQ retry and were parked in the queue's failed set, payload and raw code included — filtering by job name so dead-lettered `domain-event.dispatch` jobs survive                                                          | `src/scripts/purge-verification-jobs.ts`                                      |
| `authRoutes`                                                                                         | Presentation       | `POST /register` and `POST /verify-email` with Zod body schemas, auth-tier rate limits, and idempotency opt-in on register                                                                                                                                                                                    | `src/presentation/http/routes/auth-routes.ts`                                 |
| Container wiring                                                                                     | Composition root   | Binds `verificationCodeService` → `CryptoVerificationCodeService`, `emailVerificationCodeRepository` → Prisma adapter, folds env into `verificationConfig` via `asValue`, registers issuer/use cases, and maps `[SEND_VERIFICATION_EMAIL_JOB]: sendVerificationEmailHandler` into the worker's handler record | `src/container.ts`                                                            |

Path assembly takes three files: `apiV1Routes` (`src/presentation/http/routes/api-v1-routes.ts`) mounts `authRoutes` under `/auth`; `API_V1_PREFIX = '/v1'` is declared in `src/presentation/http/api-version.ts`; and `src/presentation/http/app.ts` registers `apiV1Routes` at that prefix. The `UnitOfWork`'s `TransactionContext` (`src/application/shared/ports/unit-of-work.ts`) exposes a transaction-scoped `emailVerificationCodeRepository`, which is how code writes join the same database transaction as the user writes.

## Public surface

### HTTP endpoints

| Method | Path                    | Auth                                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/register`     | Public; rate-limited to `RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_WINDOW` | Self-service sign-up; honours an `Idempotency-Key` header (`config: { idempotency: true }`). Body: `firstName`, `lastName` (1–100 chars), `email`, `password` (8–128 chars). `201` with the **pending** user; `400` invalid body; `409 EMAIL_ALREADY_TAKEN` when the address is already registered — including when it belongs to a soft-deleted account, which keeps it taken forever; `429 RATE_LIMITED` over budget. |
| `POST` | `/v1/auth/verify-email` | Public; rate-limited to `RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_WINDOW` | Complete verification. Body: `email`, `code` (exactly six digits, `/^\d{6}$/`). `200` with the **active** user; `400` with `error.code` ∈ `VERIFICATION_CODE_INVALID` \| `VERIFICATION_CODE_EXPIRED` \| `TOO_MANY_VERIFICATION_ATTEMPTS`; `409 USER_DELETED` when the code is correct but the account has been soft-deleted (the code is left unconsumed); `429 RATE_LIMITED` over budget.                              |

Both endpoints are deliberately unauthenticated — their caller by definition has no session yet. Malformed codes are rejected `400` by the Zod schema before the use case runs. Both `409`s are produced by the central error handler's `Conflict → 409` mapping (`src/presentation/http/error-handler.ts`); on `/verify-email` the route's own `response` schema declares only `200` and `400`, so that status is passed through without schema serialization. The `429` body is shaped by the shared `errorResponseBuilder` in `src/presentation/http/security.ts`, which stamps `error.code = 'RATE_LIMITED'` and a `retry in …` message — see [http-infrastructure.md](./http-infrastructure.md). Replay semantics for the `Idempotency-Key` header on `/register` are documented in [idempotency.md](./idempotency.md).

One further endpoint drives this feature but belongs to an adjacent one and is documented there:

| Method  | Path            | Feature                                                                                                                                                                                                                                       |
| ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH` | `/v1/users/:id` | [user-crud.md](./user-crud.md) — bearer token, self **or** permission `users.update`. Changing `email` returns the user as `pending` and sends a fresh code to the new address; the holder then completes it at `POST /v1/auth/verify-email`. |

### Job contract

Producers and the worker meet at `src/application/jobs/send-verification-email-job.ts`:

```ts
export const SEND_VERIFICATION_EMAIL_JOB = 'email.send-verification';

export interface SendVerificationEmailPayload {
  email: string;
  code: string;
}
```

`code` is the raw six-digit code; this payload is the only place it exists outside the recipient's inbox.

### Ports

```ts
export interface VerificationCodeService {
  generate(): string;

  hash(code: string): string;
}
```

`hash` must be deterministic — `VerifyEmail` compares `hash(candidate)` against the stored `codeHash` by string equality.

A component that needs to start a verification cycle programs against `VerificationCodeIssuer` (`src/application/auth/verification-code-issuer.ts`) rather than against those primitives. Its two methods deliberately have different shapes, because one mints an entity and the other mutates one:

```ts
export interface IssuedVerificationCode {
  code: EmailVerificationCode;
  rawCode: string;
}

export declare class VerificationCodeIssuer {
  issue(userId: string, now: Date): IssuedVerificationCode;

  reissue(existing: EmailVerificationCode, now: Date): string;
}
```

`issue` returns a brand-new, unpersisted `EmailVerificationCode` alongside its `rawCode`; the caller is responsible for `create`-ing it. `reissue` rotates the hash and expiry on the entity it is handed — in place, resetting `attempts` to `0` and `consumedAt` to `null` — and returns only the bare `rawCode` string; the caller `update`s the same row. Both compute `expiresAt = now + ttlSeconds × 1000` through the private `expiryFrom` helper, byte-identical to the one in `PasswordResetTokenIssuer` ([password-reset.md](./password-reset.md)).

## Configuration

Read from `src/config/env.ts`. `.env.example` mirrors the TTL and max-attempts values verbatim; it deliberately does **not** mirror the secret's dev default, setting `VERIFICATION_CODE_SECRET=change-me-to-a-32+-char-random-string` as a prompt to replace it.

| Variable                    | Default                                                                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFICATION_CODE_TTL`     | `900` (`60 * 15`, 15 minutes)                                              | Seconds a code stays valid; the issuer stamps `expiresAt = now + ttlSeconds × 1000`. The expiry instant itself already counts as expired.                                                                                                                                                                                                                                               |
| `VERIFICATION_MAX_ATTEMPTS` | `5`                                                                        | Wrong guesses allowed per code before it locks; at the cap even the correct code is refused.                                                                                                                                                                                                                                                                                            |
| `VERIFICATION_CODE_SECRET`  | dev/test: `dev-verification-code-secret-change-me`; production: no default | HMAC key for hashing codes — a single server-side secret mixed into every hash (`env.ts` calls it a "pepper"), unlike a per-row salt. In production it is required and must be ≥ 32 characters — `assertProductionSecrets` (`src/config/assert-production-secrets.ts`) refuses to boot otherwise.                                                                                       |
| `RATE_LIMIT_AUTH_MAX`       | `5`                                                                        | Per-route request cap applied to both endpoints; the stricter budget shared with the other credential-bearing `/auth` routes — `/login`, `/forgot-password`, and `/reset-password` ([authentication.md](./authentication.md), [password-reset.md](./password-reset.md)). `/refresh`, `/logout`, and `/me` set no route-level tier and fall back to the global `RATE_LIMIT_MAX` (`100`). |
| `RATE_LIMIT_WINDOW`         | `1 minute`                                                                 | Length of that window; also the global limiter's window, and shared with those same credential-bearing `/auth` routes.                                                                                                                                                                                                                                                                  |

`container.ts` folds the first two into the `verificationConfig` value (`{ ttlSeconds: env.VERIFICATION_CODE_TTL, maxAttempts: env.VERIFICATION_MAX_ATTEMPTS }`) and hands the secret to `CryptoVerificationCodeService` — application code never touches `env`.

Two more variables shape how long a `POST /v1/auth/register` replay stays valid, even though this feature only opts into the behaviour: `IDEMPOTENCY_RESULT_TTL` (default `86400` — `60 * 60 * 24`, 24 hours) is how long a completed `201` stays replayable under the same `Idempotency-Key`, and `IDEMPOTENCY_LOCK_TTL` (default `30` seconds) is how long an in-flight request holds its claim on that key, during which a concurrent retry is rejected with `409` rather than registering a second account. `container.ts` passes both into `RedisIdempotencyStore`; the mechanism is documented in [idempotency.md](./idempotency.md). SMTP settings (`SMTP_HOST`, `EMAIL_FROM`, …) govern the delivery leg and are documented in [email-sending.md](./email-sending.md); `REDIS_URL`, `QUEUE_PREFIX`, and `QUEUE_CONCURRENCY` govern the queue leg and are documented in [background-jobs.md](./background-jobs.md).

## Usage & extension

### Exercising the flow

```bash
curl -X POST http://localhost:8000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@finflow.test","password":"password123"}'
```

The response is `201` with `"status": "pending"`. The worker delivers the code by email — in development the Mailpit catcher on `:1025` (see `.env.example`) shows it. Then:

```bash
curl -X POST http://localhost:8000/v1/auth/verify-email \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@finflow.test","code":"123456"}'
```

`200` with `"status": "active"` — the user can now log in.

### Operations: purging dead-lettered codes

A verification email that exhausts its BullMQ retries is dead-lettered, and the failed job — payload included — is retained for 7 days. Since that payload is `{ email, code }`, a raw code sits in Redis for the full window. Clear those jobs with:

```bash
npx tsx src/scripts/purge-verification-jobs.ts
```

It has no npm script; run it against the target environment's `REDIS_URL` and `QUEUE_PREFIX`. It filters the failed set by job name on purpose — see [email-sending.md](./email-sending.md) and [background-jobs.md](./background-jobs.md).

### Adding the next variant: a resend endpoint

The natural extension is `POST /v1/auth/resend-verification` for users whose code expired or whose email never arrived. The recipe below is the same one `RegisterUser` and `EditUser` already follow — reuse `VerificationCodeIssuer`, persist through the `UnitOfWork`, enqueue only after commit.

**1. The use case** — `src/application/auth/resend-verification-email.ts`:

```ts
import { Email } from '@/domain/user/email-vo';
import type { UserRepository } from '@/domain/user/user-repository';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Clock } from '@/application/shared/ports/clock';
import type { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';

export interface ResendVerificationEmailInput {
  email: string;
}

interface ResendVerificationEmailDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  emailVerificationCodeRepository: EmailVerificationCodeRepository;
  verificationCodeIssuer: VerificationCodeIssuer;
  jobQueue: JobQueue;
  clock: Clock;
}

export class ResendVerificationEmail {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly codes: EmailVerificationCodeRepository;
  private readonly codeIssuer: VerificationCodeIssuer;
  private readonly queue: JobQueue;
  private readonly clock: Clock;

  constructor({
    unitOfWork,
    userRepository,
    emailVerificationCodeRepository,
    verificationCodeIssuer,
    jobQueue,
    clock,
  }: ResendVerificationEmailDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.codes = emailVerificationCodeRepository;
    this.codeIssuer = verificationCodeIssuer;
    this.queue = jobQueue;
    this.clock = clock;
  }

  async execute(input: ResendVerificationEmailInput): Promise<void> {
    const email = Email.create(input.email);
    const user = await this.users.findByEmail(email);
    if (!user || user.isDeleted || !user.isPending) return;

    const now = this.clock.now();
    const existing = await this.codes.findActiveByUserId(user.id);

    let rawCode: string;
    if (existing) {
      rawCode = this.codeIssuer.reissue(existing, now);
      await this.uow.run(async ({ emailVerificationCodeRepository }) => {
        await emailVerificationCodeRepository.update(existing);
      });
    } else {
      const issued = this.codeIssuer.issue(user.id, now);
      rawCode = issued.rawCode;
      await this.uow.run(async ({ emailVerificationCodeRepository }) => {
        await emailVerificationCodeRepository.create(issued.code);
      });
    }

    const payload: SendVerificationEmailPayload = { email: email.toString(), code: rawCode };
    await this.queue.enqueue(SEND_VERIFICATION_EMAIL_JOB, payload);
  }
}
```

The silent `return` for an unknown, deleted, or no-longer-pending (`active` or `inactive`) account keeps the endpoint enumeration-safe, matching `/auth/forgot-password`. The explicit `user.isDeleted` check is required because `findByEmail` — unlike `findById` — does not filter soft-deleted rows. Reissuing (rather than inserting) preserves the one-active-code-per-user invariant, and resetting `attempts` is what un-bricks a code locked by `TOO_MANY_VERIFICATION_ATTEMPTS`.

**2. Wire it** in `src/container.ts` — add to the `Cradle` interface and the registration block:

```ts
resendVerificationEmail: ResendVerificationEmail;
```

```ts
resendVerificationEmail: asClass(ResendVerificationEmail).singleton(),
```

**3. Route it** in `src/presentation/http/routes/auth-routes.ts`, reusing the auth rate-limit tier and answering `204` unconditionally:

```ts
app.post(
  '/resend-verification',
  {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW } },
    schema: { body: z.object({ email: z.email() }) },
  },
  async (request, reply) => {
    const { resendVerificationEmail } = request.diScope.cradle;
    await resendVerificationEmail.execute(request.body);
    return reply.status(204).send();
  },
);
```

No worker change is needed — the existing `email.send-verification` handler serves any producer.

## Design decisions & trade-offs

- **Codes are stored as an HMAC-SHA256, not raw and not a slow hash.** A six-digit code has only 10⁶ possible values, so any _unkeyed_ digest — however slow — is trivially brute-forced offline from a leaked row. Keying the hash with the server-side `VERIFICATION_CODE_SECRET` makes a database dump useless without also compromising the environment, and a deterministic keyed hash lets `VerifyEmail` compare by string equality with no extra query. Argon2 per guess would add server cost without adding safety, because online guessing is already bounded by the attempt cap, and offline guessing is bounded by the secret.
- **The attempt cap lives in the entity, and past it even the correct code is refused.** With `VERIFICATION_MAX_ATTEMPTS = 5` guesses against 10⁶ codes, a guesser's odds are 1 in 200,000 per code. Accepting the right code after the cap would let an attacker fail four times "for free" and keep going; burning the code instead forces a fresh one. The guard order (consumed → expired → cap → mismatch) is fixed and pinned by unit tests, so the error reported is always the most specific true one.
- **Failed-attempt counts are persisted _outside_ the transaction.** `verify` increments `attempts` on the in-memory entity and throws, which means the success-path `unitOfWork.run` is never reached and the increment would evaporate with the request. `VerifyEmail` therefore writes it explicitly from its `catch` block, through the directly injected repository. Moving that write inside a transaction would defeat it: the rethrow would roll the increment back, every guess would find `attempts` at zero, and the cap could never engage. The success path stays atomic — activated user and consumed code commit together or not at all.
- **The raw code exists only in transit — with one retention tail.** It is never persisted, never logged by this feature, and never in an API response; it travels exclusively in the `SendVerificationEmailPayload` and the rendered email. The accepted cost is that it sits in the Redis job payload until the job completes — and, if the send exhausts its retries, in BullMQ's failed set for a further **7 days**, payload included (`BullMqJobQueue` sets `removeOnFail: KEEP_FAILED`, where `KEEP_FAILED = { age: SEVEN_DAYS_SECONDS, count: KEEP_FAILED_COUNT }` — `src/infrastructure/jobs/bullmq-job-queue.ts`). `src/scripts/purge-verification-jobs.ts` exists solely to clear those dead-lettered jobs; it filters the shared failed set by job name so that dead-lettered `domain-event.dispatch` jobs — which are the only surviving copy of their event — are not swept up with them. See [email-sending.md](./email-sending.md) for the wider secrets-in-payloads discussion.
- **Enqueue strictly after commit.** A rolled-back registration must not email anyone a code for an account that does not exist. The trade-off is a crash window between commit and enqueue that would leave a pending user with no email — and there is no resend endpoint yet, which is exactly why [Usage & extension](#usage--extension) shows how to add one.
- **One active code per user, reissued in place.** `findActiveByUserId` returns the newest unconsumed row, and `EditUser` rotates that row via `reissue` instead of inserting a second. Only the latest code is ever valid, no second _unconsumed_ row piles up behind the `[userId, consumedAt]` index, and "the most recent email wins" holds even across rapid successive email changes. This is an invariant about live codes only — it says nothing about the consumed and expired rows left behind, which is the next bullet.
- **Verification code rows are retained indefinitely.** Consumed and expired rows are never deleted: the feature registers **no** `RetentionTask`, so the `DATA_RETENTION_TTL` sweep skips `email_verification_codes` entirely. That is a deliberate-looking asymmetry with every sibling credential table — `refresh_tokens` and `password_reset_tokens` each ship a retention task (`refresh-token-retention-task.ts`, `password-reset-token-retention-task.ts`), as does the outbox — but nothing in the code records a reason for the exception. The rows are cheap and hold only an HMAC, so the cost is table growth rather than exposure; the fix, if growth matters, is a task in the same shape as its siblings. See [data-retention.md](./data-retention.md).
- **Anti-enumeration by uniform failure.** Unknown email, no active code, consumed code, and wrong code all yield the same `VERIFICATION_CODE_INVALID` 400 — tests pin the status, error code, and message to be identical across those cases — and `Login` hides "pending" behind the same `InvalidCredentialsError` as a wrong password. Combined with `RATE_LIMIT_AUTH_MAX`, the endpoints leak nothing about which addresses hold accounts.
- **The code goes in the email body, never the subject.** Subjects surface in lock-screen and notification previews on shared or visible devices; a unit test pins this so a future template edit cannot regress it.
- **Registration opts into `Idempotency-Key` replay.** A client retrying a timed-out `POST /v1/auth/register` with the same key gets the original `201` replayed instead of a confusing `409` duplicate-email error. `test/integration/idempotency/register-idempotency.int.test.ts` pins the replay semantics — replayed status, the `idempotent-replayed` header, and a single user row — though it makes no assertion about verification codes.
- **Self-service and admin creation deliberately diverge.** `User.register` starts `pending` because an anonymous caller's address is unproven; the admin-only `CreateUser` uses `User.create` and starts `active`, because an authenticated administrator vouches for the record.
- **Status demotion is an entity rule; code issuance is not — so an email change is also a reactivation path.** These three behaviours compose into a consequence worth knowing about. `User.changeEmail` demotes to `pending` **only** from `active`, leaving any other status alone. `EditUser` applies **no status guard at all**: `resolveVerificationCode` runs, and the `email.send-verification` job is enqueued, for any genuinely changed address. And `User.activate` guards only `isDeleted` and already-`active`, promoting **any** other status. Net effect: if an admin holding `users.update` changes the email of a user whose status is `inactive` (deactivated), that user is mailed a code, and redeeming it flips the account from `inactive` straight to `active` — a status change nobody explicitly requested. The reachability caveat is that no application code currently produces an `inactive`-but-not-soft-deleted user (`User.deactivate` is called only from `softDelete`, and `EditUser` resolves its target with `findById`, which excludes soft-deleted rows with a `404`), so the path is latent rather than routinely exercised today — it goes live the moment a deactivation endpoint or an operator-set status exists. Contrast [password-reset.md](./password-reset.md), where `ResetPassword` makes the opposite call explicitly: it activates a `pending` user but deliberately leaves an `inactive` one inactive, on the grounds that a recovery flow should not silently undo an administrative decision. Aligning `EditUser`/`VerifyEmail` with that stance would mean either skipping issuance for a non-`pending` user or narrowing `activate` at the call site. See [Known limitations](#known-limitations).

## Testing

**Unit tests** (`npm test` → `vitest run`) sit next to their subjects:

- `src/domain/verification/email-verification-code-entity.test.ts` — issue/verify/reissue invariants, the guard order, the expiry boundary (`expiresAt` itself is expired), and cap arithmetic.
- `src/application/auth/register-user.test.ts` — pending-not-active persistence, event staging, single clock read, enqueue-only-after-commit, and that no raw code leaks through the response.
- `src/application/auth/verify-email.test.ts` — hash-not-raw-code comparison, one-transaction activation, the out-of-transaction attempt-counter write, and enumeration parity (identical error for unknown email and wrong code).
- `src/application/auth/verification-code-issuer.test.ts` — TTL-derived expiry and hash/expiry rotation on reissue.
- `src/application/auth/verification-email-content.test.ts` — the code appears in text and HTML but never the subject; rendering is pure.
- `src/application/jobs/send-verification-email-handler.test.ts` — renders and sends exactly one message; rethrows delivery failures so the worker can retry.
- `src/application/user/edit-user.test.ts` — demotion to pending, issue-vs-reissue, enqueue after commit, and that verification machinery is untouched when the email does not change.
- `src/infrastructure/security/crypto-verification-code-service.test.ts` — uniform six-digit generation, and the HMAC pinned to a known digest producing 64 hex chars (fitting `code_hash VarChar(64)`).
- `src/infrastructure/persistence/prisma-email-verification-code-mapper.test.ts` — row ↔ entity round-trips (unconsumed, consumed, and partially spent attempt counters), and that hydration synthesizes `deletedAt: null` while `toPersistence` emits no `deletedAt` key, matching a table that has no such column.

**Integration tests** (`npm run test:integration` → `vitest run -c vitest.integration.config.ts`, real MariaDB and Redis via Testcontainers) drive full HTTP round-trips:

- `test/integration/verify-email.int.test.ts` — activation and consumption, replay of a consumed code, wrong-code counting, the attempt-cap lock (correct code refused, user left pending), enumeration parity, malformed-code schema rejection, and the capstone `register → login 401 → verify → login 200` gate.
- `test/integration/edit-user-verification.int.test.ts` — email change demotes to pending and enqueues to the new address, a second change reissues the same row, and the reissued code completes verification.
- `test/integration/idempotency/register-idempotency.int.test.ts` — `Idempotency-Key` replay semantics on `POST /v1/auth/register` (replay, no-key non-deduplication, in-flight `409`, parameter mismatch, blank key, and cached-4xx replay).

Because the raw code is never persisted, integration tests bind a `CapturingJobQueue` into the harness and read the code off the enqueued `SendVerificationEmailPayload` — the only observable point it exists — which also keeps the suite off the real BullMQ worker.

## Known limitations

- **The `inactive` → `active` reactivation path is untested and its intent is unrecorded.** The behaviour is unambiguous in source (see the final Design decisions bullet), but nothing in the code or its tests distinguishes "deliberate" from "not yet considered", and `ResetPassword` makes the opposite choice for the analogous case. This doc therefore reports it as known behaviour without asserting which it is.
