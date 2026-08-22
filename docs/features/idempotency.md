# Idempotency

> **Status:** Complete · **Layers:** application, infrastructure, presentation, composition root · **Verified against:** `5156995`

## Purpose

Clients retry: a request times out, a mobile connection drops mid-response, a gateway replays a POST — and the caller cannot tell whether the server already acted. For an unsafe endpoint like registration, a blind retry means a second side effect (or a confusing `409` for an operation that actually succeeded). This feature lets a client stamp a mutating request with an `Idempotency-Key` header so retrying is safe: the server executes the operation **once**, remembers the outcome, and replays the identical response to every retry within a bounded window. It makes retry-safety a declarative property of the HTTP layer that any route can opt into, instead of dedup logic each use case would have to re-implement.

## How it works

**The mechanism: two hooks bracketing the handler.** A Fastify `preHandler` hook runs before the route handler and _claims_ the request's `Idempotency-Key` — or, when that key already carries a stored response, replays it and skips the handler entirely. A Fastify `onSend` hook runs after the reply has been serialized and either _stores_ that response against the key or _releases_ the claim so a later retry re-executes. Throughout this document **claim** and **lock** mean the same thing: one TTL-bounded Redis key that marks the operation as in flight.

**The wiring.** Both hooks are added by `idempotencyPlugin` (`src/presentation/http/plugins/idempotency.ts`), which is wrapped in `fastify-plugin` so it registers its hooks on the root instance instead of an encapsulated child. Its position in `buildApp` (`src/presentation/http/app.ts`) is load-bearing in two directions: it is registered **after** `fastifyAwilixPlugin`, because both hooks resolve the store from `request.diScope.cradle`, and **before** any route registration, so the hooks wrap every route the app serves. (The full plugin order and why it matters is in [HTTP Infrastructure](./http-infrastructure.md).) Registration being app-wide does not make protection app-wide: each hook checks `request.routeOptions.config.idempotency === true` and returns immediately for routes that have not opted in. Exactly one route is opted in today — `POST /v1/auth/register` (`src/presentation/http/routes/auth-routes.ts`, mounted under the `/v1` prefix; the registration flow itself is documented in [email-verification.md](./email-verification.md)).

**Before the handler (`preHandler`).**

1. If the route has not opted in, or the request carries no usable `idempotency-key` header, the hook does nothing — the request runs normally and is **not** idempotent. `readIdempotencyKey` honours exactly **one** header value: it reads `request.headers['idempotency-key']` and returns `undefined` unless the value is a `string`, and Fastify represents a repeated header as an array. A client that sends the header twice — or a proxy that repeats rather than folds it — therefore gets a silently non-idempotent request, with no error and no deduplication. A header present as a single blank value (empty or whitespace-only) is a different case and is rejected immediately with a `ValidationError` (`400`, code `IDEMPOTENCY_KEY_INVALID`): a blank key is a client bug, not a choice. Because `preHandler` runs after body parsing and schema validation, a request the route's Zod schema rejects fails earlier and never claims its key.
2. `fingerprintRequest` computes a SHA-256 hex digest over `request.method`, `request.url`, and `JSON.stringify(request.body)` (empty string when the body is `undefined`), joined by newline separators. Since the hook runs post-validation, this hashes the **parsed** body.
3. The hook calls `claim(key)` on the `IdempotencyStore` (via `request.diScope.cradle.idempotencyStore`). The claim is atomic and returns one of three outcomes:
   - **`claimed`** — this key is fresh. The plugin records `request.idempotency = { key, fingerprint }` and lets the handler run.
   - **`in_flight`** — another request holding the same key is still executing. The hook throws a `ConflictError` (`409`, code `IDEMPOTENCY_KEY_IN_PROGRESS`); the handler never runs and no state changes.
   - **`replayed`** — a completed response is stored for this key. If its stored fingerprint differs from the current request's, the key is being reused with different parameters: `ValidationError` (`400`, code `IDEMPOTENCY_KEY_MISMATCH`). If it matches, the hook short-circuits and sends the stored status and body directly, stamping `Idempotent-Replayed: true` and `content-type: application/json; charset=utf-8`. The handler never executes.

