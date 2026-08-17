# Email Sending

> **Status:** Complete · **Layers:** application, infrastructure · **Verified against:** `5156995`

## Purpose

Two flows — email verification and password reset — must deliver a secret to a user's inbox, and neither should know what SMTP is. This feature is the delivery mechanism they share. It is built around a **port** and an **adapter**: the port is `EmailSender`, the application-layer interface that application code programs against; the adapter is `NodemailerEmailSender`, the single infrastructure implementation sitting behind that interface, which owns every SMTP concern (host, TLS, auth, the From address). Around them sit pure content builders that render each message and job handlers that consume send requests off the background queue. It exists so that sending an email is a one-line port call for application code, while the operational realities of SMTP — latency, transient failure, credentials, dev catchers — stay in one infrastructure file and the environment.

## How it works

No email is sent inline on an HTTP request. A use case that wants mail delivered enqueues a job and returns; the worker process does the sending.

1. **A flow enqueues a send job.** `RegisterUser` and `EditUser` (on an email change) enqueue `SEND_VERIFICATION_EMAIL_JOB` (`'email.send-verification'`) with a `SendVerificationEmailPayload` of `{ email, code }`; `RequestPasswordReset` enqueues `SEND_PASSWORD_RESET_EMAIL_JOB` (`'email.send-password-reset'`) with a `SendPasswordResetEmailPayload` of `{ email, token }`. The `code`/`token` in the payload is the **raw** secret — the database keeps only a hash (HMAC-SHA256 for codes, SHA-256 for tokens), so the queue payload is the only place the sendable form exists. Why each flow sends what it sends is those features' story: see [email-verification.md](./email-verification.md) and [password-reset.md](./password-reset.md).
2. **The worker routes the job to its handler.** The BullMQ queue ([background-jobs.md](./background-jobs.md)) delivers the job to the matching `JobHandler` on the worker process: `SendVerificationEmailHandler` or `SendPasswordResetEmailHandler`, both filed in the worker's handler record in `src/container.ts`.
3. **The handler builds the content.** `SendVerificationEmailHandler.handle` calls `renderVerificationEmail(payload.code)`. `SendPasswordResetEmailHandler.handle` first assembles the link — `` `${this.urlBase}?token=${encodeURIComponent(payload.token)}` ``, where `urlBase` is the injected `passwordResetUrlBase` (from `PASSWORD_RESET_URL_BASE`) — then calls `renderPasswordResetEmail(resetUrl)`. Both builders are pure functions returning `{ subject, text, html }`.
4. **The handler calls the port.** It invokes `emailSender.send({ to: payload.email, subject, text, html })`. The message names no From address: that identity is not part of the port's contract.
5. **The adapter talks SMTP.** `NodemailerEmailSender` maps the message onto `transporter.sendMail`, adding the configured `from` (`EMAIL_FROM`). Its Nodemailer transport was built once at construction from the `SMTP_*` settings, translating `requireTls` to Nodemailer's `requireTLS` and passing `auth: undefined` when `SMTP_USER` is empty, so no authentication is attempted (the local-catcher case).
6. **A send failure means retry, then dead-letter.** The adapter and the handlers deliberately catch nothing: a `sendMail` rejection propagates out of `handle`, which is the signal BullMQ needs to retry — 3 total attempts with exponential backoff from a 1 s base, both fixed in `src/infrastructure/jobs/bullmq-job-queue.ts`. A job that exhausts its attempts is logged by the worker at `error` (`'Job dead-lettered, no retry remains'`) and retained in the queue's failed set for 7 days, or until the failed set exceeds 5000 jobs, whichever binds first — payload included. Because that payload carries a raw verification code, `src/scripts/purge-verification-jobs.ts` exists to remove dead-lettered `email.send-verification` jobs from Redis.
7. **An enqueue failure behaves differently — it reaches the caller.** All three enqueue sites `await` the enqueue with no `try`/`catch`, and they do so _after_ their database transaction has committed. If Redis is unreachable, the rejection propagates out of `execute` and the HTTP request fails — but the user row, or the reset token, is already durable. The result is a committed-but-unmailed state that nothing retries. See [Design decisions](#design-decisions--trade-offs) for why that trade is accepted and what it means operationally.

## Architecture

The application layer owns the abstraction and everything that decides _what_ to send: the `EmailSender` port, the two pure content builders, and the job handlers that consume send requests. The infrastructure layer owns _how_ it is sent: `NodemailerEmailSender` is the only file in the codebase that imports `nodemailer` or knows an SMTP option exists. Dependencies point inward — the handlers depend on the `EmailSender` interface, and the concrete adapter is bound to it in exactly one place, the `emailSender` registration in `src/container.ts`. Swapping SMTP for a provider API is a new adapter plus one rebinding; no application file changes.

| Component                                                         | Layer              | Responsibility                                                                                                                                                                                          | File                                                        |
| ----------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `EmailSender` / `EmailMessage`                                    | Application (port) | Contract to deliver one message (`to`, `subject`, `text`, optional `html`); the From identity is excluded by design                                                                                     | `src/application/shared/ports/email-sender.ts`              |
| `renderVerificationEmail` / `VerificationEmailContent`            | Application        | Pure builder: verification code → `{ subject, text, html }`                                                                                                                                             | `src/application/auth/verification-email-content.ts`        |
| `renderPasswordResetEmail` / `PasswordResetEmailContent`          | Application        | Pure builder: reset URL → `{ subject, text, html }`                                                                                                                                                     | `src/application/auth/password-reset-email-content.ts`      |
| `SEND_VERIFICATION_EMAIL_JOB` / `SendVerificationEmailPayload`    | Application        | Job name `'email.send-verification'` and its `{ email, code }` payload                                                                                                                                  | `src/application/jobs/send-verification-email-job.ts`       |
| `SendVerificationEmailHandler`                                    | Application        | Consumes the job: renders the code email and sends it through the port                                                                                                                                  | `src/application/jobs/send-verification-email-handler.ts`   |
| `SEND_PASSWORD_RESET_EMAIL_JOB` / `SendPasswordResetEmailPayload` | Application        | Job name `'email.send-password-reset'` and its `{ email, token }` payload                                                                                                                               | `src/application/jobs/send-password-reset-email-job.ts`     |
| `SendPasswordResetEmailHandler`                                   | Application        | Consumes the job: builds the reset URL from `passwordResetUrlBase` + percent-encoded token, renders, sends                                                                                              | `src/application/jobs/send-password-reset-email-handler.ts` |
| `NodemailerEmailSender`                                           | Infrastructure     | `EmailSender` adapter: one Nodemailer transport built from SMTP config; stamps the From address on every message                                                                                        | `src/infrastructure/email/nodemailer-email-sender.ts`       |
| Container wiring                                                  | Composition root   | Binds the port to `NodemailerEmailSender` (fed from `env.SMTP_*` / `env.EMAIL_FROM`), registers both handlers, provides `passwordResetUrlBase`, and files the handlers into the worker's handler record | `src/container.ts`                                          |
| `purge-verification-jobs`                                         | Operational script | Removes dead-lettered `email.send-verification` jobs (whose payloads hold raw codes) from the failed set                                                                                                | `src/scripts/purge-verification-jobs.ts`                    |

## Public surface

This is an infrastructure feature; its contract is programmatic, not HTTP.

### The `EmailSender` port — what a consumer calls

```ts
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
```

Semantics a caller can rely on:

- `text` is mandatory; `html` is optional — send both when you have both (the two shipped flows do), and every recipient gets a readable message either way.
- There is deliberately no `from`, `cc`, `bcc`, or attachment field. The From identity belongs to the adapter (`EMAIL_FROM`); the rest is unneeded surface until a feature needs it.
- `send` resolves once the SMTP transport has accepted the message and **rejects on failure instead of swallowing it**. Do not wrap it in a try/catch inside a job handler — the propagated error is what drives the queue's retry.

### The content builders

```ts
export function renderVerificationEmail(code: string): VerificationEmailContent;
export function renderPasswordResetEmail(resetUrl: string): PasswordResetEmailContent;
```

Both return `{ subject: string; text: string; html: string }`, are pure (same input, identical output — a retried job resends byte-identical content), and keep the secret out of the `subject`, because subjects surface in OS notifications and mail-client previews.

### The job-level surface

In practice a feature "sends an email" by enqueuing one of these jobs on the `JobQueue` port, not by calling `EmailSender` inline — that is what keeps SMTP off the request path.

| Job name                                                      | Payload                                                              | Handler                         | Enqueued by                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `email.send-verification` (`SEND_VERIFICATION_EMAIL_JOB`)     | `SendVerificationEmailPayload` — `{ email: string; code: string }`   | `SendVerificationEmailHandler`  | `RegisterUser` (`src/application/auth/register-user.ts`), `EditUser` (`src/application/user/edit-user.ts`) |
| `email.send-password-reset` (`SEND_PASSWORD_RESET_EMAIL_JOB`) | `SendPasswordResetEmailPayload` — `{ email: string; token: string }` | `SendPasswordResetEmailHandler` | `RequestPasswordReset` (`src/application/auth/request-password-reset.ts`)                                  |

## Configuration

Read from `src/config/env.ts`. Keys declared with `devDefault` only are **required in production** and defaulted only when `NODE_ENV` is `development` or `test`. The last two rows are queue keys this feature depends on but does not own; they are listed because the purge script below cannot be run without them.

| Variable                  | Default                                                                        | Meaning                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`               | `localhost` (dev/test only; required in production)                            | SMTP server the transport connects to.                                                                                                                                                                                |
| `SMTP_PORT`               | `587` (production); `1025` in dev/test                                         | SMTP port. The dev default is the local Mailpit catcher's port; production defaults to the STARTTLS submission port.                                                                                                  |
| `SMTP_SECURE`             | `false`                                                                        | `true` for port 465 (implicit TLS); `false` uses STARTTLS.                                                                                                                                                            |
| `SMTP_REQUIRE_TLS`        | `true` (production); `false` in dev/test                                       | Refuse to send if STARTTLS cannot be negotiated. Keep on in prod; off for a plaintext dev catcher.                                                                                                                    |
| `SMTP_USER`               | `''` (empty)                                                                   | SMTP auth user. **Empty means no auth** — the adapter passes `auth: undefined`, so no authentication is attempted (the local-catcher case).                                                                           |
| `SMTP_PASSWORD`           | `''` (empty)                                                                   | SMTP auth password; unused when `SMTP_USER` is empty.                                                                                                                                                                 |
| `EMAIL_FROM`              | `no-reply@app.local` (dev/test only; required in production)                   | Default From address the adapter stamps on every outbound message.                                                                                                                                                    |
| `PASSWORD_RESET_URL_BASE` | `http://localhost:5173/reset-password` (dev/test only; required in production) | Frontend URL the reset email links to; `SendPasswordResetEmailHandler` appends the raw token as `?token=`. Owned by the [password-reset.md](./password-reset.md) flow, consumed here to build the link.               |
| `REDIS_URL`               | `redis://127.0.0.1:6379` (dev/test only; required in production)               | Redis instance backing BullMQ. Read here by `src/scripts/purge-verification-jobs.ts` to open the queue whose failed set it sweeps. Owned by [background-jobs.md](./background-jobs.md).                               |
| `QUEUE_PREFIX`            | `app`                                                                          | Key prefix BullMQ applies to every queue key in Redis. The purge script must run with the same value the producing app used, or it inspects an empty failed set. Owned by [background-jobs.md](./background-jobs.md). |

`.env.example` mirrors the SMTP keys with the dev-catcher values (`SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=false`, empty credentials). Its comment names the intended local setup: _"Dev defaults target a local Mailpit catcher on :1025."_ Note that `docker-compose.yml` does **not** provision a mail service — Mailpit is something you run yourself alongside `npm run dev`:

```bash
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

SMTP listens on `1025`, matching the `SMTP_PORT` dev default, and the web inbox is at `http://localhost:8025`. The compose stack only forwards `SMTP_HOST` and `EMAIL_FROM` from the host environment (falling back to `localhost` / `no-reply@app.local`), and because it runs with `NODE_ENV: production`, the production defaults apply inside it: port `587`, `SMTP_REQUIRE_TLS=true`. A real SMTP host must therefore be supplied to the compose stack for mail to leave it; the `localhost` fallback points at the app container itself.

## Usage & extension

### Sending an email from a new feature

Follow the pattern the two live flows set: a pure content builder, a job handler that takes `emailSender` from the cradle, and a producer that enqueues. The worked example below adds a welcome email, `email.send-welcome`.

It is deliberately the same job that [background-jobs.md](./background-jobs.md#usage--extension) walks through, and the two docs split it cleanly: **that doc owns the transport-side wiring** — the `JOB_NAMES` catalogue entry, the `Cradle` declaration, the handler registration, and the `jobWorker` handler record — while **this section owns the send half**. To keep them composable, the payload type is reused verbatim from there:

```ts
// src/application/jobs/send-welcome-email-job.ts — defined in background-jobs.md, Step 1
export const SEND_WELCOME_EMAIL_JOB = 'email.send-welcome';

export interface SendWelcomeEmailPayload {
  userId: string;
  email: string;
}
```

**1. A pure content builder** — `src/application/user/welcome-email-content.ts`. It may only take values the payload actually carries, since the handler has nothing else to hand it:

```ts
export interface WelcomeEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function renderWelcomeEmail(recipient: string): WelcomeEmailContent {
  const subject = 'Welcome';
  const text = `Your account for ${recipient} is ready. You can sign in now.`;
  const html = `<p>Your account for <strong>${recipient}</strong> is ready. You can sign in now.</p>`;
  return { subject, text, html };
}
```

**2. A job handler that injects the port** — `src/application/jobs/send-welcome-email-handler.ts`. The constructor destructures `emailSender` from the cradle (Awilix injects by parameter name), the handler renders, then calls `send`:

```ts
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { EmailSender } from '@/application/shared/ports/email-sender';
import { renderWelcomeEmail } from '@/application/user/welcome-email-content';
import {
  SEND_WELCOME_EMAIL_JOB,
  type SendWelcomeEmailPayload,
} from '@/application/jobs/send-welcome-email-job';

export interface SendWelcomeEmailHandlerDeps {
  emailSender: EmailSender;
}

export class SendWelcomeEmailHandler implements JobHandler<
  SendWelcomeEmailPayload,
  typeof SEND_WELCOME_EMAIL_JOB
> {
  readonly jobName = SEND_WELCOME_EMAIL_JOB;
  private readonly emailSender: EmailSender;

  constructor({ emailSender }: SendWelcomeEmailHandlerDeps) {
    this.emailSender = emailSender;
  }

  async handle(payload: SendWelcomeEmailPayload): Promise<void> {
    const content = renderWelcomeEmail(payload.email);
    await this.emailSender.send({
      to: payload.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }
}
```

This handler replaces the logging placeholder shown in background-jobs.md's Step 2; everything else there applies unchanged.

**3. Wire it, then enqueue.** Add the name to `JOB_NAMES`, declare `sendWelcomeEmailHandler` on the `Cradle` **by its port type**, register it with `asClass(SendWelcomeEmailHandler).singleton()`, and file it in the `jobWorker` handler record — all four are shown in full in [background-jobs.md](./background-jobs.md#usage--extension). Then enqueue from the producing use case, after its database work has committed:

```ts
const payload: SendWelcomeEmailPayload = { userId: user.id, email: user.email.toString() };
await this.queue.enqueue(SEND_WELCOME_EMAIL_JOB, payload);
```

`user.id` and `user.email` are getters on the `User` aggregate (`src/domain/user/user-entity.ts`): `id` comes from the `Entity` base class, and `email` returns the `Email` value object, hence the `toString()`. The live producers reach the same string by a slightly different route — `RegisterUser` builds `{ email: email.toString(), code: rawCode }` from the local `Email` value object it created a few lines earlier (`register-user.ts:91`), rather than reading it back off the entity. Either is correct; what matters is that the payload is a plain JSON-serializable object, because that is what BullMQ stores in Redis.

Nothing stops a component from injecting `emailSender` and calling `send` inline instead — the port is in the cradle — but no production code does, and yours should not either: an inline call puts SMTP latency and SMTP outages on your caller's response, and forfeits the queue's retries.

### Swapping or extending the adapter

Any class implementing `EmailSender` can replace SMTP wholesale; the rebinding is one registration. Which _form_ of registration, though, depends on what the new adapter's constructor takes — and getting it wrong produces a runtime resolution failure, not a compile error.

The container is created with `InjectionMode.PROXY` and `strict: true` (`src/worker.ts:17`), so Awilix hands each constructor a cradle proxy and resolves the destructured parameter names as registrations. That gives two cases:

- **Dependencies already in the cradle** (`logger`, `clock`, `jobQueue`, …) → bind with `asClass`. Awilix resolves each destructured name to its registration.
- **Adapters taking primitive config** (`host`, `port`, `apiKey`, …) → bind with `asFunction(() => new X({ ... }))`, reading `env` explicitly inside the factory. An `asClass` binding here would send Awilix looking for registrations named `host`, `port`, `apiKey` — none exist, and the resolution throws the first time something asks for `emailSender`.

`NodemailerEmailSender` is the second case, which is why the live registration in `src/container.ts` (lines 254–265) is a factory, not a class binding:

```ts
emailSender: asFunction(
  () =>
    new NodemailerEmailSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTls: env.SMTP_REQUIRE_TLS,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.EMAIL_FROM,
    }),
).singleton(),
```

A complete replacement of the first kind — an adapter that suppresses delivery and logs instead, useful for load tests or a mail-less environment — `src/infrastructure/email/logging-email-sender.ts`:

```ts
import type { EmailSender, EmailMessage } from '@/application/shared/ports/email-sender';
import type { Logger } from '@/application/shared/ports/logger';

export interface LoggingEmailSenderDeps {
  logger: Logger;
}

export class LoggingEmailSender implements EmailSender {
  private readonly logger: Logger;

  constructor({ logger }: LoggingEmailSenderDeps) {
    this.logger = logger;
  }

  send(message: EmailMessage): Promise<void> {
    this.logger.info('Email suppressed', { to: message.to, subject: message.subject });
    return Promise.resolve();
  }
}
```

Its only dependency, `logger`, is a cradle registration, so it binds with `asClass` — replace the whole `asFunction` block above with:

```ts
emailSender: asClass(LoggingEmailSender).singleton(),
```

A provider-API adapter (SES, Postmark, Resend) is the second kind again — it takes an API key and a From address as primitives, so it keeps the factory form:

```ts
emailSender: asFunction(
  () =>
    new ResendEmailSender({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    }),
).singleton(),
```

Implement it under `src/infrastructure/email/`, add whatever new keys it needs to `src/config/env.ts` and `.env.example`, and rebind. Handlers, builders, and flows are untouched — they compile against the interface only.

### Purging dead-lettered sends

A send that exhausts its retries leaves the job — payload and all — in the shared failed set, where an `email.send-verification` payload is a raw verification code sitting in Redis. Clear those jobs with:

```bash
npx tsx src/scripts/purge-verification-jobs.ts
```

There is no npm script for it in `package.json`; run it directly against the target environment's `REDIS_URL` and `QUEUE_PREFIX` (the two variables it reads, `purge-verification-jobs.ts:10-11`). It pages the failed set, keeps only jobs whose name is `email.send-verification`, and removes those — deliberately not `queue.clean(…, 'failed')`, because the same failed set also holds dead-lettered `domain-event.dispatch` jobs, which are the only surviving copy of their event. It prints a summary line with the removed and inspected counts. See [background-jobs.md](./background-jobs.md#operating-the-queue) for the queue-side view of the same script.

No equivalent purge exists for `email.send-password-reset` jobs; their tokens age out with the retention window instead.

## Design decisions & trade-offs

- **Delivery always rides the job queue; the port is never called on a request path.** Every producer enqueues and returns, so a slow or unreachable SMTP server cannot stretch a registration or password-reset response, and retries come free from the queue (3 attempts, exponential backoff from a 1 s base) instead of being re-implemented per caller. A side benefit for the reset flow: `RequestPasswordReset` returns identically and near-instantly whether or not an account exists, so response timing does not betray which addresses have accounts. Two costs come with it. The first is a hard dependency on the worker process — with the worker down, emails queue up rather than send. The second is sharper: **the enqueue itself is the one unprotected step.** `RegisterUser` (`register-user.ts:85-92`), `EditUser` (`edit-user.ts:96`) and `RequestPasswordReset` (`request-password-reset.ts:66`) each `await` the enqueue after the transaction has committed, and none wraps it in a `catch`, so a Redis outage rejects the HTTP request while the user row or reset token is already durable — committed-but-unmailed, with nothing to retry the send. An SMTP outage is absorbed by the queue's retries; a queue outage is absorbed by nothing, and surfaces to the caller as a failed request over durable state.
- **The port is deliberately minimal — no `from`, no cc/bcc, no attachments.** The From identity is configuration (`EMAIL_FROM`), stamped by the adapter, so no feature can vary or spoof it and a From change is an env change, not a code change. The unshipped fields are omitted until a feature needs them, rather than speculatively supported; adding one is an interface extension plus one adapter line.
- **Content builders are pure functions, separate from both the flows and the handlers.** `renderVerificationEmail` and `renderPasswordResetEmail` take a string in and return `{ subject, text, html }` — no clock, no config, no I/O — so copy is unit-testable by string assertion and a retried job resends identical content. Both keep the secret out of the subject line on purpose: subjects leak into lock-screen notifications and mail-list previews, where a verification code should not appear.
- **Errors propagate; nothing in the chain catches.** `NodemailerEmailSender.send` awaits `sendMail` and lets rejections escape; the handlers do the same. Retry policy belongs to the queue, not the mailer — a swallowed error would mark the job complete and silently lose the email. The tests pin this contract at both levels ("propagates transport failures instead of swallowing them" for the SMTP adapter, "propagates a delivery failure so the worker can retry" for each handler).
- **At-least-once delivery is accepted: a user may occasionally get the same email twice.** No producer passes a `deduplicationKey`, and the handlers are not idempotent — if SMTP accepts the message but the attempt still fails afterwards (a timeout, a worker crash before ack), the retry sends again. For a verification code or reset link a duplicate is harmless (both copies carry the same still-valid secret), so the bookkeeping an exactly-once send would need (recording delivery per code/token) is deliberately not paid.
- **Raw secrets ride the job payload — and that has a retention consequence.** The database stores only hashes — HMAC-SHA256 for verification codes, SHA-256 for reset tokens — so the enqueued `{ email, code }` / `{ email, token }` payload is the only sendable copy; there is no way to rebuild the email later. The flip side: BullMQ retains failed jobs, payloads included, for 7 days, or until the failed set exceeds 5000 jobs, whichever binds first (`removeOnFail: { age: SEVEN_DAYS_SECONDS, count: KEEP_FAILED_COUNT }` with `KEEP_FAILED_COUNT = 5000`, `bullmq-job-queue.ts:12-15`) — so a dead-lettered send leaves a raw code sitting in Redis for that window. Redis is not the only place it is readable, either: when `BULL_BOARD_ENABLED=true`, the dashboard's job view renders a failed job's payload in the browser to anyone holding the Basic-auth credentials (see [background-jobs.md](./background-jobs.md#bull-board-dashboard--operational-visibility)). `src/scripts/purge-verification-jobs.ts` shortens the window for verification codes by removing dead-lettered `email.send-verification` jobs, filtering by job name so that dead-lettered domain-event jobs in the shared `default` queue's failed set survive. No equivalent purge exists yet for `email.send-password-reset` jobs — their tokens age out with the retention rule above.
- **One Nodemailer adapter spans dev catcher and production SMTP via config, not code.** The same `NodemailerEmailSender` serves both worlds: `SMTP_USER=''` makes it pass `auth: undefined` so no authentication is attempted against a local Mailpit on `:1025`, while production defaults (`SMTP_PORT=587`, `SMTP_REQUIRE_TLS=true`) enforce STARTTLS — the adapter maps `requireTls` onto Nodemailer's `requireTLS`, which refuses to fall back to plaintext if the server cannot negotiate TLS. `SMTP_SECURE=true` covers implicit-TLS (port 465) deployments. The alternative — a separate fake sender wired in dev — would leave the real adapter unexercised until production.

## Testing

All coverage is unit-level; the Nodemailer transport is mocked, and no integration test opens a real SMTP connection (the catcher is a manual dev tool, not part of the test harness). Run everything with `npm test` (`vitest run`).

- **`src/infrastructure/email/nodemailer-email-sender.test.ts`** — the adapter, against a mocked `nodemailer.createTransport`: the transport is built from the SMTP config (including the `requireTls` → `requireTLS` mapping), `auth` is omitted when no user is configured and passed as `{ user, pass }` when one is, `send` maps the message plus the configured From onto `sendMail`, and SMTP failures propagate instead of being swallowed.
- **`src/application/auth/verification-email-content.test.ts`** — the verification builder: non-empty subject, the code appears in both text and HTML bodies, a zero-padded code survives verbatim, rendering is pure (same code → identical content), and the subject never contains the code.
- **`src/application/auth/password-reset-email-content.test.ts`** — the reset builder, same shape: non-empty subject, the URL in both bodies, purity, and a URL-free subject.
- **`src/application/jobs/send-verification-email-handler.test.ts`** — the handler with a stubbed `EmailSender`: it exposes `SEND_VERIFICATION_EMAIL_JOB` as its `jobName`, sends exactly one message to the payload address carrying the rendered subject/text/html, and re-throws a delivery failure so the worker can retry.
- **`src/application/jobs/send-password-reset-email-handler.test.ts`** — likewise for the reset handler, plus the URL construction: the reset URL is the configured base with `?token=` appended, and a token containing URL-sensitive characters (`a+b/c=`) is percent-encoded (`a%2Bb%2Fc%3D`).

Two gaps are worth knowing about. `src/scripts/purge-verification-jobs.ts` has **no test** — it is a short operational script, verified by running it against a real Redis. And the queue-to-handler delivery these handlers depend on is not re-proven here; it is covered by the queue's own integration tests — see [background-jobs.md](./background-jobs.md#testing).
