# Authentication

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `5156995`

## Purpose

This feature answers "who is this caller?" for every protected request. The problem it solves is a
tension: checking a credential against the database on every call is expensive, but a purely
stateless credential cannot be revoked once issued — so proof-of-identity is split across two
tokens with very different lifetimes, a short-lived **access token** the client attaches to each API
call and a long-lived, server-stored **refresh token** that mints new access tokens as they expire.
The split keeps the hot path free of database reads while still allowing a session to be killed,
which a purely stateless scheme cannot offer.

## How it works

**Login (`POST /v1/auth/login`).** The `Login` use case normalizes the email through the `Email`
value object, loads the user, verifies the supplied password against the stored Argon2 hash via the
`PasswordHasher` port, and rejects the attempt with `InvalidCredentialsError` if the user is
missing, the password is wrong, _or_ the account is inactive — all three collapse to the same 401
so an attacker cannot distinguish them. On success it resolves the user's current grants through the
`GrantsReader` port and delegates to `SessionService.issue`, which mints the token pair. The route
returns `{ user, accessToken }` in the body and sets the refresh token as an HTTP-only cookie
(never in the body).

**Session issuance (`SessionService.issue` / `reissue`).** A consumer never mints directly: `issue`
(login — starts a new **token family**) and `reissue` (refresh — continues an existing one) are the
public entry points, and both delegate to the private `mint` helper. A token family is the chain of
refresh tokens descended from a single login: every token in it carries the same `familyId`, which
is what lets one replayed token invalidate the whole chain rather than just itself. Minting produces
two independent artifacts. The access token is a signed JSON Web Token (JWT)
(`AccessTokenService.sign`) carrying the user id (`sub`), email, `systemRoleKeys`, and
`permissions`. The refresh token is an **opaque** random string (`OpaqueTokenService.generate`) —
opaque meaning it carries no readable claims of its own and is meaningful only as a lookup key into
server-side state. The server stores only its SHA-256 hash (`OpaqueTokenService.hash`) as a new
`RefreshToken` row, tagged
with a `familyId` and an expiry `REFRESH_TOKEN_TTL` seconds in the future. The raw refresh string
is returned to the caller once and never persisted.

**Refresh with rotation and reuse detection (`POST /v1/auth/refresh`).** _Rotation_ means a refresh
token is single-use: presenting one both mints a new access token **and** replaces the refresh token
itself with a fresh one in the same family, marking the presented token spent. A stolen token is
therefore usable at most once, and the moment either party uses it the other's copy becomes
evidence of the theft.

The route reads the token from the `refreshToken` cookie, falling back to a `refreshToken` field in
the JSON body for non-browser clients. A _missing_ token is short-circuited at the route itself —
the handler returns
`reply.unauthorized('Missing refresh token')` (via `@fastify/sensible`) before `RefreshSession`
ever runs. That helper raises an `http-errors` `Unauthorized`, which carries a `statusCode` but no
`code`, so the central error handler falls back to its default and the response is
`401 { error: { code: 'BAD_REQUEST', message: 'Missing refresh token', requestId } }` — **not**
`REFRESH_TOKEN_INVALID`, which only ever comes from `RefreshSession` itself.

A **tampered signed cookie is indistinguishable from an absent one.** When `COOKIE_SECRET` is set,
`readRefreshCookie` returns `undefined` if `request.unsignCookie` reports the value invalid
(`cookies.ts:33-34`) — it does not raise. So a cookie whose signature fails takes the very same path
as no cookie at all: `/refresh` answers `401 BAD_REQUEST` `Missing refresh token` (never
`REFRESH_TOKEN_INVALID`), and `/logout` still returns `204` having revoked nothing. If a client is
sure it sent a cookie and still gets "Missing refresh token", a signature mismatch — typically a
rotated `COOKIE_SECRET` — is the likely cause.

Given a token that _was_ supplied, `RefreshSession` hashes it, looks up the stored row by that hash,
and runs five guards **in this order** — the order is load-bearing, not an unordered set:

| #   | Guard                           | Error (code)                                         | Revokes the family? |
| --- | ------------------------------- | ---------------------------------------------------- | ------------------- |
| 1   | Row not found for that hash     | `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`) | No                  |
| 2   | Row is revoked                  | `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`) | No                  |
| 3   | Row is already **used**         | `RefreshTokenReusedError` (`REFRESH_TOKEN_REUSED`)   | **Yes**             |
| 4   | Row is expired                  | `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`) | No                  |
| 5   | Owning user missing or inactive | `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`) | **Yes**             |