**After the handler (`onSend`).** Only requests that hold a pending claim reach this branch. `isStorableResponse` demands **two** things: `reply.statusCode` below `500` (`RETRYABLE_STATUS_THRESHOLD`) **and** a payload that is a `string`. When both hold, the plugin calls `complete(key, { status, body, fingerprint })`, storing the response for the `IDEMPOTENCY_RESULT_TTL` replay window. Otherwise it calls `release(key)`, deleting the claim so a retry re-executes.

Three consequences follow from that pair of conditions:

- **Deterministic 4xx answers are cached.** `onSend` runs after the shared error handler has serialized any thrown error, so register's duplicate-email conflict — `RegisterUser` throws `EmailAlreadyTakenError`, a `ConflictError` subclass with code `EMAIL_ALREADY_TAKEN`, which `error-handler.ts` maps to `409` — is stored and replayed exactly like a success.
- **`5xx` responses are released** and stay retryable, on the assumption that they are transient.
- **An empty response body is never stored.** `reply.status(204).send()` hands `onSend` a payload of `undefined`, so `isStorableResponse` is false and the plugin releases the claim. A `204` endpoint therefore gains **no** replay protection whatsoever: every attempt re-executes the handler, and the key exists only for the duration of each individual request. The same applies to a non-string payload such as a stream or a `Buffer`.

**In Redis.** `RedisIdempotencyStore` (`src/infrastructure/idempotency/redis-idempotency-store.ts`) keeps one Redis key per idempotency key, prefixed `idem:`. `claim` issues a single command — `SET idem:<key> '{"state":"in_flight"}' PX <lockTtlMs> NX GET` — which atomically writes the in-flight record only if the key is absent _and_ returns the previous value: `null` means `claimed`, a stored `{ state: 'in_flight' }` record means `in_flight`, and a stored `{ state: 'completed', status, body, fingerprint }` record means `replayed`. `complete` overwrites the key with the completed record under `IDEMPOTENCY_RESULT_TTL`; `release` is a `DEL`.

That claim is a plain TTL-bounded key, **not an owned lock**: there is no fencing token, and neither `complete` nor `release` checks who holds the key before writing. Once an in-flight record expires after `IDEMPOTENCY_LOCK_TTL`, a duplicate request can claim the same key and run concurrently — and when the slow original finally reaches its own `onSend`, it writes unconditionally anyway. Its `complete` overwrites whatever the second request stored, and its `release` deletes a claim it no longer owns. The last writer wins. This is also why a crash between claim and completion is survivable: the in-flight record expires on its own, blocking the key for at most the lock TTL.

**When Redis is unavailable.** The whole contract depends on Redis, and the plugin deliberately **fails closed**. Three distinct paths:

- **A rejected `claim()` takes the route down.** The `preHandler` awaits `claim(key)` with no `try`/`catch`, so a rejection propagates to the shared error handler; it is not an `AppError` and carries no 4xx `statusCode`, so it becomes `500` with code `INTERNAL`. An opted-in route does **not** degrade to non-idempotent behaviour during a Redis incident — `POST /v1/auth/register` stops serving altogether.
- **More often it stalls than rejects.** `idempotencyRedis` is built by `createRedisConnection` (`src/infrastructure/jobs/redis-connection.ts`), which sets only `maxRetriesPerRequest: null` and leaves ioredis's default offline queue on. Commands issued while the connection is down are queued and retried indefinitely rather than failing fast, so requests hang until Redis returns instead of erroring quickly. This is the opposite posture from the rate limiter's connection (`createRateLimitRedis`: `connectTimeout`, `commandTimeout`, `enableOfflineQueue: false`, `skipOnError: true`), which fails open by design.
- **A failure in `onSend` arrives too late to undo anything.** `complete()` / `release()` run after the handler has already committed its side effect. If either rejects, the user row exists but the client sees an error — and, for a failed `complete`, the key keeps its in-flight record until the lock TTL expires, so an immediate retry gets `409 IDEMPOTENCY_KEY_IN_PROGRESS`.

**How rate limiting interacts.** `@fastify/rate-limit` installs an `onRequest` hook (its default; `rateLimitOptions` in `src/presentation/http/security.ts` does not override `hook`), and Fastify runs the whole `onRequest` phase before any `preHandler`. A throttled request is therefore rejected with `429` before the idempotency hook ever runs: no key is claimed, and no `429` is ever cached or replayed. The reverse is not true — a **replayed** response still passed through the limiter's `onRequest` hook and still consumed rate-limit budget, so a client retrying aggressively can throttle itself out of its own replay.

