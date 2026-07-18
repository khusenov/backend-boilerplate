# Structured Logging

> **Status:** Complete · **Layers:** application, infrastructure, presentation · **Verified against:** `46c4a07`

## Purpose

Application and domain code needs to emit diagnostic logs without depending on a concrete logging
library, and every log line produced while handling a request must be correlatable back to that
request. This feature provides a framework-agnostic `Logger` port that inner layers program against,
a Pino-backed adapter that implements it, and a per-request correlation id that is transparently
attached to every log line — so the domain and application layers never import Pino, and an operator
can trace a single request across all the log entries it produced by filtering on one id.

## How it works

The runtime flow has two independent halves that meet inside the logger adapter.

**Establishing the correlation id (per HTTP request).** Fastify is configured in `buildApp` to treat
the `x-request-id` header as the request id (`requestIdHeader`) and to mint a `randomUUID()` when the
header is absent (`genReqId`). The `correlationIdPlugin` registers `@fastify/request-context` and adds
an `onRequest` hook that runs at the very start of every request: it builds a `ContextData` object
`{ correlationId: request.id }`, stores it in the request-scoped context under the key `contextData`,
and echoes the id back to the client in the `x-request-id` response header. Because the hook runs
first, the id is available to everything downstream in that request.

**Making the id available deep in the call stack.** `@fastify/request-context` is backed by Node's
`AsyncLocalStorage`, so the stored `contextData` is visible anywhere within the same asynchronous
execution — a use case, a repository, a domain-event handler — without being passed as an argument.
`RequestContextProvider` (the `ContextProvider` adapter) reads it back with
`requestContext.get('contextData')`.

**Emitting an enriched log line.** When any layer calls `logger.info(message, data)` on the injected
`Logger`, the `PinoLogger` adapter merges the caller's `data` with the current context via
`withContext`, spreading `this.context.getAll()` last so context fields (e.g. `correlationId`) win on
key collision, then forwards to the underlying Pino logger in Pino's `(mergingObject, message)`
argument order. Pino serializes the result as one JSON line to stdout.

Outside an HTTP request (for example a CLI script or a worker), there is no active context: `getAll()`
returns `{}`, so `withContext` simply passes the caller's `data` through unchanged and the log line
carries no `correlationId`. Nothing throws.

## Architecture

The `Logger` and `ContextProvider` **ports** live in the application layer; their **adapters**
(`PinoLogger`, `RequestContextProvider`) live in infrastructure, and the request-scoped correlation id
is seeded in the presentation layer by `correlationIdPlugin`. Dependencies point inward: application
and domain code depend only on the `Logger` interface, never on Pino or `@fastify/request-context`.
The concrete `PinoLogger` — wrapping Fastify's base Pino instance and a `RequestContextProvider` — is
bound to the `logger` port in exactly one place, `src/container.ts`. This is what lets the
`UserCreatedLogHandler` (application layer) log without importing a logging library.

| Component                         | Layer          | Responsibility                                                                  | File                                                     |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Logger`                          | Application    | Port: the `info`/`warn`/`error`/`debug` logging contract inner layers call      | `src/application/shared/ports/logger.ts`                 |
| `ContextProvider`                 | Application    | Port: exposes the current request's `ContextData` (`getAll()`)                  | `src/application/shared/ports/context-provider.ts`       |
| `ContextData`                     | Application    | Shape of the per-request context carried alongside logs (`correlationId`)       | `src/application/shared/ports/context-provider.ts`       |
| `PinoLogger`                      | Infrastructure | `Logger` adapter: enriches each call with context, forwards to Pino             | `src/infrastructure/logging/pino-logger.ts`              |
| `RequestContextProvider`          | Infrastructure | `ContextProvider` adapter over `@fastify/request-context` (`AsyncLocalStorage`) | `src/infrastructure/logging/request-context-provider.ts` |
| `createBaseLogger`                | Infrastructure | Builds a standalone Pino base logger for non-HTTP entry points                  | `src/infrastructure/logging/create-base-logger.ts`       |
| `RequestContextData` augmentation | Infrastructure | Types the `contextData` slot on `@fastify/request-context`                      | `src/infrastructure/logging/request-context-data.d.ts`   |
| `correlationIdPlugin`             | Presentation   | Fastify plugin that assigns and propagates the per-request correlation id       | `src/presentation/http/plugins/correlation-id.ts`        |

## Public surface

This is a cross-cutting infrastructure feature; consumers program against two ports.

**`Logger`** — resolve as `logger` from the container. All methods are fire-and-forget (`void`); the
optional `data` object is merged into the structured output.

```ts
interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}
```

**`ContextProvider`** — resolve as an injected dependency of the logger adapter (rarely needed
directly by feature code, which reads the correlation id implicitly through the logger).

```ts
interface ContextData {
  correlationId: string;
}