Guard 3 is the security-critical branch: an already-used token has been replayed, which is the
fingerprint of theft, so the use case revokes the **entire token family** (`revokeFamily`) and both
the attacker's and the victim's tokens die at once. Note that reuse is checked **before** expiry.
That precedence matters in practice: every superseded link in a rotated chain is marked used the
instant the next one is issued, yet stays unexpired for its full `REFRESH_TOKEN_TTL` (14 days) —
and once it does expire it is still flagged used. Either way the used check runs first, so replaying
an old link takes the reuse path — revoking the family — rather than yielding a plain
`REFRESH_TOKEN_INVALID`. Guard 5 applies the same consequence for a different reason: if the account
has since been deactivated or deleted, the whole family is revoked too, so a session cannot outlive
its owner. Both are _fail-closed_ — when the state is doubtful the feature destroys access rather
than preserving it.

Past all five guards, `RefreshSession` marks the current row used, persists it, **re-resolves grants
from scratch** (so a role revoked mid-session cannot linger for a whole refresh lifetime), and calls
`SessionService.reissue` with the _same_ `familyId` — producing a fresh access token and a fresh
refresh cookie in the same rotating chain. The body carries only `{ accessToken }`.

**Logout (`POST /v1/auth/logout`).** `Logout` hashes the presented refresh token, finds its row,
and revokes the whole family; the route also clears the refresh cookie. It is deliberately a no-op
(still `204`) when no token is supplied, so a logout is always safe to call.

**Concurrent sessions are per-device and independent.** `Login` calls `SessionService.issue`, which
always mints a **fresh** `familyId` from the `IdGenerator` (`session-service.ts:42-44`) — it never
reuses or replaces an existing family. Logging in from a phone while a laptop session is live
therefore produces two unrelated families that rotate side by side, and there is **no per-user cap
or eviction**: every login adds a family, and stale ones survive until they expire and
[Data Retention](./data-retention.md) sweeps them. Symmetrically, `Logout` revokes only the family
of the token actually presented, so signing out on one device leaves the others signed in. A
sign-out-everywhere action is a different operation — bulk `revokeAllForUser`, which is what
[Password Reset](./password-reset.md) triggers.

**Authenticating a request (`authPlugin` → `app.authenticate`).** Protected routes run the
`authenticate` `preHandler`, which extracts the `Bearer` token from the `Authorization` header,
verifies it with `AccessTokenService.verify`, and attaches the decoded `AccessTokenPayload` to
`request.user`. A missing or malformed header throws `UnauthorizedError` with code
`MISSING_ACCESS_TOKEN`; an invalid or expired JWT is rejected inside `verify` as
`INVALID_ACCESS_TOKEN`. Both surface as 401 via the central error handler. The guard settles only
_who_ the caller is; deciding _what_ that caller may do is a separate concern owned by the
[Role-Based Authorization](./role-based-authorization.md) feature — this feature merely packages the
caller's current grants (roles and permissions) into the access token so the access policy can read
them.

**Current identity (`GET /v1/auth/me`).** The reference consumer of the guard. The handler converts
the verified payload into a `RequestActor` via `toRequestActor`. `RequestActor` is the
framework-free answer to "who is making this call": the shape use cases and access policies consume,
so nothing in the application layer ever sees an HTTP request or a JWT payload. Concretely it is a
`UserActor` carrying `userId`, `systemRoleKeys`, and `permissions` — _frozen_, i.e. run through
`Object.freeze` so the grant list cannot be mutated mid-request — or `ANONYMOUS_ACTOR` when no
payload exists. The handler then throws
`AuthenticationRequiredError` unless `actor.kind === 'user'` (a defensive check — the `preHandler`
already guarantees a verified payload), and calls `getUser.execute({ id: actor.userId }, actor)`.
`GetUser` belongs to the [User CRUD](./user-crud.md) feature; its `ensureSelfOrPermission` policy
passes because the actor is reading itself, and it returns 404 if the account has vanished since
the token was issued.

## Architecture

The application layer depends on **abstractions**, never on concrete adapters: the ports
`AccessTokenService`, `OpaqueTokenService`, `GrantsReader`, `IdGenerator`, `PasswordHasher`, and
`Clock`, plus the domain's `RefreshTokenRepository` and `UserRepository` interfaces (`Login` and
`RefreshSession` both load the account through the latter). The one non-abstraction it injects is
the parsed `Env` config object, which `SessionService` reads for `REFRESH_TOKEN_TTL` when stamping
a refresh token's expiry. The concrete adapters (`jose` for JWTs, `node:crypto` for
opaque tokens, `@node-rs/argon2` for password hashing, Prisma for persistence) live in
infrastructure and never leak upward. `RefreshToken` is a domain entity that owns the lifecycle
rules (`isActive`, `markUsed`, `revoke`) with no framework or I/O. Presentation reaches the use
cases through Awilix's request-scoped cradle (`request.diScope.cradle`). Concretes are bound to
ports **only** under `src/composition/**`, keeping the dependency arrows pointing inward.