## Architecture

The application layer owns the abstraction: `IdempotencyStore` is a port expressing the key lifecycle — `claim`, `complete`, `release` — with no Redis, HTTP, or Fastify vocabulary (its only domain-ish notion is an `IdempotentResponse` of status, body, and fingerprint). The infrastructure layer supplies the single adapter, `RedisIdempotencyStore`, which is bound to the port **only** in `src/composition/idempotency.ts` (as the `idempotencyStore` registration, fed by a dedicated `idempotencyRedis` connection). The presentation layer consumes the port through the request-scoped cradle and owns the client-facing contract: header names, fingerprinting, replay semantics, and the errors (`ValidationError`, `ConflictError` from `@/shared/errors`) that the shared error handler (`src/presentation/http/error-handler.ts`) maps to `400`/`409`. Dependencies point inward — the plugin never names the adapter — so swapping Redis for another backend means writing one new adapter and rebinding one registration. No domain-layer code is involved: idempotency is a transport concern, deliberately kept out of use cases.

| Component                                                                       | Layer              | Responsibility                                                                                                                                                                                                                                  | File                                                        |
| ------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `IdempotencyStore` / `IdempotencyClaim` / `IdempotentResponse`                  | Application (port) | Contract for the key lifecycle: atomically claim a key, store a completed response, release a claim                                                                                                                                             | `src/application/shared/ports/idempotency-store.ts`         |
| `RedisIdempotencyStore`                                                         | Infrastructure     | Redis adapter: one `SET … PX … NX GET` per claim, TTL-bound records under the `idem:` prefix                                                                                                                                                    | `src/infrastructure/idempotency/redis-idempotency-store.ts` |
| `idempotencyPlugin`                                                             | Presentation       | App-wide `preHandler`/`onSend` hooks implementing claim → execute-or-replay → store/release                                                                                                                                                     | `src/presentation/http/plugins/idempotency.ts`              |
| `fingerprintRequest`                                                            | Presentation       | SHA-256 digest of method, URL, and serialized parsed body — detects key reuse with different parameters                                                                                                                                         | `src/presentation/http/plugins/idempotency.ts`              |
| `IDEMPOTENCY_KEY_HEADER` / `IDEMPOTENT_REPLAYED_HEADER` / `REPLAY_CONTENT_TYPE` | Presentation       | Exported constants of the client contract: `'idempotency-key'`, `'idempotent-replayed'`, `'application/json; charset=utf-8'`                                                                                                                    | `src/presentation/http/plugins/idempotency.ts`              |
| Route opt-in                                                                    | Presentation       | `config: { idempotency: true }` on `POST /register` — the one live opted-in route                                                                                                                                                               | `src/presentation/http/routes/auth-routes.ts`               |
| Plugin registration                                                             | Presentation       | `await app.register(idempotencyPlugin)` inside `buildApp`, which is the presentation composition root: after `fastifyAwilixPlugin` (the hooks resolve from the request scope) and before any route registration (so the hooks wrap every route) | `src/presentation/http/app.ts`                              |
| Container wiring                                                                | Composition root   | Registers `idempotencyRedis` (dedicated ioredis singleton with a disconnect disposer) and binds `idempotencyStore` to `RedisIdempotencyStore` with the two env TTLs                                                                             | `src/composition/idempotency.ts`                            |

## Public surface

### HTTP contract — what a client programs against

One endpoint is opted in today:

