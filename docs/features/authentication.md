# Authentication

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `46c4a07`

## Purpose

This feature answers "who is this caller?" for every protected request. It exchanges a user's
email and password for a session, then keeps that session alive without re-prompting for
credentials. The design splits proof-of-identity into two tokens with very different lifetimes: a
short-lived **access token** the client attaches to each API call, and a long-lived **refresh
token** that mints new access tokens as they expire. The split lets most requests be authenticated
statelessly (no database read on the hot path) while still allowing a session to be revoked, which a
purely stateless scheme cannot offer.

Authorization — deciding _what_ an authenticated caller may do — is a separate concern owned by the
[Role-Based Authorization](./role-based-authorization.md) (RBAC) feature; this feature only proves
identity and packages the caller's current grants (roles and permissions) into the access token so the
access policy can read them.

## How it works

**Login (`POST /auth/login`).** The `Login` use case loads the user by email, verifies the supplied
password against the stored Argon2 hash via the `PasswordHasher` port, and rejects the attempt with
`InvalidCredentialsError` if the user is missing, the password is wrong, _or_ the account is
inactive — all three collapse to the same 401 so an attacker cannot distinguish them. On success it
resolves the user's current grants through the `GrantsReader` port and delegates to
`SessionService.issue`, which mints the token pair. The route returns `{ user, accessToken }` in the
body and sets the refresh token as an HTTP-only cookie (never in the body).

**Session issuance (`SessionService.issue` / `reissue`).** A consumer never mints directly: `issue`
(login) and `reissue` (refresh) are the public entry points, and both delegate to the private `mint`
helper. Minting produces two independent artifacts. The access
token is a signed JSON Web Token (JWT) (`AccessTokenService.sign`) carrying the user id (`sub`), email,
`systemRoleKeys`, and `permissions`. The refresh token is an opaque random string
(`OpaqueTokenService.generate`); the server stores only its SHA-256 hash
(`OpaqueTokenService.hash`) as a new `RefreshToken` row, tagged with a `familyId` and an expiry
`REFRESH_TOKEN_TTL` seconds in the future. The raw refresh string is returned to the caller once and
never persisted.

**Refresh with rotation and reuse detection (`POST /auth/refresh`).** A _missing_ refresh token is
short-circuited at the route itself — if neither the cookie nor the body supplies one, the handler
returns `reply.unauthorized('Missing refresh token')` (via `@fastify/sensible`) before `RefreshSession`
ever runs. Given a token that _was_ supplied, `RefreshSession` hashes the presented raw token, looks up
the stored row by that hash, and validates it: not found / revoked /
expired all yield `RefreshTokenInvalidError` (401). The security-critical branch is _reuse_ — if the
row is already marked used, the token has been replayed, which is the fingerprint of theft: the use
case revokes the **entire token family** (`revokeFamily`) and throws `RefreshTokenReusedError`, so
both the attacker's and the victim's tokens die at once. `RefreshSession` then re-checks that the
owning user still exists and is active; if the account has since been deactivated or deleted, it
revokes the **entire token family** (`revokeFamily`) and throws `RefreshTokenInvalidError` (401
`REFRESH_TOKEN_INVALID`) — the same fail-closed consequence as reuse, so a session cannot outlive its
owner. On the happy path it marks the current row used, persists it, **re-resolves grants from
scratch** (so a role revoked mid-session cannot linger for a whole refresh lifetime), and calls
`SessionService.reissue` with the _same_ `familyId` — producing a fresh access token and a fresh
refresh token in the same rotating chain.

**Logout (`POST /auth/logout`).** `Logout` hashes the presented refresh token, finds its row, and
revokes the whole family; the route also clears the refresh cookie. It is deliberately a no-op (still
`204`) when no token is supplied, so a logout is always safe to call.

**Authenticating a request (`authPlugin` → `app.authenticate`).** Protected routes run the
`authenticate` `preHandler`, which extracts the `Bearer` token from the `Authorization` header,
verifies it with `AccessTokenService.verify`, and attaches the decoded `AccessTokenPayload` to
`request.user`. A missing or malformed header throws `UnauthorizedError('MISSING_ACCESS_TOKEN')`; an
invalid or expired JWT is rejected inside `verify` as `INVALID_ACCESS_TOKEN`. Both surface as 401 via
the central error handler. `GET /auth/me` is the reference consumer: it reads `request.user!.sub` and
returns the current user.