| Component                                                                                                                                                   | Layer              | Responsibility                                                                                                                                                                                                                                                                                                                                                          | File                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `RefreshToken`                                                                                                                                              | Domain             | Refresh-token entity; encapsulates used/revoked/expired state and the `markUsed`/`revoke` transitions                                                                                                                                                                                                                                                                   | `src/domain/auth/refresh-token-entity.ts`                           |
| `RefreshTokenRepository`                                                                                                                                    | Domain             | Port for persisting and querying refresh tokens (interface only). `revokeAllForUser` and `deleteExpired` serve sibling features — bulk revocation after a [Password Reset](./password-reset.md) (`RevokeUserSessionsHandler`) and expiry cleanup by [Data Retention](./data-retention.md) (`RefreshTokenRetentionTask`) — and are not on the login/refresh/logout paths | `src/domain/auth/refresh-token-repository.ts`                       |
| `UserRepository`                                                                                                                                            | Domain             | Owned by [User CRUD](./user-crud.md); this feature consumes `findByEmail` (login) and `findById` (refresh). Because it returns `null` for a soft-deleted user, the "account gone or inactive revokes the family" guard needs no extra query                                                                                                                             | `src/domain/user/user-repository.ts`                                |
| `InvalidCredentialsError` (`INVALID_CREDENTIALS`), `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`), `RefreshTokenReusedError` (`REFRESH_TOKEN_REUSED`) | Domain             | Auth-specific errors, all extending `UnauthorizedError` (→ 401)                                                                                                                                                                                                                                                                                                         | `src/domain/auth/auth-errors.ts`                                    |
| `Login`                                                                                                                                                     | Application        | Verify credentials + active status, then issue a session                                                                                                                                                                                                                                                                                                                | `src/application/auth/login.ts`                                     |
| `RefreshSession`                                                                                                                                            | Application        | Rotate the refresh token, detect reuse, reissue the pair                                                                                                                                                                                                                                                                                                                | `src/application/auth/refresh-session.ts`                           |
| `Logout`                                                                                                                                                    | Application        | Revoke the presented token's family                                                                                                                                                                                                                                                                                                                                     | `src/application/auth/logout.ts`                                    |
| `SessionService`                                                                                                                                            | Application        | Mint/reissue the access-token + stored-refresh-token pair                                                                                                                                                                                                                                                                                                               | `src/application/auth/session-service.ts`                           |
| `AuthTokensDto`, `AuthResultDto`                                                                                                                            | Application        | Shapes returned by the use cases                                                                                                                                                                                                                                                                                                                                        | `src/application/auth/auth-dto.ts`                                  |
| `AccessTokenService`                                                                                                                                        | Application (port) | Sign/verify the stateless access JWT                                                                                                                                                                                                                                                                                                                                    | `src/application/shared/ports/access-token-service.ts`              |
| `OpaqueTokenService`                                                                                                                                        | Application (port) | Generate + hash the opaque refresh secret                                                                                                                                                                                                                                                                                                                               | `src/application/shared/ports/opaque-token-service.ts`              |
| `PasswordHasher`                                                                                                                                            | Application (port) | Hash/verify user passwords                                                                                                                                                                                                                                                                                                                                              | `src/application/shared/ports/password-hasher.ts`                   |
| `GrantsReader`                                                                                                                                              | Application (port) | Resolve a user's `systemRoleKeys` + `permissions` (`UserGrants`)                                                                                                                                                                                                                                                                                                        | `src/application/shared/ports/grants-reader.ts`                     |
| `JoseAccessTokenService`                                                                                                                                    | Infrastructure     | `jose` HS256 JWT adapter for `AccessTokenService`; stamps and asserts `iss`/`aud`, expiry from `ACCESS_TOKEN_TTL`                                                                                                                                                                                                                                                       | `src/infrastructure/security/jose-access-token-service.ts`          |
| `CryptoOpaqueTokenService`                                                                                                                                  | Infrastructure     | `node:crypto` adapter: 256-bit random `base64url` secret + SHA-256 hex hash                                                                                                                                                                                                                                                                                             | `src/infrastructure/security/crypto-opaque-token-service.ts`        |
| `Argon2PasswordHasher`                                                                                                                                      | Infrastructure     | `@node-rs/argon2` adapter for `PasswordHasher`; `verify` returns `false` on malformed hashes instead of throwing                                                                                                                                                                                                                                                        | `src/infrastructure/security/argon2-password-hasher.ts`             |
| `PrismaRefreshTokenRepository`                                                                                                                              | Infrastructure     | Prisma adapter for `RefreshTokenRepository`; unique lookup by `tokenHash`, family-wide `updateMany` revocation                                                                                                                                                                                                                                                          | `src/infrastructure/persistence/prisma-refresh-token-repository.ts` |
| `toDomain` / `toPersistence`                                                                                                                                | Infrastructure     | Map between the Prisma row and the `RefreshToken` entity                                                                                                                                                                                                                                                                                                                | `src/infrastructure/persistence/prisma-refresh-token-mapper.ts`     |
| `PrismaGrantsReader`                                                                                                                                        | Infrastructure     | Prisma adapter for `GrantsReader`: joins `userRole` → role → permissions, deduplicating permission keys                                                                                                                                                                                                                                                                 | `src/infrastructure/persistence/prisma-grants-reader.ts`            |
| `authRoutes`                                                                                                                                                | Presentation       | Registers the `/auth/*` endpoints, wires cookies, tags them `Auth` in OpenAPI                                                                                                                                                                                                                                                                                           | `src/presentation/http/routes/auth-routes.ts`                       |
| `authPlugin` (`app.authenticate`)                                                                                                                           | Presentation       | Bearer-token `preHandler` that populates `request.user`                                                                                                                                                                                                                                                                                                                 | `src/presentation/http/plugins/authenticate.ts`                     |
| `toRequestActor` (`RequestActor`)                                                                                                                           | Presentation       | Maps the verified `AccessTokenPayload` to a frozen `UserActor` (or `ANONYMOUS_ACTOR`) for use-case access policies                                                                                                                                                                                                                                                      | `src/presentation/http/identity/actor-from-token-payload.ts`        |
| `loginResponse`, `refreshResponse`                                                                                                                          | Presentation       | Zod response schemas (strip secrets at the serialization boundary)                                                                                                                                                                                                                                                                                                      | `src/presentation/http/schemas/auth-response-schema.ts`             |
| `setRefreshCookie` / `clearRefreshCookie` / `readRefreshCookie`                                                                                             | Presentation       | HTTP-only refresh-cookie helpers, path-scoped to `/v1/auth`                                                                                                                                                                                                                                                                                                             | `src/presentation/http/cookies.ts`                                  |