| Method | Path                | Auth                                                                            | Purpose                                                                 |
| ------ | ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/v1/auth/register` | Public (rate-limited to `RATE_LIMIT_AUTH_MAX` requests per `RATE_LIMIT_WINDOW`) | Create a user account; retry-safe when an `Idempotency-Key` is supplied |

The client contract, on any opted-in route:

- **Request header:** `Idempotency-Key: <opaque string>` (header names are case-insensitive; the plugin reads `idempotency-key`). Send **exactly one** value — the plugin honours a single string and ignores the header entirely if it arrives repeated as an array. Choose a fresh, unique value — a UUID — per logical operation, and resend the _same_ value with the _same_ request when retrying. The key namespace is global across all opted-in routes, so never reuse a key for a different operation.
- **Response header:** a replayed response carries `Idempotent-Replayed: true`; a first execution does not.

| Situation                                                                              | Result                                                                                                                         | What the client should do                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Fresh key, first request                                                               | Handler executes normally; the response is stored only if the status is below `500` **and** the serialized payload is a string | Nothing — treat the response as authoritative                                                       |
| Retry of a completed request (same key, identical method + URL + body)                 | Stored status and body replayed verbatim, with `Idempotent-Replayed: true`; the handler does not run again                     | Nothing — the operation happened exactly once                                                       |
| Same key, different method, URL, or body                                               | `400`, error code `IDEMPOTENCY_KEY_MISMATCH` — "This Idempotency-Key was already used with different request parameters."      | Mint a **fresh** key; this one is permanently bound to the earlier request                          |
| Same key while the first request is still executing                                    | `409`, error code `IDEMPOTENCY_KEY_IN_PROGRESS` — "A request with this Idempotency-Key is already being processed."            | Wait briefly, then resend the identical request with the identical key; it will hit the replay path |
| Blank (empty/whitespace) key                                                           | `400`, error code `IDEMPOTENCY_KEY_INVALID` — "The Idempotency-Key header must not be blank."                                  | Fix the client: send a non-blank key, or none at all                                                |
| `Idempotency-Key` sent more than once (client bug, or a proxy that repeats the header) | Header is an array, not a string, so it is treated as **absent**: no `400`, no deduplication, the handler runs every time      | Send exactly one header value                                                                       |
| No `Idempotency-Key` header                                                            | The request is processed normally and is **not** deduplicated                                                                  | Send a key whenever retry-safety matters                                                            |
| Handler replies with an empty body (e.g. `204`)                                        | Payload is `undefined`, so nothing is stored and the claim is released                                                         | Do not rely on idempotency here — the endpoint gains no replay protection                           |
| First attempt returned `5xx`                                                           | Nothing stored, claim released                                                                                                 | Retry with the **same** key; the operation re-executes                                              |
| Redis unreachable                                                                      | `500`, error code `INTERNAL` (fail-closed), or the request stalls until Redis returns                                          | Retry with the same key once the service recovers                                                   |
| Rate limit exceeded                                                                    | `429`, error code `RATE_LIMITED`, decided in `onRequest` before any key is claimed — never cached, never replayed              | Back off; note that replayed responses also consume rate-limit budget                               |

Deterministic client errors are part of the replay: if the first attempt produced a 4xx (e.g. `409` `EMAIL_ALREADY_TAKEN`), a retry with the same key replays that same 4xx. Error responses use the app-wide envelope produced by the error handler:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_IN_PROGRESS",
    "message": "A request with this Idempotency-Key is already being processed.",
    "requestId": "0f8fad5b-d9cb-469f-a165-70867728950e"
  }
}
```

### Port — what internal code programs against

```ts
export interface IdempotentResponse {
  status: number;
  body: string;
  fingerprint: string;
}

export type IdempotencyClaim =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'in_flight' }
  | { readonly outcome: 'replayed'; readonly response: IdempotentResponse };

export interface IdempotencyStore {
  claim(key: string): Promise<IdempotencyClaim>;
  complete(key: string, response: IdempotentResponse): Promise<void>;
  release(key: string): Promise<void>;
}
```

`claim` is the atomic entry point: it either acquires the key (`claimed`), reports a concurrent holder (`in_flight`), or returns the stored response (`replayed`). A caller that received `claimed` must end the lifecycle with exactly one of `complete` (persist the outcome for replay) or `release` (free the key for a retry). Neither call verifies ownership, so a caller whose claim has already expired will still overwrite or delete the current holder's record. The HTTP plugin is the port's only production consumer; nothing outside the composition root references `RedisIdempotencyStore` directly.

## Configuration

Read from `src/config/env.ts` (`.env.example` lists the same keys):