interface ContextProvider {
  getAll(): Partial<ContextData>;
}
```

**`correlationIdPlugin`** exports the header constant it reads and writes:

```ts
export const CORRELATION_ID_HEADER = 'x-request-id';
```

`buildApp` reuses this same constant as Fastify's `requestIdHeader`, so the header a client sends, the
id stored in context, and the header echoed on the response are all the same value.

## Configuration

| Variable    | Default | Meaning                                                                                                                              |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LOG_LEVEL` | `info`  | Minimum level Pino emits. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace` (validated by `envalid` in `src/config/env.ts`). |

`LOG_LEVEL` is read in `src/main.ts` and passed as `buildApp({ logLevel: env.LOG_LEVEL })`, which
configures Fastify's logger (`logger: { level: opts.logLevel }`). The same string is what
`createBaseLogger(level)` expects for non-HTTP entry points.

Two related knobs are code options rather than env vars:

- **Request access logging** is controlled by `buildApp`'s `disableRequestLogging` option. `main.ts`
  sets it to `env.isDevelopment`, so Fastify's automatic per-request `incoming request` /
  `request completed` lines are suppressed in development and enabled elsewhere. This does not affect
  logs your code emits through the `Logger` port.
- **Output format** is Pino's default: newline-delimited JSON to stdout. There is no pretty-printer
  configured (no `pino-pretty` transport), so logs are machine-parseable in every environment; pipe
  them through a formatter locally if you want them colorized.

## Usage & extension

**Resolve and use the logger from a use case.** Feature classes receive `logger` by constructor
injection (Awilix `PROXY` mode injects the `Cradle` object). Log a message with structured fields;
the correlation id is attached for you when a request is in flight. This is exactly what the
`UserCreatedLogHandler` does (`src/application/user/events/user-created-log-handler.ts`):

```ts
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

interface UserCreatedLogHandlerDeps {
  logger: Logger;
}

export class UserCreatedLogHandler implements DomainEventHandler<UserCreatedEvent> {
  readonly eventName = UserCreatedEvent.EVENT_NAME;
  private readonly logger: Logger;

  constructor({ logger }: UserCreatedLogHandlerDeps) {
    this.logger = logger;
  }

  handle(event: UserCreatedEvent): Promise<void> {
    this.logger.info('User created', {
      aggregateId: event.aggregateId,
      email: event.email,
      occurredAt: event.occurredAt.toISOString(),
    });
    return Promise.resolve();
  }
}
```

When this runs inside an HTTP request, the emitted line includes `correlationId` automatically:

```json
{
  "level": 30,
  "msg": "User created",
  "aggregateId": "…",
  "email": "…",
  "occurredAt": "…",
  "correlationId": "…"
}
```

**Add a new field to the request context.** To carry another piece of ambient data (e.g. an
authenticated `userId`) on every log line:

1. Extend `ContextData` in `src/application/shared/ports/context-provider.ts`:
   ```ts
   export interface ContextData {
     correlationId: string;
     userId: string;
   }
   ```
2. Populate it where you know the value. The correlation id is set in `correlationIdPlugin`'s
   `onRequest` hook; a field known only after authentication would be merged in from the auth plugin,
   e.g. `requestContext.set('contextData', { ...requestContext.get('contextData'), userId })`.
3. Nothing else changes: `RequestContextProvider.getAll()` returns the whole object and `PinoLogger`
   spreads every field, so the new key appears on all subsequent log lines in that request.

**Log from a non-HTTP entry point (CLI script, standalone worker).** There is no Fastify instance to
supply `app.log`, so build a base logger and wrap it in the same adapters:

```ts
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { PinoLogger } from '@/infrastructure/logging/pino-logger';
import { RequestContextProvider } from '@/infrastructure/logging/request-context-provider';
import { env } from '@/config/env';