## Architecture

The application layer depends only on **ports** — `AccessTokenService`, `OpaqueTokenService`,
`GrantsReader`, `IdGenerator`, `PasswordHasher`, and the domain's `RefreshTokenRepository` interface.
The concrete adapters (`jose` for JWTs, `node:crypto` for opaque tokens, Prisma for persistence) live
in infrastructure and never leak upward. `RefreshToken` is a domain entity that owns the lifecycle
rules (`isActive`, `markUsed`, `revoke`) with no framework or I/O. Presentation depends on the
application use cases through Awilix's request-scoped cradle. Concretes are bound to ports **only** in
`src/container.ts`, keeping the dependency arrows pointing inward.

| Component                                                                                                                                                   | Layer              | Responsibility                                                                                                                                                                                                                                | File                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `RefreshToken`                                                                                                                                              | Domain             | Refresh-token entity; encapsulates used/revoked/expired state and the `markUsed`/`revoke` transitions                                                                                                                                         | `src/domain/auth/refresh-token-entity.ts`                           |
| `RefreshTokenRepository`                                                                                                                                    | Domain             | Port for persisting and querying refresh tokens (interface only). `revokeAllForUser` and `deleteExpired` sit on the port for adjacent concerns — bulk revocation and expiry cleanup — but are not exercised by the login/refresh/logout paths | `src/domain/auth/refresh-token-repository.ts`                       |
| `InvalidCredentialsError` (`INVALID_CREDENTIALS`), `RefreshTokenInvalidError` (`REFRESH_TOKEN_INVALID`), `RefreshTokenReusedError` (`REFRESH_TOKEN_REUSED`) | Domain             | Auth-specific errors, all extending `UnauthorizedError` (→ 401)                                                                                                                                                                               | `src/domain/auth/auth-errors.ts`                                    |
| `Login`                                                                                                                                                     | Application        | Verify credentials + active status, then issue a session                                                                                                                                                                                      | `src/application/auth/login.ts`                                     |
| `RefreshSession`                                                                                                                                            | Application        | Rotate the refresh token, detect reuse, reissue the pair                                                                                                                                                                                      | `src/application/auth/refresh-session.ts`                           |
| `Logout`                                                                                                                                                    | Application        | Revoke the presented token's family                                                                                                                                                                                                           | `src/application/auth/logout.ts`                                    |
| `SessionService`                                                                                                                                            | Application        | Mint/reissue the access-token + stored-refresh-token pair                                                                                                                                                                                     | `src/application/auth/session-service.ts`                           |
| `AuthTokensDto`, `AuthResultDto`                                                                                                                            | Application        | Shapes returned by the use cases                                                                                                                                                                                                              | `src/application/auth/auth-dto.ts`                                  |
| `AccessTokenService`                                                                                                                                        | Application (port) | Sign/verify the stateless access JWT                                                                                                                                                                                                          | `src/application/shared/ports/access-token-service.ts`              |
| `OpaqueTokenService`                                                                                                                                        | Application (port) | Generate + hash the opaque refresh secret                                                                                                                                                                                                     | `src/application/shared/ports/opaque-token-service.ts`              |
| `GrantsReader`                                                                                                                                              | Application (port) | Resolve a user's `systemRoleKeys` + `permissions`                                                                                                                                                                                             | `src/application/shared/ports/grants-reader.ts`                     |
| `JoseAccessTokenService`                                                                                                                                    | Infrastructure     | `jose` HS256 JWT adapter for `AccessTokenService`                                                                                                                                                                                             | `src/infrastructure/security/jose-access-token-service.ts`          |
| `CryptoOpaqueTokenService`                                                                                                                                  | Infrastructure     | `node:crypto` adapter: 256-bit random + SHA-256 hash                                                                                                                                                                                          | `src/infrastructure/security/crypto-opaque-token-service.ts`        |
| `PrismaRefreshTokenRepository`                                                                                                                              | Infrastructure     | Prisma adapter for `RefreshTokenRepository`                                                                                                                                                                                                   | `src/infrastructure/persistence/prisma-refresh-token-repository.ts` |
| `toDomain` / `toPersistence`                                                                                                                                | Infrastructure     | Map between the Prisma row and the `RefreshToken` entity                                                                                                                                                                                      | `src/infrastructure/persistence/prisma-refresh-token-mapper.ts`     |
| `authRoutes`                                                                                                                                                | Presentation       | Registers `/auth/*` endpoints and wires cookies                                                                                                                                                                                               | `src/presentation/http/routes/auth-routes.ts`                       |
| `authPlugin` (`app.authenticate`)                                                                                                                           | Presentation       | Bearer-token `preHandler` that populates `request.user`                                                                                                                                                                                       | `src/presentation/http/plugins/authenticate.ts`                     |
| `loginResponse`, `refreshResponse`                                                                                                                          | Presentation       | Zod response schemas (strip secrets at the serialization boundary)                                                                                                                                                                            | `src/presentation/http/schemas/auth-response-schema.ts`             |
| `setRefreshCookie` / `clearRefreshCookie` / `readRefreshCookie`                                                                                             | Presentation       | HTTP-only refresh-cookie helpers                                                                                                                                                                                                              | `src/presentation/http/cookies.ts`                                  |