| Variable                 | Default                                                                            | Meaning                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDEMPOTENCY_LOCK_TTL`   | `30` (seconds)                                                                     | Lifetime of the `in_flight` claim record — the window during which a duplicate gets `409` and, if the process crashes mid-request, the maximum time the key stays blocked. Keep it above the worst-case latency of any opted-in handler.                                                  |
| `IDEMPOTENCY_RESULT_TTL` | `86400` (`60 * 60 * 24`, 24 h)                                                     | Replay window for a completed response. Within it, an identical retry is replayed; after it expires, the same key executes the handler again.                                                                                                                                             |
| `REDIS_URL`              | `redis://127.0.0.1:6379` (dev/test only — `devDefault`, so required in production) | Connection string for the Redis instance backing the store. The container gives the store its own connection (`idempotencyRedis`), separate from the BullMQ and rate-limit connections that share this URL — see [background-jobs.md](./background-jobs.md) for the connection mechanics. |

Both TTLs are configured in **seconds** and converted to milliseconds inside `RedisIdempotencyStore`.

## Usage & extension

**Calling an opted-in endpoint.** Send the header, and resend the identical request with the identical key to retry:

```bash
curl -X POST http://localhost:8000/v1/auth/register \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 5f0d1e9a-8c1b-4f61-9d3e-2a7b6c4d8e90' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","password":"password123"}'
```

Running it twice returns the same `201` body both times; the second response carries `Idempotent-Replayed: true`, and only one user exists.

**How a route opts in.** The flag lives in the route's `config`. This is the live registration route, verbatim from `src/presentation/http/routes/auth-routes.ts`:

```ts
app.post(
  '/register',
  {
    config: {
      idempotency: true,
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_WINDOW },
    },
    schema: {
      body: registerBody,
      response: { 201: userResponse, 400: errorResponse, 409: errorResponse },
    },
  },
  async (request, reply) => {
    const { registerUser } = request.diScope.cradle;
    const user = await registerUser.execute(request.body);
    return reply.status(201).send(user);
  },
);
```

**Opting another endpoint in.** The plugin is already registered app-wide in `buildApp` and the store already bound in `src/composition/idempotency.ts`, so the mandatory change is one line: `idempotency: true` in the target route's `config`. The `declare module 'fastify'` augmentation in the plugin makes the flag type-checked on every route. The snippet below sketches a payment-creation route; `createPaymentBody`, `paymentResponse`, and `createPayment` are **illustrative placeholders** — substitute your own Zod schemas and your own use case from the cradle:

```ts
app.post(
  '/payments',
  {
    preHandler: [app.authenticate],
    config: { idempotency: true },
    schema: {
      body: createPaymentBody,
      response: {
        201: paymentResponse,
        400: errorResponse,
        401: errorResponse,
        409: errorResponse,
      },
    },
  },
  async (request, reply) => {
    const { createPayment } = request.diScope.cradle;
    const payment = await createPayment.execute(request.body);
    return reply.status(201).send(payment);
  },
);
```

When opting a route in, check five things:

1. **Document the plugin's rejections.** Add `400: errorResponse` and `409: errorResponse` to the route's response schema (as `/register` does) so `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_MISMATCH`, and `IDEMPOTENCY_KEY_IN_PROGRESS` appear in the generated OpenAPI docs.
2. **The response body must be a non-empty serialized string.** Standard JSON replies qualify, including the error handler's output, which is string-serialized before `onSend` sees it. A route that returns `204` (or otherwise sends no body) does **not**: its payload reaches `onSend` as `undefined`, nothing is stored, the claim is released, and every retry re-executes — so the opt-in buys nothing. The same holds for a stream or a `Buffer`. This rules out the auth router's `204` endpoints (`/logout`, `/forgot-password`, `/reset-password`) as they stand today.
3. **The route must not set cookies or other response headers.** A replay reconstructs only the status, the body, `Idempotent-Replayed`, and `content-type` — the handler never runs, so every other header it would have set is silently missing. Opting in `/login`, which calls `setRefreshCookie(reply, …)`, would hand the retrying client a cookie-less replay and a broken session.
4. **Mind the hook order against route-level authentication.** The plugin's `preHandler` is registered at instance level in `buildApp`, and Fastify runs route-level hooks _last within their phase_ — so a route-level `preHandler: [app.authenticate]` (as in the snippet above, mirroring `GET /v1/auth/me`) authenticates **after** the key has already been claimed. Two consequences: an unauthenticated caller can burn keys in the global namespace, and the resulting `401`/`403` is below `RETRYABLE_STATUS_THRESHOLD`, so it is cached and replayed for the full `IDEMPOTENCY_RESULT_TTL` — a client whose token later becomes valid still receives the stale `401`. Wire authentication in the earlier `onRequest` phase instead (`app.addHook('onRequest', app.authenticate)`, as `userRoutes`, `roleRoutes`, and `permissionRoutes` do) so it runs before the claim.
5. **Handler latency must stay under `IDEMPOTENCY_LOCK_TTL`.** If the handler outlives the lock, the claim expires while it is still running, a concurrent retry can execute the operation a second time, and — because `complete`/`release` are unconditional writes with no ownership check (see _In Redis_ above) — the slow original's `onSend` then overwrites or deletes the newer request's record. Raise the TTL rather than relying on the handler being fast.