const logger = new PinoLogger(createBaseLogger(env.LOG_LEVEL), new RequestContextProvider());
logger.info('worker started');
```

## Design decisions & trade-offs

- **Port-based logger so inner layers never import Pino.** `Logger` is a four-method interface in the
  application layer; only `PinoLogger` (infrastructure) and `container.ts` (composition root) know
  about Pino. This keeps the Dependency Rule intact — swapping the logging backend, or logging to a
  different sink in tests, is a one-line change in `container.ts` and requires no edits to domain or
  application code. The cost is a thin indirection layer and a deliberately minimal API (no child
  loggers, no per-call level, no bindings) versus using Pino's richer surface directly.
- **`ContextProvider` (`AsyncLocalStorage`) instead of threading a logger through every call.** The
  correlation id is ambient request state; passing a request-bound logger (or the id itself) as a
  parameter through every use case, repository, and event handler would pollute signatures across the
  whole call graph purely for logging. Storing it in `AsyncLocalStorage` via
  `@fastify/request-context` lets any code — however deep — obtain it implicitly, so a single
  application-scoped `logger` singleton produces correctly-correlated lines. The trade-off is the
  usual `AsyncLocalStorage` one: the enrichment is invisible in the call signature (a reader must know
  the mechanism exists), and code that escapes the async context — e.g. a `setTimeout` or a job
  handler running on a fresh execution — logs without a `correlationId`. That degradation is safe:
  `getAll()` returns `{}` rather than throwing.
- **Context fields win over caller data on key collision.** `withContext` spreads
  `this.context.getAll()` after the caller's `data`, so a value like `correlationId` cannot be
  accidentally (or maliciously) overwritten by a caller passing the same key. Ambient truth beats
  local input. Verified by the `context value wins over caller data` test.
- **Reuse Fastify's own Pino instance for HTTP.** Inside the server, the `PinoLogger` wraps `app.log`
  (Fastify's built-in Pino logger, configured with `level`) rather than constructing a second logger.
  This keeps the logs your code emits and Fastify's own request/lifecycle logs on the same instance,
  level, and format. `createBaseLogger` exists only for entry points that run _outside_ Fastify and
  therefore have no `app.log` to borrow.
- **`x-request-id` as the correlation header, reusing Fastify's request id.** Rather than inventing a
  parallel id, the plugin adopts Fastify's `request.id` — configured via `requestIdHeader` and
  `genReqId` to come from the client's `x-request-id` header or a fresh UUID. One id flows end to end:
  accepted from the client if present, generated otherwise, echoed on the response, and stamped on
  every log line, which makes distributed tracing across an upstream proxy straightforward.

## Testing

Unit tests live alongside the adapters and run under Vitest:

- `src/infrastructure/logging/pino-logger.test.ts` — verifies the adapter calls the base logger in
  Pino's `(object, message)` argument order for every level; enriches `data` with context fields when
  a context is active; passes `data` through unchanged when the context is empty; lets context values
  win over caller data on key collision; and returns the context fields when `data` is `undefined`.
  It uses a mocked `FastifyBaseLogger` and a stub `ContextProvider`.
- `src/infrastructure/logging/request-context-provider.test.ts` — boots a real Fastify instance with
  `@fastify/request-context` and asserts that `getAll()` returns the `ContextData` set in the current
  request scope, and returns `{}` when called outside any request context.

Run them with:

```bash
npm test
```

To run only the logging suite:

```bash
npx vitest run src/infrastructure/logging
```
