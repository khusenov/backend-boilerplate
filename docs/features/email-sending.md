# Email Sending

> **Status:** Complete · **Layers:** application, infrastructure, composition root · **Verified against:** `7150871`

## Purpose

Two flows — email verification and password reset — must deliver a secret to a user's inbox, and neither should know what SMTP is. This feature is the delivery mechanism they share. It is built around a **port** and an **adapter**: the port is `EmailSender`, the application-layer interface that application code programs against; the adapter is `NodemailerEmailSender`, the single infrastructure implementation sitting behind that interface, which owns every SMTP concern (host, TLS, auth, the From address). Around them sit pure content builders that render each message and job handlers that consume send requests off the background queue. It exists so that sending an email is a one-line port call for application code, while the operational realities of SMTP — latency, transient failure, credentials, dev catchers — stay in one infrastructure file and the environment.

## How it works

No email is sent inline on an HTTP request. A use case that wants mail delivered enqueues a job and returns; the worker process does the sending.

1. **A flow enqueues a send job.** `RegisterUser` and `EditUser` (on an email change) enqueue `SEND_VERIFICATION_EMAIL_JOB` (`'email.send-verification'`) with a `SendVerificationEmailPayload` of `{ email, code }`; `RequestPasswordReset` enqueues `SEND_PASSWORD_RESET_EMAIL_JOB` (`'email.send-password-reset'`) with a `SendPasswordResetEmailPayload` of `{ email, token }`. The `code`/`token` in the payload is the **raw** secret — the database keeps only a hash (HMAC-SHA256 for codes, SHA-256 for tokens), so the queue payload is the only place the sendable form exists. Why each flow sends what it sends is those features' story: see [email-verification.md](./email-verification.md) and [password-reset.md](./password-reset.md).
2. **The worker routes the job to its handler.** The worker process builds its Awilix container with `createAppContainer(logger)` (`src/worker.ts`) and calls `startWorker(container)`, which resolves `jobWorker` (`src/start-worker.ts`). Constructing `JobWorker` opens the BullMQ `Worker` and indexes every handler it was given into a `Map` keyed by `handler.jobName`. When a job arrives, `JobWorker.process` looks up `this.handlers.get(job.name)` and calls `handler.handle(...)` — for these two names, `SendVerificationEmailHandler` or `SendPasswordResetEmailHandler`, both filed into the `jobWorker` handler record in `src/composition/jobs.ts`. The queue transport itself is [background-jobs.md](./background-jobs.md).
3. **The handler builds the content.** `SendVerificationEmailHandler.handle` calls `renderVerificationEmail(payload.code)`. `SendPasswordResetEmailHandler.handle` first assembles the link — `` `${this.urlBase}?token=${encodeURIComponent(payload.token)}` ``, where `urlBase` is the injected `passwordResetUrlBase` (from `PASSWORD_RESET_URL_BASE`) — then calls `renderPasswordResetEmail(resetUrl)`. Both builders are pure functions returning `{ subject, text, html }`.
4. **The handler calls the port.** It invokes `emailSender.send({ to: payload.email, subject, text, html })`. The message names no From address: that identity is not part of the port's contract.
5. **The adapter talks SMTP.** `NodemailerEmailSender` maps the message onto `transporter.sendMail`, adding the configured `from` (`EMAIL_FROM`). Its Nodemailer transport was built once at construction from the `SMTP_*` settings, translating `requireTls` to Nodemailer's `requireTLS` and passing `auth: undefined` when `SMTP_USER` is empty, so no authentication is attempted (the local-catcher case).
6. **A send failure means retry, then dead-letter.** _Dead-letter_ is BullMQ's term for a job that has exhausted its attempts and is parked in the queue's **failed set** instead of being retried again; there is no separate dead-letter queue. The adapter and the handlers deliberately catch nothing: a `sendMail` rejection propagates out of `handle`, which is the signal BullMQ needs to retry — 3 attempts by default (no email producer overrides it) with a fixed exponential backoff from a 1 s base (`src/infrastructure/jobs/bullmq-job-queue.ts`). While attempts remain, `JobWorker` logs `'Job attempt failed, retry pending'` at `warn`; once BullMQ has decided against a further retry it logs `'Job dead-lettered, no retry remains'` at `error`. A dead-lettered job is retained in the failed set for 7 days, or until the failed set exceeds 5 000 jobs, whichever binds first — payload included. Because that payload carries a raw verification code, `src/scripts/purge-verification-jobs.ts` exists to remove dead-lettered `email.send-verification` jobs from Redis.
7. **A stalled send is the third failure path — and the one that duplicates mail.** BullMQ holds a processing lock while a handler runs; if the send outlives that lock (a hung SMTP connection, a worker killed mid-`sendMail`), BullMQ returns the job to the wait list and emits `'stalled'` rather than `'failed'`. `JobWorker` subscribes to it and logs `'Job stalled, its processing lock expired'` at `warn`. This is the path by which a message SMTP already accepted gets sent a second time — see the at-least-once bullet in [Design decisions](#design-decisions--trade-offs).
8. **An enqueue failure behaves differently — it reaches the caller.** All three enqueue sites `await` the enqueue with no `try`/`catch`, and they do so _after_ their database transaction has committed. If Redis is unreachable, the rejection propagates out of `execute` and the HTTP request fails — but the user row, or the reset token, is already durable. The result is a committed-but-unmailed state that nothing retries. See [Design decisions](#design-decisions--trade-offs) for why that trade is accepted and what it means operationally.

## Architecture

The application layer owns the abstraction and everything that decides _what_ to send: the `EmailSender` port, the two pure content builders, and the job handlers that consume send requests. The infrastructure layer owns _how_ it is sent: `NodemailerEmailSender` is the only file that imports `nodemailer` or speaks SMTP; the keys themselves are declared in `src/config/env.ts` and read once in the `emailSender` factory. Dependencies point inward — the handlers depend on the `EmailSender` interface, and the concrete adapter is bound to it in exactly one place, the `emailSender` registration in `src/composition/email.ts`. Throughout this doc the **cradle** is Awilix's registry proxy: the object of named registrations a constructor destructures its dependencies out of, and that a caller reads as `container.cradle.<key>`. `src/composition/email.ts` is a slice of the composition root, not a layer: `src/composition/**` may see both application and infrastructure, and dependency-cruiser's `composition-modules-are-not-importable` rule (`.dependency-cruiser.cjs`) makes importing one from anywhere but `src/container.ts` a build error. Swapping SMTP for a provider API is a new adapter plus one rebinding; no application file changes.

| Component                                                         | Layer              | Responsibility                                                                                                                                                             | File                                                        |
| ----------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `EmailSender` / `EmailMessage`                                    | Application (port) | Contract to deliver one message (`to`, `subject`, `text`, optional `html`); the From identity is excluded by design                                                        | `src/application/shared/ports/email-sender.ts`              |
| `renderVerificationEmail` / `VerificationEmailContent`            | Application        | Pure builder: verification code → `{ subject, text, html }`                                                                                                                | `src/application/auth/verification-email-content.ts`        |
| `renderPasswordResetEmail` / `PasswordResetEmailContent`          | Application        | Pure builder: reset URL → `{ subject, text, html }`                                                                                                                        | `src/application/auth/password-reset-email-content.ts`      |
| `SEND_VERIFICATION_EMAIL_JOB` / `SendVerificationEmailPayload`    | Application        | Job name `'email.send-verification'` and its `{ email, code }` payload                                                                                                     | `src/application/jobs/send-verification-email-job.ts`       |
| `SendVerificationEmailHandler`                                    | Application        | Consumes the job: renders the code email and sends it through the port                                                                                                     | `src/application/jobs/send-verification-email-handler.ts`   |
| `SEND_PASSWORD_RESET_EMAIL_JOB` / `SendPasswordResetEmailPayload` | Application        | Job name `'email.send-password-reset'` and its `{ email, token }` payload                                                                                                  | `src/application/jobs/send-password-reset-email-job.ts`     |
| `SendPasswordResetEmailHandler`                                   | Application        | Consumes the job: builds the reset URL from `passwordResetUrlBase` + percent-encoded token, renders, sends                                                                 | `src/application/jobs/send-password-reset-email-handler.ts` |
| `NodemailerEmailSender`                                           | Infrastructure     | `EmailSender` adapter: one Nodemailer transport built from SMTP config; stamps the From address on every message                                                           | `src/infrastructure/email/nodemailer-email-sender.ts`       |
| `emailRegistrations`                                              | Composition root   | Declares `emailSender: EmailSender` on the `Cradle` and binds it to `NodemailerEmailSender` with `asFunction(...).singleton()`, fed from `env.SMTP_*` and `env.EMAIL_FROM` | `src/composition/email.ts`                                  |
| `jobsRegistrations`                                               | Composition root   | Registers both handlers with `asClass(...).singleton()` and files them into the `jobWorker` handler record under their job names                                           | `src/composition/jobs.ts`                                   |
| `authRegistrations`                                               | Composition root   | Supplies `passwordResetUrlBase` as `asValue(env.PASSWORD_RESET_URL_BASE)`, the one config value the reset handler injects                                                  | `src/composition/auth.ts`                                   |
| `createRegistrations` / `createAppContainer`                      | Composition root   | Merges every module into one `CompleteRegistrations` map and builds the process container from the shared `APP_CONTAINER_OPTIONS`                                          | `src/composition/compose.ts`, `src/container.ts`            |
| `purge-verification-jobs`                                         | Operational script | Removes dead-lettered `email.send-verification` jobs (whose payloads hold raw codes) from the failed set                                                                   | `src/scripts/purge-verification-jobs.ts`                    |

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
- `send` returns `Promise<void>`: no provider message id comes back, and nothing in the codebase consumes bounces or delivery receipts. **Acceptance by the SMTP transport is the strongest delivery signal available** — a resolved `send` means the server took the message, not that a mailbox received it.

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

Read from `src/config/env.ts` (envalid). A key declared with a `devDefault` and no `default` has no production value: it is required at boot when `NODE_ENV=production`, and the `devDefault` applies everywhere else. A key with both (`SMTP_PORT`, `SMTP_REQUIRE_TLS`) falls back to its `default` in production. The last three rows are queue keys this feature depends on but does not own: the purge script below cannot be run without the first two, and `QUEUE_CONCURRENCY` bounds how much of this feature's work runs at once.

| Variable                  | Default                                                 | Meaning                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NAME`                | `app`                                                   | Service identity prefix. It reaches this feature twice: it derives `EMAIL_FROM`'s dev default (`no-reply@<APP_NAME>.local`) and it is the default for `QUEUE_PREFIX`, so renaming it moves both.                      |
| `SMTP_HOST`               | `—` (devDefault `localhost`)                            | SMTP server the transport connects to. Parsed by envalid's `host()`, so it is a hostname or IP only — the port is `SMTP_PORT`, never appended here.                                                                   |
| `SMTP_PORT`               | `587` (devDefault `1025`)                               | SMTP port. The dev default is the local Mailpit catcher's port; the production default is the STARTTLS submission port.                                                                                               |
| `SMTP_SECURE`             | `false`                                                 | `true` for port 465 (implicit TLS); `false` uses STARTTLS.                                                                                                                                                            |
| `SMTP_REQUIRE_TLS`        | `true` (devDefault `false`)                             | Refuse to send if STARTTLS cannot be negotiated. Keep on in production; off for a plaintext dev catcher.                                                                                                              |
| `SMTP_USER`               | `''` (empty)                                            | SMTP auth user. **Empty means no auth** — the adapter passes `auth: undefined`, so no authentication is attempted (the local-catcher case).                                                                           |
| `SMTP_PASSWORD`           | `''` (empty)                                            | SMTP auth password; unused when `SMTP_USER` is empty.                                                                                                                                                                 |
| `EMAIL_FROM`              | `—` (devDefault `no-reply@<APP_NAME>.local`)            | Default From address the adapter stamps on every outbound message. Validated as an email address by envalid.                                                                                                          |
| `PASSWORD_RESET_URL_BASE` | `—` (devDefault `http://localhost:5173/reset-password`) | Frontend URL the reset email links to; `SendPasswordResetEmailHandler` appends the raw token as `?token=`. Owned by the [password-reset.md](./password-reset.md) flow, consumed here to build the link.               |
| `REDIS_URL`               | `—` (devDefault `redis://127.0.0.1:6379`)               | Redis instance backing BullMQ. Read here by `src/scripts/purge-verification-jobs.ts` to open the queue whose failed set it sweeps. Owned by [background-jobs.md](./background-jobs.md).                               |
| `QUEUE_PREFIX`            | `app` (the value of `APP_NAME`)                         | Key prefix BullMQ applies to every queue key in Redis. The purge script must run with the same value the producing app used, or it inspects an empty failed set. Owned by [background-jobs.md](./background-jobs.md). |
| `QUEUE_CONCURRENCY`       | `5`                                                     | How many jobs one worker processes at once, and therefore the ceiling on simultaneous SMTP connections this service opens. It is the first knob to lower against a provider that rate-limits.                         |

`.env.example` mirrors the SMTP keys with the dev-catcher values (`SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=false`, empty credentials), under the comment _"Outbound email (SMTP). Dev defaults target a local Mailpit catcher on :1025."_ `EMAIL_FROM` is left commented out there, because its `devDefault` already derives `no-reply@<APP_NAME>.local`.

### The dev and compose mail catcher

`docker-compose.yml` provisions that catcher as a first-class service — `mailpit` (`axllent/mailpit:v1.21`), publishing `1025` for SMTP and `8025` for its web inbox, with a `/mailpit readyz` healthcheck that both the `app` and `worker` services wait on (`condition: service_healthy`). It runs with `MP_SMTP_AUTH_ACCEPT_ANY` and `MP_SMTP_AUTH_ALLOW_INSECURE`, so it accepts whatever credentials it is handed, including none.

Both host-based and containerized development therefore reach the same catcher, by different addresses:

- **App on the host** (`npm run dev`, with `docker compose up -d mariadb redis mailpit`): the `.env.example` values apply — `SMTP_HOST=localhost` with `SMTP_PORT=1025` reaches Mailpit through its published port. Read the mail at `http://localhost:8025`.
- **Whole stack in compose:** the shared `x-app-environment` block sets `SMTP_HOST: ${SMTP_HOST:-mailpit}`, `SMTP_PORT: ${SMTP_PORT:-1025}` and a hard-coded `SMTP_REQUIRE_TLS: 'false'`, plus `EMAIL_FROM: ${EMAIL_FROM:-no-reply@${APP_NAME:-app}.local}`. Those overrides matter because the stack runs with `NODE_ENV: production`, where the `devDefault`s do not apply and `SMTP_REQUIRE_TLS` would otherwise be `true` against a plaintext catcher.

One gotcha follows from the `${SMTP_HOST:-mailpit}` substitution: compose reads your local `.env`, so an `SMTP_HOST=localhost` tuned for host-based development also reaches the containers — where `localhost` is the app container itself, not Mailpit. Unset `SMTP_HOST` in `.env` so the compose default applies, or run `docker compose --env-file /dev/null up`. `docker compose config` shows what a service actually receives.

**Verifying delivery end to end.** `npm run dev` starts _both_ processes (`concurrently -n web,worker -c blue,magenta "npm:dev:web" "npm:dev:worker"`), so the worker that performs the send is already running — no email is delivered by the web process alone. `POST /v1/auth/register` with a fresh address, then open `http://localhost:8025`: the verification message appears in the Mailpit inbox within a second of the worker picking the job up.

Sending real mail from the stack means pointing `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_REQUIRE_TLS` at a real provider; nothing about the adapter changes.

## Usage & extension

### Sending an email from a new feature

Follow the pattern the two live flows set: a pure content builder, a job handler that takes `emailSender` from the cradle, and a producer that enqueues. The worked example below adds a welcome email, `email.send-welcome`. It is deliberately the same job that [background-jobs.md](./background-jobs.md#usage--extension) walks through, so the two docs can be read together; every line you need is repeated here, so this section stands alone.

**1. The job name and payload** — `src/application/jobs/send-welcome-email-job.ts`:

```ts
export const SEND_WELCOME_EMAIL_JOB = 'email.send-welcome';

export interface SendWelcomeEmailPayload {
  userId: string;
  email: string;
}
```

**2. A pure content builder** — `src/application/user/welcome-email-content.ts`. It may only take values the payload actually carries, since the handler has nothing else to hand it:

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

**3. A job handler that injects the port** — `src/application/jobs/send-welcome-email-handler.ts`. The constructor destructures `emailSender` from the cradle (Awilix injects by parameter name), the handler renders, then calls `send`:

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

The handler above is the send-side half; background-jobs.md wires the same job with a logging stub in place of this class, and carries the transport-side rationale for each of the four wiring lines below.

**4. Wire it.** Four lines, in two files:

```ts
// src/job-catalogue.ts — inside JOB_NAMES
SEND_WELCOME_EMAIL_JOB,

// src/composition/jobs.ts — inside `declare module '@fastify/awilix'`, named by its PORT type
sendWelcomeEmailHandler: JobHandler<SendWelcomeEmailPayload, typeof SEND_WELCOME_EMAIL_JOB>;

// src/composition/jobs.ts — inside jobsRegistrations
sendWelcomeEmailHandler: asClass(SendWelcomeEmailHandler).singleton(),

// src/composition/jobs.ts — inside the jobWorker factory's toJobHandlerList({ … }) record
[SEND_WELCOME_EMAIL_JOB]: sendWelcomeEmailHandler,
```

The last line reads a name the `jobWorker` factory must have in scope, so add `sendWelcomeEmailHandler` to that factory's destructured parameter and to its `Pick<Cradle, …>` union as well. `JobHandlersByName` is keyed off `JOB_NAMES`, so omitting the record entry is a type error rather than a silent drop.

**5. Enqueue** from the producing use case, after its database work has committed:

```ts
const payload: SendWelcomeEmailPayload = { userId: user.id, email: user.email.toString() };
await this.queue.enqueue(SEND_WELCOME_EMAIL_JOB, payload);
```

`user.id` and `user.email` are getters on the `User` aggregate (`src/domain/user/user-entity.ts`): `id` comes from the `Entity` base class, and `email` returns the `Email` value object, hence the `toString()`. What matters is that the payload is a plain JSON-serializable object, because that is exactly what BullMQ stores in Redis.

Nothing stops a component from injecting `emailSender` and calling `send` inline instead — the port is in the cradle — but no production code does, and yours should not either: an inline call puts SMTP latency and SMTP outages on your caller's response, and forfeits the queue's retries.

### Swapping or extending the adapter

Any class implementing `EmailSender` can replace SMTP wholesale; the rebinding is one registration. Which _form_ of registration, though, depends on what the new adapter's constructor takes — and getting it wrong produces a runtime resolution failure, not a compile error.

Every process builds its container from one shared options object, `APP_CONTAINER_OPTIONS` (`src/container-options.ts`):

```ts
export const APP_CONTAINER_OPTIONS = {
  injectionMode: InjectionMode.PROXY,
  strict: true,
} as const satisfies ContainerOptions;
```

`strict: true` is a separate guard: it rejects lifetime mistakes (a `.singleton()` registration resolving a shorter-lived one, or a singleton registered on a scoped container). Only `injectionMode` drives the name-based resolution below.

`createAppContainer` (`src/container.ts`) applies those options and registers everything `createRegistrations(baseLogger)` (`src/composition/compose.ts`) merges together, so the API (`src/main.ts`), the worker (`src/worker.ts`) and the `sync-auth` script (`src/scripts/sync-auth.ts`) each resolve `emailSender` under identical rules. The unit-test kit (`test/unit/support/container.ts`) shares the **options**, not the registrations: `registerTestContainer` builds `createContainer<Cradle>(APP_CONTAINER_OPTIONS)` and registers only the pairs its caller supplies, so it never resolves `emailSender` unless a test registers one itself. `InjectionMode.PROXY` is the rule that matters here: Awilix hands each constructor the cradle proxy and resolves the **destructured parameter names** as registrations. That gives three cases:

- **Dependencies already in the cradle** (`logger`, `clock`, `jobQueue`, …) → bind with `asClass`. Awilix resolves each destructured name to its registration.
- **Adapters taking only primitive config** (`host`, `port`, `apiKey`, …) → bind with `asFunction(() => new X({ ... }))`, reading `env` explicitly inside the factory. An `asClass` binding here would send Awilix looking for registrations named `host`, `port`, `apiKey` — none exist, and the resolution throws the first time something asks for `emailSender`.
- **Adapters taking both** → `asFunction` with a **destructured cradle parameter**:

  ```ts
  emailSender: asFunction(
    ({ logger }: Pick<Cradle, 'logger'>) =>
      new ResendEmailSender({ logger, apiKey: env.RESEND_API_KEY }),
  ).singleton(),
  ```

  The factory receives the same cradle proxy a constructor would, so cradle names come from the parameter and primitives come from `env`. This is the form a real replacement most often needs, and the repo already uses it — `jobQueue` in `src/composition/jobs.ts` takes `{ redisConnection, queuePrefix }` off the cradle exactly this way.

A fourth form, `asValue`, also works — it accepts an already-constructed instance rather than a way to construct one. It is not used for adapters here, because it builds eagerly at registration time (before the container is even resolved from) and gives up both lifetime control and disposers; the [Design decisions](#design-decisions--trade-offs) bullet on the factory binding covers why the SMTP primitives are not registered as `asValue` scalars either.

`NodemailerEmailSender` is the second case, which is why the live registration in `src/composition/email.ts` is a factory, not a class binding:

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

Its only dependency, `logger`, is a cradle registration (`src/composition/platform.ts`), so it binds with `asClass` — replace the whole `asFunction` block above with:

```ts
emailSender: asClass(LoggingEmailSender).singleton(),
```

Implement any provider adapter under `src/infrastructure/email/`, add whatever new keys it needs to `src/config/env.ts` and `.env.example`, and rebind. Handlers, builders, and flows are untouched — they compile against the interface only. The `Cradle` declaration in `src/composition/email.ts` stays as it is: it names the **port**, `emailSender: EmailSender`, so no consumer can accidentally depend on the concrete type.

### Purging dead-lettered sends

A send that exhausts its retries leaves the job — payload and all — in the shared failed set, where an `email.send-verification` payload is a raw verification code sitting in Redis. Clear those jobs with:

```bash
npx tsx src/scripts/purge-verification-jobs.ts
```

There is no npm script for it in `package.json`; run it directly against the target environment's `REDIS_URL` and `QUEUE_PREFIX` (the two variables it reads, `src/scripts/purge-verification-jobs.ts`). It reads one capped slice of the failed set (10 000 jobs; rerun if the backlog is larger), keeps only jobs whose name is `email.send-verification`, and removes those — deliberately not `queue.clean(…, 'failed')`, because the same failed set also holds dead-lettered `domain-event.dispatch` jobs, which are the only surviving copy of their event. It prints one summary line carrying `removed`, `failedInspected` and `queuePrefix`, then closes the queue and the Redis connection. See [background-jobs.md](./background-jobs.md#operating-the-queue) for the queue-side view of the same script.

No equivalent purge exists for `email.send-password-reset` jobs; their tokens age out with the retention window instead.

## Design decisions & trade-offs

- **Delivery always rides the job queue; the port is never called on a request path.** Every producer enqueues and returns, so a slow or unreachable SMTP server cannot stretch a registration or password-reset response, and retries come free from the queue (3 attempts by default, exponential backoff from a 1 s base) instead of being re-implemented per caller. A side benefit for the reset flow: `RequestPasswordReset` returns the same empty result whether or not an account exists, so the _response_ does not disclose which addresses have accounts. It does **not** equalize response timing: the no-account path short-circuits after a single `findByEmail` read, while the account-exists path issues a token, runs a transaction with two writes, and enqueues to Redis — strictly more I/O, with no delay padding anywhere, so a determined attacker could in principle distinguish the two by latency. Two costs come with the queue itself. The first is a hard dependency on the worker process — with the worker down, emails queue up rather than send. The second is sharper: **the enqueue itself is the one unprotected step.** `RegisterUser` (`src/application/auth/register-user.ts`), `EditUser` (`src/application/user/edit-user.ts`) and `RequestPasswordReset` (`src/application/auth/request-password-reset.ts`) each `await` the enqueue after the transaction has committed, and none wraps it in a `catch`, so a Redis outage rejects the HTTP request while the user row or reset token is already durable — committed-but-unmailed, with nothing to retry the send. An SMTP outage is absorbed by the queue's retries; a queue outage is absorbed by nothing, and surfaces to the caller as a failed request over durable state.
- **The port is deliberately minimal — no `from`, no cc/bcc, no attachments.** The From identity is configuration (`EMAIL_FROM`), stamped by the adapter, so no feature can vary or spoof it and a From change is an env change, not a code change. The unshipped fields are omitted until a feature needs them, rather than speculatively supported; adding one is an interface extension plus one adapter line.
- **Content builders are pure functions, separate from both the flows and the handlers.** `renderVerificationEmail` and `renderPasswordResetEmail` take a string in and return `{ subject, text, html }` — no clock, no config, no I/O — so copy is unit-testable by string assertion and a retried job resends identical content. Both keep the secret out of the subject line on purpose: subjects leak into lock-screen notifications and mail-list previews, where a verification code should not appear.
- **Errors propagate; nothing in the chain catches.** `NodemailerEmailSender.send` awaits `sendMail` and lets rejections escape; the handlers do the same. Retry policy belongs to the queue, not the mailer — a swallowed error would mark the job complete and silently lose the email. The tests pin this contract at both levels ("propagates transport failures instead of swallowing them" for the SMTP adapter, "propagates a delivery failure so the worker can retry" for each handler).
- **The adapter is bound by factory, and a test guards that choice.** Under `InjectionMode.PROXY`, an `asClass(NodemailerEmailSender)` binding would make Awilix hunt for cradle registrations called `host`, `port`, `secure` … and fail only at first resolution — in the worker, at the first email, in production. Registering the primitives themselves (`asValue(env.SMTP_HOST)` and friends) was the alternative; it would litter the cradle with a dozen scalar keys that only one class ever reads. The factory keeps them local, and `src/composition/compose.test.ts` resolves `emailSender` among the `CONFIG_BACKED_KEYS` in a test named _"builds the config-backed registrations that asClass would break"_, so the mistake fails the unit suite instead of the deploy.
- **At-least-once delivery is accepted: a user may occasionally get the same email twice.** No producer passes a `deduplicationKey`, and the handlers are not idempotent. The concrete mechanism is the **stalled** path described in step 7 of [How it works](#how-it-works): SMTP accepts the message, the send then outlives BullMQ's processing lock (a hung connection, a worker killed mid-`sendMail`), BullMQ returns the job to the wait list, and the retry sends again. For a verification code or reset link a duplicate is harmless — both copies carry the same still-valid secret — so the bookkeeping an exactly-once send would need (recording delivery per code/token) is deliberately not paid.
- **Raw secrets ride the job payload — and that has a retention consequence.** The database stores only hashes — HMAC-SHA256 for verification codes, SHA-256 for reset tokens — so the enqueued `{ email, code }` / `{ email, token }` payload is the only sendable copy; there is no way to rebuild the email later. The flip side: BullMQ retains failed jobs, payloads included, for 7 days, or until the failed set exceeds 5 000 jobs, whichever binds first (`removeOnFail: { age: SEVEN_DAYS_SECONDS, count: KEEP_FAILED_COUNT }` with `KEEP_FAILED_COUNT = 5000`, `src/infrastructure/jobs/bullmq-job-queue.ts`) — so a dead-lettered send leaves a raw code sitting in Redis for that window. Redis is not the only place it is readable, either: when `BULL_BOARD_ENABLED=true`, the dashboard's job view renders a failed job's payload in the browser to anyone holding the Basic-auth credentials (see [background-jobs.md](./background-jobs.md#bull-board-dashboard--operational-visibility)). `src/scripts/purge-verification-jobs.ts` shortens the window for verification codes by removing dead-lettered `email.send-verification` jobs, filtering by job name so that dead-lettered domain-event jobs in the shared `default` queue's failed set survive. No equivalent purge exists yet for `email.send-password-reset` jobs — their tokens age out with the retention rule above.
- **One Nodemailer adapter spans dev catcher and production SMTP via config, not code.** The same `NodemailerEmailSender` serves both worlds: `SMTP_USER=''` makes it pass `auth: undefined` so no authentication is attempted against the Mailpit catcher on `:1025`, while production defaults (`SMTP_PORT=587`, `SMTP_REQUIRE_TLS=true`) enforce STARTTLS — the adapter maps `requireTls` onto Nodemailer's `requireTLS`, which refuses to fall back to plaintext if the server cannot negotiate TLS. `SMTP_SECURE=true` covers implicit-TLS (port 465) deployments. The alternative — a separate fake sender wired in dev — would leave the real adapter unexercised until production.

## Testing

All coverage is unit-level; the Nodemailer transport is mocked, and no integration test opens a real SMTP connection (Mailpit is a development catcher, not part of the test harness). Run everything with `npm test` (`vitest run`).

- **Unit — `src/infrastructure/email/nodemailer-email-sender.test.ts`.** The adapter, against a mocked `nodemailer.createTransport`: the transport is built from the SMTP config (including the `requireTls` → `requireTLS` mapping), `auth` is omitted when no user is configured and passed as `{ user, pass }` when one is, `send` maps the message plus the configured From onto `sendMail`, and SMTP failures propagate instead of being swallowed.
- **Unit — `src/application/auth/verification-email-content.test.ts`.** The verification builder: non-empty subject, the code appears in both text and HTML bodies, a zero-padded code survives verbatim, rendering is pure (same code → identical content), and the subject never contains the code.
- **Unit — `src/application/auth/password-reset-email-content.test.ts`.** The reset builder, same shape: non-empty subject, the URL in both bodies, purity, and a URL-free subject.
- **Unit — `src/application/jobs/send-verification-email-handler.test.ts`.** The handler with a stubbed `EmailSender`: it exposes `SEND_VERIFICATION_EMAIL_JOB` as its `jobName`, sends exactly one message to the payload address carrying the rendered subject/text/html, and re-throws a delivery failure so the worker can retry.
- **Unit — `src/application/jobs/send-password-reset-email-handler.test.ts`.** Likewise for the reset handler, plus the URL construction: the reset URL is the configured base with `?token=` appended, and a token containing URL-sensitive characters (`a+b/c=`) is percent-encoded (`a%2Bb%2Fc%3D`).
- **Unit — `src/composition/compose.test.ts`.** The wiring, not the behaviour: it builds a real container with `createAppContainer` and asserts that `emailSender` resolves without throwing (as one of the `CONFIG_BACKED_KEYS`), that every cradle key is claimed by exactly one composition module, and that the module key set matches the container's registrations. This is what catches a broken `emailSender` registration at unit-test time.
- **Unit — `src/container.test.ts`.** The container options themselves: `createAppContainer` returns a fresh container per call, keeps a registration override local to it, and builds with `{ injectionMode: InjectionMode.PROXY, strict: true }` — PROXY, which the swapping rules above depend on, plus the `strict` lifetime guard.

Two gaps are worth knowing about. `src/scripts/purge-verification-jobs.ts` has **no test** — it is a short operational script, verified by running it against a real Redis. And the queue-to-handler delivery these handlers depend on is not re-proven here; it is covered by the queue's own integration tests — see [background-jobs.md](./background-jobs.md#testing).