**Swapping the backend.** Implement `IdempotencyStore` in a new infrastructure adapter and rebind the `idempotencyStore` registration in `src/composition/idempotency.ts`; the plugin and routes are untouched.

## Design decisions & trade-offs

- **A generic plugin with per-route opt-in, not per-handler wrapping.** `fastify-plugin` breaks encapsulation so one `preHandler`/`onSend` pair covers the whole app, and routes opt in declaratively through typed route config. Handlers and use cases stay completely oblivious — `RegisterUser` contains no idempotency code. The cost of opt-in is that protection is not automatic: every new unsafe endpoint must remember the flag.
- **Client-supplied key plus server-computed fingerprint.** The key alone would deduplicate, but it could not detect a client reusing one key for two different operations — which would silently return an unrelated stored response. The SHA-256 fingerprint of method + URL + serialized body turns that client bug into an explicit `400` `IDEMPOTENCY_KEY_MISMATCH`. The comparison is byte-level on the parsed body's `JSON.stringify` output, so a semantically equal body with different key order counts as a different request — an accepted simplification over canonical JSON hashing.
- **One atomic `SET … PX … NX GET` instead of check-then-set.** A read followed by a write would let two concurrent duplicates both see "absent" and both execute. The single command claims the key and returns the previous record in one round trip, so exactly one of N concurrent duplicates wins; the semantics are proven against a real Redis 7.4 in the integration suite. The alternative — a Lua script or `WATCH`/`MULTI` transaction — buys nothing extra here. The constraint this imposes is a server-version floor: combining `NX` with `GET` requires Redis ≥ 7.0, which both `docker-compose.yml` and the testcontainer pin at `redis:7.4-alpine`.
- **A TTL-bounded claim rather than a fenced, owned lock.** The in-flight record carries no owner or token, and `complete`/`release` write unconditionally. That keeps the adapter to three one-command methods and keeps the port free of lease/renewal vocabulary, but it means correctness rests entirely on handlers finishing inside `IDEMPOTENCY_LOCK_TTL`; past that boundary the guarantee degrades to last-writer-wins rather than failing loudly. A fencing token would detect the overlap — at the price of a Lua script and a lease API the single consumer does not otherwise need.
- **Concurrent duplicates fail fast with `409` rather than waiting.** Parking the second request until the first finishes (then replaying) would need pub/sub or polling and would hold sockets open. Rejecting with `IDEMPOTENCY_KEY_IN_PROGRESS` keeps the server simple; the cost is pushed to the client, which retries after a short delay and then hits the replay path.
- **Deterministic 4xx responses are cached; 5xx responses are released.** The threshold is `RETRYABLE_STATUS_THRESHOLD = 500`. A 4xx is a stable verdict on the request — replaying register's `409` `EMAIL_ALREADY_TAKEN` gives the retry the same truthful answer without re-running the use case — while a 5xx is presumed transient, so the key is freed and the retry gets a real second attempt. The blunt edge of a status-only rule is that _any_ sub-500 status is treated as deterministic, including authorization failures that a route-level `preHandler` produces after the claim (see the opt-in checklist).
- **A Redis outage fails closed, not open.** Neither hook catches store errors, so a rejected `claim()` becomes a `500` and the route stops serving rather than quietly reverting to non-idempotent execution. For a mutating endpoint that is the right trade: silently dropping deduplication during an incident is exactly when duplicate retries are most likely, and a double registration is worse than a failed one. The deliberate contrast is `@fastify/rate-limit`, configured with `skipOnError: true` on a connection with `enableOfflineQueue: false` — throttling is an availability nicety and fails **open**, while idempotency is a correctness guarantee and fails **closed**. The cost is a hard dependency: Redis down means `POST /v1/auth/register` down, and because the idempotency connection keeps ioredis's offline queue, callers usually experience that as a stall rather than a fast error.
- **The lock TTL is crash insurance, not the primary release path.** Graceful failures release the claim in `onSend`; the `PX` expiry on the in-flight record only covers a process that dies between claim and response, bounding the blocked window to `IDEMPOTENCY_LOCK_TTL` (default 30 s). The trade-off cuts both ways: too short and a slow-but-alive handler loses its claim mid-flight (risking a duplicate execution); too long and a crashed request blocks its key for that much longer.
- **The stored response is the final serialized string.** `onSend` captures the payload after Zod serialization (or after the error handler), so replay sends stored bytes directly — no handler, no serializer, no database — and stamps `content-type: application/json; charset=utf-8` itself, since the replay bypasses the machinery that would normally set it. The flip side is that a replay carries _only_ what was stored: status, body, `Idempotent-Replayed: true`, and that content type. Any other header the handler would have set is lost, which is what confines the feature to header-free JSON endpoints.
- **A bounded 24-hour replay window.** `IDEMPOTENCY_RESULT_TTL` caps Redis growth and matches the realistic retry horizon; a key reused after expiry silently re-executes, which is why clients should mint a fresh UUID per logical operation rather than deriving keys from stable data.
- **A dedicated Redis connection (`idempotencyRedis`).** The store gets its own ioredis singleton (with a `disconnect` disposer) rather than sharing `redisConnection`/`workerConnection` — a BullMQ worker parks a blocking read on its socket, which would stall idempotency lookups. All connections point at the same `REDIS_URL`; only the sockets are separate ([background-jobs.md](./background-jobs.md)).