## Public surface

All routes are registered under the `/auth` prefix in `src/presentation/http/app.ts` and tagged
`Auth` in the OpenAPI document.

| Method | Path            | Auth                                     | Purpose                                                                                                                                                                                                                                                                        |
| ------ | --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/auth/login`   | Public (rate-limited)                    | Exchange `{ email, password }` for `{ user, accessToken }`; sets the refresh cookie. `401 INVALID_CREDENTIALS` on bad credentials or inactive account.                                                                                                                         |
| `POST` | `/auth/refresh` | Refresh token (cookie or body)           | Rotate the refresh token and mint a fresh access token, returning `{ accessToken }`. `401` on a missing / invalid / reused token, or when the owning user has since been deactivated or deleted — which, like reuse, revokes the whole token family (`REFRESH_TOKEN_INVALID`). |
| `POST` | `/auth/logout`  | Refresh token (cookie or body), optional | Revoke the token's family and clear the cookie. Always `204`, even with no token.                                                                                                                                                                                              |
| `GET`  | `/auth/me`      | Bearer access token                      | Return the authenticated user. `401` without a valid token.                                                                                                                                                                                                                    |

Two related endpoints share this router but belong to adjacent features and are documented with them:
`POST /auth/register` (self-service user creation, the User feature) and the Role-Based Authorization
access policy that reads the access-token claims. `/auth/refresh` and `/auth/logout` accept the refresh token either
from the `refreshToken` cookie (preferred) or from a `refreshToken` field in the JSON body as a
fallback for non-browser clients.

The contract another engineer programs against to protect a route is the `app.authenticate`
`preHandler`:

```typescript
app.get(
  '/me',
  {
    preHandler: [app.authenticate],
    schema: {
      security: [{ bearerAuth: [] }],
      response: { 200: userResponse, 404: errorResponse },
    },
  },
  async (request, reply) => {
    const { getUser } = request.diScope.cradle;
    const user = await getUser.execute({ id: request.user!.sub });
    return reply.status(200).send(user);
  },
);
```

After the `preHandler` runs, `request.user` is the verified `AccessTokenPayload`:

```typescript
interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  systemRoleKeys: string[];
  permissions: string[];
}
```

## Configuration

Every key below is parsed in `src/config/env.ts` (via `envalid`) and exported through the `Env` type;
example values are in `.env.example`.

| Variable              | Default                             | Meaning                                                                                                                                                |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_ACCESS_SECRET`   | _(required, no default)_            | HS256 signing secret for the access JWT (`JoseAccessTokenService`).                                                                                    |
| `JWT_ISSUER`          | `finflow`                           | `iss` claim set on sign and asserted on verify.                                                                                                        |
| `JWT_AUDIENCE`        | `finflow-api`                       | `aud` claim set on sign and asserted on verify.                                                                                                        |
| `ACCESS_TOKEN_TTL`    | `900` (15 min)                      | Access-token lifetime, in seconds.                                                                                                                     |
| `REFRESH_TOKEN_TTL`   | `1209600` (14 days)                 | Refresh-token lifetime; drives both the stored `expiresAt` and the cookie `maxAge`.                                                                    |
| `COOKIE_SECRET`       | `''` (empty)                        | If non-empty, the refresh cookie is signed with `@fastify/cookie`; empty disables signing.                                                             |
| `COOKIE_SECURE`       | `true` (dev default `false`)        | Sets the `Secure` flag on the refresh cookie.                                                                                                          |
| `WEB_ORIGIN`          | dev default `http://127.0.0.1:3000` | CORS origin; the app enables `credentials: true` so the browser sends the cookie cross-origin.                                                         |
| `RATE_LIMIT_MAX`      | `100`                               | Global per-route request cap, registered app-wide in `app.ts`. `/auth/login` and `/auth/register` override it with the stricter `RATE_LIMIT_AUTH_MAX`. |
| `RATE_LIMIT_AUTH_MAX` | `5`                                 | Max requests per window for `/auth/login` (and `/auth/register`), overriding the global `RATE_LIMIT_MAX`.                                              |
| `RATE_LIMIT_WINDOW`   | `1 minute`                          | Rate-limit window applied to both the global cap and those auth routes.                                                                                |