## Public surface

`authRoutes` is registered under the `/auth` prefix inside `apiV1Routes`
(`src/presentation/http/routes/api-v1-routes.ts`), which `src/presentation/http/app.ts` mounts
under `API_V1_PREFIX = '/v1'` (`src/presentation/http/api-version.ts`) — so every externally
visible path starts with `/v1/auth`. All routes are tagged `Auth` in the OpenAPI document.

The session-lifecycle endpoints this feature owns:

| Method | Path               | Auth                                                                                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/login`   | Public (rate-limited: `RATE_LIMIT_AUTH_MAX` per `RATE_LIMIT_WINDOW`)                                                          | Exchange `{ email, password }` for `{ user, accessToken }`; sets the refresh cookie. `400 VALIDATION` when the body fails `loginBody` (`email` must parse as an address, `password` must be non-empty); `401 INVALID_CREDENTIALS` on bad credentials or an inactive account.                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST` | `/v1/auth/refresh` | Refresh token (cookie, or `refreshToken` in the body — see [Integrate a non-browser client](#integrate-a-non-browser-client)) | Rotate the refresh token and mint a fresh access token, returning `{ accessToken }` and a new cookie. Failure modes: `400 VALIDATION` when a body is sent whose `refreshToken` is present but empty (`refreshBody.refreshToken` is `.min(1)`); `401 BAD_REQUEST` (`Missing refresh token`) when neither a cookie nor a body token is supplied — the route rejects this before the use case runs; `401 REFRESH_TOKEN_INVALID` when the token is unknown, revoked, or expired; `401 REFRESH_TOKEN_REUSED` on replay of an already-used token (revokes the family); `401 REFRESH_TOKEN_INVALID` when the owning user is gone or inactive (also revokes the family). |
| `POST` | `/v1/auth/logout`  | Refresh token (cookie or body — see [Integrate a non-browser client](#integrate-a-non-browser-client)), optional              | Revoke the token's family and clear the cookie. Always `204`, even with no token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET`  | `/v1/auth/me`      | Bearer access token (`app.authenticate`)                                                                                      | Return the authenticated user. `401 MISSING_ACCESS_TOKEN` when the `Authorization` header is absent or not a `Bearer` header; `401 INVALID_ACCESS_TOKEN` when the JWT fails verification or has expired; `401 AUTHENTICATION_REQUIRED` from the handler's defensive `actor.kind !== 'user'` branch (unreachable while the `preHandler` is in place); `404 USER_NOT_FOUND` when the account was soft-deleted after the token was issued.                                                                                                                                                                                                                          |

All four endpoints also answer `429 RATE_LIMITED` once their bucket is exhausted — `/login` against
the stricter `RATE_LIMIT_AUTH_MAX`, the other three against the app-wide `RATE_LIMIT_MAX`. The code
comes from `rateLimitOptions`' `errorResponseBuilder` (`src/presentation/http/security.ts`), which
builds an error carrying `code = 'RATE_LIMITED'` so the throttle response uses the same envelope as
every other failure; see [HTTP Infrastructure](./http-infrastructure.md) for the shared status/code
table.

For `/refresh` and `/logout` the body may be omitted entirely — `refreshBody` is `.nullish()` and
normalizes a missing/null body to `{}`; the cookie takes precedence when both are present.

_Becoming_ a user (sign-up and activation) and recovering a lost password are separate features.
Their four endpoints share this router but are documented with their owners:

| Method | Path                       | Feature                                                                                                                 |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/auth/register`        | [Email Verification](./email-verification.md) — public sign-up; creates a `pending` user and issues a verification code |
| `POST` | `/v1/auth/verify-email`    | [Email Verification](./email-verification.md) — submit the 6-digit code to activate the account                         |
| `POST` | `/v1/auth/forgot-password` | [Password Reset](./password-reset.md) — request a reset link by email                                                   |
| `POST` | `/v1/auth/reset-password`  | [Password Reset](./password-reset.md) — set a new password with the emailed token                                       |

The contract another engineer programs against to protect a route is the `app.authenticate`
`preHandler` plus the `toRequestActor` mapping (see
[Protect a new route](#protect-a-new-route)). Once the `preHandler` has run, `request.user` is the
verified `AccessTokenPayload`:

```ts
interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  systemRoleKeys: string[];
  permissions: string[];
}
```

## Configuration

Every key below is parsed in `src/config/env.ts` (via `envalid`) and exported through the `Env`
type; `assertProductionSecrets` additionally enforces the production strength rules at boot, and
`.env.example` lists them all with working development values. This feature **owns** the seven
token and auth-throttling keys — `JWT_ACCESS_SECRET`, `JWT_ISSUER`,
`JWT_AUDIENCE`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `RATE_LIMIT_AUTH_MAX`, and
`RATE_LIMIT_WINDOW` — and borrows the rest from
[HTTP Infrastructure](./http-infrastructure.md), which owns the transport layer they configure;
borrowed rows are tagged below and are documented in full there.

| Variable              | Default                                  | Meaning                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`            | `development`                            | One of `development`, `test`, `production`. Drives `env.isProduction`, which gates the secret-strength check in `assertProductionSecrets` and switches off every `devDefault` below. Owned by [http-infrastructure.md](./http-infrastructure.md).                                                                                                            |
| `JWT_ACCESS_SECRET`   | _(required, no default)_                 | HS256 signing secret for the access JWT (`JoseAccessTokenService`); must be ≥ 32 chars in production.                                                                                                                                                                                                                                                        |
| `JWT_ISSUER`          | `app` (from `APP_NAME`)                  | `iss` claim set on sign and asserted on verify.                                                                                                                                                                                                                                                                                                              |
| `JWT_AUDIENCE`        | `app-api` (from `APP_NAME`)              | `aud` claim set on sign and asserted on verify.                                                                                                                                                                                                                                                                                                              |
| `ACCESS_TOKEN_TTL`    | `900` (15 min)                           | Access-token lifetime, in seconds.                                                                                                                                                                                                                                                                                                                           |
| `REFRESH_TOKEN_TTL`   | `1209600` (14 days)                      | Refresh-token lifetime, in seconds; drives both the stored `expiresAt` and the cookie `maxAge`.                                                                                                                                                                                                                                                              |
| `COOKIE_SECRET`       | `''` (empty)                             | If non-empty, the refresh cookie is signed with `@fastify/cookie`; empty disables signing in development. In production boot fails unless it is ≥ 32 chars — empty included — because `assertProductionSecrets` treats it as a required secret. Co-owned with [http-infrastructure.md](./http-infrastructure.md), which registers `@fastify/cookie` with it. |
| `COOKIE_SECURE`       | `true` (dev default `false`)             | Sets the `Secure` flag on the refresh cookie. Owned by [http-infrastructure.md](./http-infrastructure.md).                                                                                                                                                                                                                                                   |
| `WEB_ORIGIN`          | `—` (devDefault `http://localhost:5173`) | CORS origin; the app enables `credentials: true` so the browser sends the cookie cross-origin. Declared with `devDefault`, so it has **no** production default — it is required at boot when `NODE_ENV=production`. Owned by [http-infrastructure.md](./http-infrastructure.md).                                                                             |
| `RATE_LIMIT_MAX`      | `100`                                    | Global per-route request cap, registered app-wide in `app.ts`; covers `/refresh`, `/logout`, and `/me`. Owned by [http-infrastructure.md](./http-infrastructure.md).                                                                                                                                                                                         |
| `RATE_LIMIT_AUTH_MAX` | `5`                                      | Stricter per-route cap that `/auth/login` (and the sibling register/verify/reset routes) sets via route `config.rateLimit`.                                                                                                                                                                                                                                  |
| `RATE_LIMIT_WINDOW`   | `1 minute`                               | Window applied to both the global cap and the auth override.                                                                                                                                                                                                                                                                                                 |

The refresh cookie is named `refreshToken` (`REFRESH_COOKIE`) and is always issued
`httpOnly: true`, `sameSite: 'strict'`, `path: '/v1/auth'` (built from `API_V1_PREFIX`). Because
cookie `path` is a **prefix** match, the browser sends it to every route mounted under `/v1/auth` —
including `/login`, `/register`, and `/me` — while keeping it off the rest of the API (`/v1/users`,
`/v1/roles`, `/v1/permissions`, `/health`, …).

## Usage & extension

**Log in and call a protected endpoint.** Trade credentials for an access token, then send it as a
bearer token:

```bash
# Log in; -c keeps the refresh cookie in a jar so /refresh works later
curl -i -X POST http://localhost:8000/v1/auth/login \
  -c cookies.txt \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","password":"password123"}'

# The response body is { "user": {...}, "accessToken": "<jwt>" } — the refresh
# token is only in the Set-Cookie header, never in the body.
curl http://localhost:8000/v1/auth/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**When to refresh.** Do not pre-emptively refresh on a timer. Treat
`401 INVALID_ACCESS_TOKEN` as the signal: call `POST /v1/auth/refresh` **once**, then replay the
original request with the new access token. If the refresh itself fails — any of
`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, or `BAD_REQUEST` `Missing refresh token` — the
session is over; do not retry, send the user back to login. Retrying a failed refresh is actively
harmful: replaying a token that already rotated is exactly the pattern reuse detection reads as
theft, and it revokes the whole family. `401 MISSING_ACCESS_TOKEN` is a client bug (no `Bearer`
header), not an expiry, so refreshing will not fix it.

<a id="protect-a-new-route"></a>

**Protect a new route.** Register `app.authenticate` as a `preHandler`, then derive the caller with
`toRequestActor(request.user)` rather than reading `request.user` fields directly — use cases take
an `Actor`, and the frozen `RequestActor` is the shape their access policies
(`ensureSelfOrPermission`, permission guards from
[Role-Based Authorization](./role-based-authorization.md)) expect. A complete registration:

```ts
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { toRequestActor } from '@/presentation/http/identity/actor-from-token-payload';
import { AuthenticationRequiredError } from '@/domain/authorization/access-policy-errors';
import { userResponse } from '../schemas/user-response-schema';
import { errorResponse } from '../schemas/error-schema';

export const profileRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.get(
    '/profile',
    {
      preHandler: [app.authenticate],
      schema: {
        security: [{ bearerAuth: [] }],
        response: { 200: userResponse, 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { getUser } = request.diScope.cradle;
      const actor = toRequestActor(request.user);
      if (actor.kind !== 'user') throw new AuthenticationRequiredError();

      const user = await getUser.execute({ id: actor.userId }, actor);
      return reply.status(200).send(user);
    },
  );

  done();
};
```

Declare `401: errorResponse` alongside the success shape: the guard can reject before your handler
ever runs, and only declared statuses appear in the generated OpenAPI document, so leaving it out
publishes a route that looks as if it cannot fail authentication. `security: [{ bearerAuth: [] }]`
is the matching OpenAPI annotation — it documents the requirement but does not enforce it; the
`preHandler` is what enforces it. To protect a whole router rather than one route, hoist the guard
to `app.addHook('onRequest', app.authenticate)`, as `userRoutes` does.

<a id="integrate-a-browser-client"></a>

**Integrate a browser client.** The refresh cookie is `httpOnly`, so JavaScript can neither read nor
attach it — the browser only sends it if the call **opts in** to credentials. Omit that opt-in and
`/refresh` answers `401 BAD_REQUEST` `Missing refresh token` with nothing on the wire to explain
why, because the request genuinely arrived without a cookie.

1. **Log in with credentials enabled** so the browser stores the `Set-Cookie`:
   `fetch('/v1/auth/login', { method: 'POST', credentials: 'include', … })` — or
   `withCredentials: true` on an `XMLHttpRequest`/axios call.
2. **Keep the access token in memory**, not in `localStorage` (which XSS can read), and attach it as
   `Authorization: Bearer <accessToken>` on every API call.
3. **Refresh with `credentials: 'include'` too.** The cookie is scoped `Path=/v1/auth`, so it is
   sent to `/v1/auth/refresh` but to nothing under `/v1/users` — you never need credentials on
   ordinary API calls, only on the auth routes.
4. **Mind the same-site constraint.** The cookie is `SameSite=Strict`, so the browser attaches it
   only when the page's own site matches the API's. A SPA served from a different site than the API
   will pass CORS (the server sets `credentials: true` for `WEB_ORIGIN`) and still send no cookie —
   the refresh silently degrades to "missing token". Serve the SPA same-site as the API (a shared
   parent domain, or a reverse proxy putting both behind one origin); a separate origin needs
   `sameSite` relaxed and a CSRF defense added, which this feature deliberately does not ship.

<a id="integrate-a-non-browser-client"></a>

**Integrate a non-browser client.** A CLI, mobile app, or service-to-service caller has no cookie
jar, so it must carry the refresh token itself. Three things are easy to get wrong:

1. **The refresh token is never in a response body.** `loginResponse` and `refreshResponse` omit it
   by design, so `POST /v1/auth/login` returns only `{ user, accessToken }` and
   `POST /v1/auth/refresh` only `{ accessToken }`. The **sole** delivery channel is the `Set-Cookie`
   response header (`refreshToken=…; HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=…`, plus
   `Secure` when `COOKIE_SECURE` is on). A client
   that wants the value must parse it out of that header — on the login response **and** on every
   refresh response, since each rotation issues a new one.
2. **Strip the signature before sending it in a body.** When `COOKIE_SECRET` is non-empty the cookie
   is written with `signed: true`, so the header value is `<token>.<signature>`. The cookie read
   path undoes that (`readRefreshCookie` calls `request.unsignCookie`), but the **body path does
   not** — `request.body.refreshToken` is hashed verbatim. Posting the header value as-is therefore
   hashes to something no row matches and yields `401 REFRESH_TOKEN_INVALID`. Send only the part
   before the first `.` (the token is `base64url`, whose alphabet contains no dot, so the first dot
   is unambiguously the separator). With `COOKIE_SECRET` empty there is no signature and the value
   is already the raw token.
3. **Then post it as JSON — to `/refresh` or `/logout`, and only those two.** They are the only
   endpoints whose schema declares a `refreshToken` body field (`refreshBody`), and each reads it as
   `readRefreshCookie(request, env) ?? request.body?.refreshToken` — so a valid **cookie takes
   precedence** and the body value is consulted only when no usable cookie is present. `/login`
   takes no refresh token at all: `loginBody` declares only `email` and `password`, and Zod strips
   any extra key **silently** — no error, no warning, so a `refreshToken` sent there simply vanishes
   with no clue that it was ignored.

```http
POST /v1/auth/refresh
Content-Type: application/json

{ "refreshToken": "<value-before-the-first-dot>" }
```

The alternative, and the less error-prone one, is to keep a cookie jar (most HTTP clients have one)
and echo the `Cookie` header back instead — then the server unsigns the value for you and neither
trap applies.

**Swap a token implementation.** Because the use cases depend on ports, replacing an implementation
is a one-line rebinding in `src/composition/security.ts`, the composition module that owns the token
services. For example, to move access tokens from a symmetric HS256 secret to asymmetric RS256, write
a new adapter implementing `AccessTokenService` and swap the line in that module's registration map:

```ts
// src/composition/security.ts
import { RsaAccessTokenService } from '@/infrastructure/security/rsa-access-token-service';

export const securityRegistrations = {
  // ...the rest of the existing registrations, unchanged
  // was: accessTokenService: asClass(JoseAccessTokenService).singleton(),
  accessTokenService: asClass(RsaAccessTokenService).singleton(),
} satisfies RegistrationMap;
```

The `Cradle` slice above it still types the key as the `AccessTokenService` **port**, so the swap
is checked against the abstraction: an adapter that does not implement it fails to compile here.

No application, domain, or presentation code changes — `Login`, `RefreshSession`, `SessionService`,
and `authPlugin` keep calling `sign`/`verify` through the unchanged port. The same pattern applies
to `opaqueTokenService` (`CryptoOpaqueTokenService`), `passwordHasher` (`Argon2PasswordHasher`),
`grants` (`PrismaGrantsReader`), and `refreshTokenRepository` (`PrismaRefreshTokenRepository`),
which are all registered as singletons alongside the `sessionService`, `login`, `refreshSession`,
and `logout` use cases.

## Design decisions & trade-offs

- **Stateless access token + stored, rotating refresh token.** Access tokens are self-contained
  JWTs so the common case — authenticating an API call — needs no database round-trip; the guard
  only verifies a signature. The trade-off is that a JWT cannot be revoked before it expires, so
  its TTL is kept short (`ACCESS_TOKEN_TTL`, 15 min). Long-lived _revocable_ state lives in the
  refresh token, which _is_ stored and can be killed. This buys both cheap auth checks and session
  revocation.
- **Opaque refresh tokens, not JWTs.** The refresh token is a random 256-bit string, not a JWT,
  because a refresh token must be revocable and its only job is to be _looked up_ server-side — a
  JWT would add signing/claims machinery with no benefit and would tempt callers to trust it
  statelessly. An opaque value can only be validated by a database hit, which is exactly the
  revocation checkpoint wanted on refresh.
- **Store only the hash of the refresh token.** `CryptoOpaqueTokenService.hash` persists a SHA-256
  digest, never the raw secret, so a leaked database dump cannot be replayed as valid refresh
  tokens. A plain (unsalted) SHA-256 is deliberate and sufficient here — unlike a password, the
  input already has full 256-bit entropy, so it is not brute-forceable and needs no per-token salt
  or slow key-derivation function like Argon2. A deterministic fast hash also keeps
  `findByTokenHash` an exact-match lookup on a unique indexed column.
- **Refresh-token rotation with family-wide reuse detection.** Every refresh consumes the presented
  token (`markUsed`) and issues a new one in the same `familyId` chain. Presenting an already-used
  token can only mean it was stolen and replayed, so `RefreshSession` revokes the whole family and
  fails closed. The cost is one extra write per refresh and a schema that tracks families; the
  payoff is automatic detection and containment of stolen tokens — the defining property the
  integration suite proves.
- **Re-resolve grants on every refresh instead of copying old claims.** `RefreshSession` calls
  `grants.grantsFor(user.id)` again rather than reusing the previous token's claims. Copying stale
  claims would let a role revoked mid-session survive for a full refresh lifetime, defeating the
  point of short access TTLs. The cost is one grants query per refresh.
- **Uniform `InvalidCredentialsError` for wrong password, unknown email, and inactive account.**
  `Login` throws the same 401 for all three so the endpoint does not leak which accounts exist or
  which are disabled. Because the sibling registration flow creates accounts as `pending`,
  the same `isActive` gate also bars unverified accounts with no extra logic in `Login`. The
  accepted cost is a less specific error for legitimate users. Login is additionally rate-limited
  (`RATE_LIMIT_AUTH_MAX`) to slow online guessing.
- **Refresh token delivered as an HTTP-only, path-scoped cookie — never in the response body.** The
  Zod `loginResponse`/`refreshResponse` schemas omit the refresh token entirely, so it cannot leak
  through the JSON body even by accident, and the `httpOnly` cookie keeps it out of reach of
  client-side JavaScript, which is what neutralizes cross-site scripting (XSS) as a theft route.
  Scoping the cookie to `path: '/v1/auth'` with `sameSite: 'strict'`
  narrows both its exposure and the CSRF (cross-site request forgery) surface. The trade-off is
  that non-browser clients (which have no cookie jar) must read the token out of the `Set-Cookie`
  header and send it in the request body on `/refresh` and `/logout` — see
  [Integrate a non-browser client](#integrate-a-non-browser-client).
- **Optional cookie signing gated on `COOKIE_SECRET`.** When the secret is set the cookie is signed
  and verified (`readRefreshCookie` unsigns it and drops tampered values — silently, so they read
  as an absent cookie, see [How it works](#how-it-works)); when empty, signing is
  skipped so local development works with zero config. Signing adds tamper-evidence but not
  confidentiality — the value is already only a hashed lookup key — so this is defense-in-depth
  rather than the primary control.
- **A frozen `RequestActor` instead of passing `request.user` around.** `createUserActor` copies
  and freezes the role/permission arrays, so the grant list backing every authorization decision
  cannot be mutated mid-request, and use cases stay ignorant of HTTP/JWT specifics — they see only
  the domain's `Actor` type.

## Testing

Unit tests (Vitest, `*.test.ts` next to each source file) cover every component in isolation with
mocked ports:

- `src/application/auth/login.test.ts` — malformed email, unknown user, wrong password, and
  inactive account all rejected; email normalization; grants resolved and carried into the issued
  session.
- `src/application/auth/refresh-session.test.ts` — every branch: hash-before-lookup, not-found,
  revoked, expired (including the one-millisecond boundary), reuse-revokes-family, missing/inactive
  user revokes family, mark-used-and-persist, same-family reissue, single clock reading, and grant
  re-resolution.
- `src/application/auth/logout.test.ts` — family revocation, hash-before-lookup, and the no-token /
  unknown-token no-ops.
- `src/application/auth/session-service.test.ts` — token-pair minting: payload claims, hashed
  storage, fresh family id on `issue` vs preserved family id on `reissue`, expiry stamped from the
  single passed instant.
- `src/domain/auth/refresh-token-entity.test.ts` and `src/domain/auth/auth-errors.test.ts` —
  entity state transitions and error codes.
- `src/infrastructure/security/jose-access-token-service.test.ts`,
  `crypto-opaque-token-service.test.ts`, and `argon2-password-hasher.test.ts` — sign/verify and
  hash/verify round-trips for the three security adapters.
- `src/infrastructure/persistence/prisma-refresh-token-repository.test.ts` and
  `prisma-refresh-token-mapper.test.ts` — persistence adapter and row mapping.
- `src/presentation/http/plugins/authenticate.test.ts` — absent/non-Bearer/empty/whitespace
  headers all 401; valid token populates `request.user`; verify failures propagate.
- `src/presentation/http/cookies.test.ts` — cookie attributes (`HttpOnly`, `SameSite=Strict`,
  `Path=/v1/auth`, `Max-Age`, `Secure`), signed vs unsigned modes, and tamper rejection.
- `src/presentation/http/identity/actor-from-token-payload.test.ts` — anonymous fallback, payload
  mapping, and immunity to post-mapping array mutation.
- `src/presentation/http/schemas/auth-response-schema.test.ts` — response schemas strip
  `passwordHash` and any leaked refresh token.

The integration test `test/integration/auth.int.test.ts` drives the real Fastify app end to end
against a database: login success + refresh-cookie shape + hashed persistence, the login rejections
(wrong password, unknown email, deactivated user, invalid input), refresh rotation and the
body-token fallback, reuse detection revoking the whole family, logout, `GET /auth/me`, and a
full-lifecycle capstone (`login -> me -> refresh -> me(new token) -> logout -> refresh fails`).

```bash
npm test                  # unit tests — vitest run
npm run test:integration  # vitest run -c vitest.integration.config.ts (needs a running database)
```