## Testing

- **`src/presentation/http/plugins/idempotency.test.ts`** (unit) exercises the full plugin contract on a bare Fastify app with an `InMemoryIdempotencyStore`: a retry replays the first response with `Idempotent-Replayed: true` and the handler runs once; a deterministic 4xx (a thrown `ConflictError` → `409`) is replayed the same way; no key means no deduplication; a blank key is `400` `IDEMPOTENCY_KEY_INVALID`; a changed body is `400` `IDEMPOTENCY_KEY_MISMATCH`; a concurrent duplicate (the first request held open on a gate promise) is `409` `IDEMPOTENCY_KEY_IN_PROGRESS`; a `500` releases the claim so the retry succeeds; a `Buffer` payload is released rather than cached; a route without the flag never touches the store; and `fingerprintRequest` is stable for equal input and sensitive to body presence and content.
- **`test/integration/idempotency/redis-idempotency-store.int.test.ts`** proves the adapter against a real Redis (testcontainers `redis:7.4-alpine`, started by `test/integration/global-setup.ts`): the claim → `in_flight` → `complete` → `replayed` lifecycle, `release` making a key claimable again, and an in-flight claim expiring after a 1-second lock TTL.
- **`test/integration/idempotency/register-idempotency.int.test.ts`** proves the feature end-to-end through `buildApp` against `POST /v1/auth/register` with real Redis and MariaDB: a replayed registration returns the identical `201` body with `idempotent-replayed: true` and leaves exactly one user row; omitting the key creates two users; a pre-claimed key yields `409` and no user; the same key with a different email yields `400` `IDEMPOTENCY_KEY_MISMATCH` and one user; a blank key yields `400` and no user; and a duplicate-email `409` is cached and replayed byte-for-byte.

```bash
npm test                                                        # all unit tests
npx vitest run src/presentation/http/plugins/idempotency.test.ts # this feature's unit tests only
npm run test:integration                                        # needs Docker for the Redis + MariaDB testcontainers
```

## Known limitations

- **No coverage for the multi-valued-header and empty-body paths.** Both behaviours are read directly from source (`readIdempotencyKey`'s `typeof header !== 'string'` guard, and `isStorableResponse`'s string check against Fastify's `undefined` payload for `reply.send()` with no argument), and no test in the suite pins either. They are documented here as source-verified facts rather than test-guaranteed ones.
- **Redis-failure behaviour is likewise untested.** The fail-closed `500`, the offline-queue stall, and a rejected `onSend` write are derived from the plugin's missing error handling and the `createRedisConnection` options; no test simulates an unavailable Redis on an opted-in route.