The refresh cookie is named `refreshToken` (`REFRESH_COOKIE`) and is always issued `httpOnly: true`,
`sameSite: 'strict'`, `path: '/auth'`. Because cookie `path` is a **prefix** match, the browser
sends it to every route mounted under the `/auth` prefix — `/auth/login`, `/auth/register`,
`/auth/me`, `/auth/refresh`, and `/auth/logout` — while keeping it off the rest of the API
(`/users`, `/roles`, `/permissions`, `/health`, …).

## Usage & extension

**Call a protected endpoint.** Send the access token as a bearer credential; the refresh cookie is
handled by the browser automatically:

```
Authorization: Bearer <accessToken>
```

**Protect a new route.** Add `app.authenticate` as a `preHandler` (see the `/auth/me` snippet above)
and read the caller from `request.user`. For permission checks, layer the Role-Based Authorization
guard on top — it reads `request.user.permissions` / `request.user.systemRoleKeys`, which this feature
populated.

**Swap a token implementation.** Because the use cases depend on ports, replacing an implementation
is a one-line change in `src/container.ts`. For example, to move access tokens from a symmetric HS256
secret to asymmetric RS256, write a new adapter implementing `AccessTokenService` and rebind it:

```typescript
// src/container.ts
import { RsaAccessTokenService } from '@/infrastructure/security/rsa-access-token-service';

container.register({
  // was: accessTokenService: asClass(JoseAccessTokenService).singleton(),
  accessTokenService: asClass(RsaAccessTokenService).singleton(),
});
```

No application, domain, or presentation code changes — the `Login`, `RefreshSession`, and
`authPlugin` consumers keep calling `sign` / `verify` through the unchanged port. The same pattern
applies to `OpaqueTokenService` and `RefreshTokenRepository`.

## Design decisions & trade-offs

- **Stateless access token + stored, rotating refresh token.** Access tokens are self-contained JWTs
  so the common case — authenticating an API call — needs no database round-trip; the guard just
  verifies a signature. The trade-off is that a JWT cannot be revoked before it expires, so its TTL is
  kept short (`ACCESS_TOKEN_TTL`, 15 min). Long-lived _revocable_ state lives in the refresh token,
  which _is_ stored and can be killed. This is the standard way to get both cheap auth checks and
  session revocation.
- **Opaque refresh tokens, not JWTs.** The refresh token is a random 256-bit string, not a JWT,
  because a refresh token must be revocable and its only job is to be _looked up_ server-side — a JWT
  would add signing/claims machinery with no benefit and would tempt callers to trust it statelessly.
  An opaque value can only be validated by a database hit, which is exactly the revocation checkpoint
  we want on refresh.
- **Store only the hash of the refresh token.** `CryptoOpaqueTokenService.hash` persists a SHA-256
  digest, never the raw secret, so a leaked database dump cannot be replayed as valid refresh tokens.
  A plain (unsalted) SHA-256 is deliberate and sufficient here — unlike a password, the input already
  has full 256-bit entropy, so it is not brute-forceable and needs no per-token salt or slow key
  derivation function (KDF) like Argon2. Lookup is by exact hash match (`findByTokenHash`), which a
  fast hash keeps O(1) on an
  indexed column.
- **Refresh-token rotation with family-wide reuse detection.** Every refresh consumes the presented
  token (`markUsed`) and issues a new one in the same `familyId` chain. Presenting an already-used
  token can only mean it was stolen and replayed, so `RefreshSession` revokes the whole family and
  fails closed. The cost is one extra write per refresh and a schema that tracks families; the payoff
  is automatic detection and containment of stolen tokens — the defining property tested in the
  integration suite.
- **Re-resolve grants on every refresh instead of copying old claims.** `RefreshSession` calls
  `grants.grantsFor(user.id)` again rather than reusing the previous token's claims. Copying stale
  claims would let a role revoked mid-session survive
  for a full refresh lifetime, defeating the point of short access TTLs. The cost is one grants query
  per refresh.
- **Uniform `InvalidCredentialsError` for wrong password, unknown email, and inactive account.**
  `Login` throws the same 401 for all three so the endpoint does not leak which accounts exist or
  which are disabled. The (accepted) cost is a slightly less specific error for legitimate users.
- **Refresh token delivered as an HTTP-only, path-scoped cookie — never in the response body.** The
  Zod `loginResponse` / `refreshResponse` schemas omit the refresh token entirely, so it cannot leak
  through the JSON body even by accident, and the `httpOnly` cookie keeps it out of reach of
  client-side JavaScript (XSS). Scoping the cookie to `path: '/auth'` with `sameSite: 'strict'`
  narrows both its exposure and CSRF (cross-site request forgery) surface. The trade-off is that non-browser clients (which have no
  cookie jar) fall back to sending the token in the request body on `/auth/refresh` and
  `/auth/logout`.
- **Optional cookie signing gated on `COOKIE_SECRET`.** When the secret is set the cookie is signed
  and verified (`readRefreshCookie` unsigns it); when empty, signing is skipped so local development
  works with zero config. Signing adds tamper-evidence but not confidentiality — the value is already
  a hashed lookup key, so this is a defense-in-depth nicety rather than the primary control.

## Testing

Unit tests (Vitest, `*.test.ts`) cover each component in isolation with mocked ports:

- `src/application/auth/login.test.ts` — credential + active-status checks and session issuance.
- `src/application/auth/refresh-session.test.ts` — every branch: not-found, revoked, expired,
  reuse-revokes-family, inactive/missing user, mark-used-and-persist, grant re-resolution.
- `src/application/auth/logout.test.ts` — family revocation and the no-token no-op.
- `src/application/auth/session-service.test.ts` — token-pair minting/reissue.
- `src/domain/auth/refresh-token-entity.test.ts` and `src/domain/auth/auth-errors.test.ts` — entity
  state transitions and error codes.
- `src/infrastructure/security/jose-access-token-service.test.ts` — sign/verify round-trip, empty
  role/permission defaulting, and rejection of malformed / wrong-secret / wrong-issuer / wrong-audience
  / expired tokens.
- `src/infrastructure/security/crypto-opaque-token-service.test.ts` — 256-bit entropy, uniqueness, and
  deterministic 64-hex hashing.
- `src/infrastructure/persistence/prisma-refresh-token-repository.test.ts` and
  `src/infrastructure/persistence/prisma-refresh-token-mapper.test.ts` — persistence adapter and row
  mapping.
- `src/presentation/http/plugins/authenticate.test.ts` — bearer extraction, 401 codes, and
  `request.user` population.
- `src/presentation/http/schemas/auth-response-schema.test.ts` — response schemas strip `passwordHash`
  and any leaked refresh token.

The integration test `test/integration/auth.int.test.ts` drives the real Fastify app end to end
against a database: login success + refresh-cookie shape + hashed persistence, the four login
rejections (wrong password, unknown email, deactivated user, invalid input), refresh rotation, reuse
detection revoking the family, logout, `GET /auth/me`, and a full-lifecycle capstone
(`login → me → refresh → me(new token) → logout → refresh fails`).

Run the unit tests with `npm test` (`vitest run`). The integration suite requires a running database
and runs with `npm run test:integration` (`vitest run -c vitest.integration.config.ts`).
