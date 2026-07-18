# Role-Based Authorization

> **Status:** Complete · **Layers:** domain, application, infrastructure, presentation · **Verified against:** `46c4a07`

## Purpose

This feature answers a single question for every protected request: _is this caller allowed to do
this?_ It models access as **permissions** (fine-grained verbs such as `users.read`) that are bundled
into **roles**, which are in turn assigned to users. The permission vocabulary is fixed in code (a
**catalogue**), so the set of things the system can authorize is a compile-time constant, while roles
and their assignments are runtime data an operator manages through the API. This keeps authorization
decisions cheap (a substring check against a list carried on the access token) and keeps the catalogue
the single, reviewable source of truth for "what powers exist."

## How it works

Authorization is split into two phases: **grant computation at login** and **enforcement per request.**

1. **Grants are baked into the access token at login.** When a user authenticates, `SessionService`
   (`src/application/auth/session-service.ts`) asks the `GrantsReader` port for that user's
   `UserGrants` — the flattened set of permission keys across all their non-deleted roles, plus the
   keys of any _system_ roles they hold — and signs them into the JWT's `systemRoleKeys` and
   `permissions` claims. The token therefore carries a self-contained snapshot of the caller's
   authority; no database read is needed to authorize a subsequent request.

2. **Every protected route is fronted by a guard.** The `authenticate` plugin
   (`src/presentation/http/plugins/authenticate.ts`) verifies the bearer token and hangs the decoded
   `AccessTokenPayload` on `request.user`. A `preHandler` produced by `requirePermission(...)`
   (`src/presentation/http/guards/authorize.ts`) then runs: it asserts a user is present (else
   `UnauthorizedError` → 401), short-circuits to allow if the user holds the `super-admin` system role
   key, and otherwise checks that `request.user.permissions` includes the required key (else
   `ForbiddenError` → 403, with `details.required` naming the missing permission).

3. **Roles and assignments are managed through use cases.** The `/roles` endpoints drive
   `CreateRole`, `GetRole`, `ListRoles`, `EditRole`, and `DeleteRole`; assignment lives on the user
   resource (`AssignRole`, `RevokeRole`). Each use case loads/mutates the `Role` aggregate through the
   `RoleRepository` port and persists it via `PrismaRoleRepository`. Because permissions are re-read
   from the token, a change to a user's roles takes effect on their **next** login, not mid-session —
   the integration test `roles.int.test.ts` asserts exactly this lifecycle.

4. **The catalogue is reconciled into the database out of band.** `SyncAuthorization` upserts every
   catalogue permission, prunes stored permissions the catalogue no longer defines, ensures the
   `super-admin` system role exists, and optionally promotes a configured bootstrap operator to it.
   This runs as the `db:sync-auth` script, not at HTTP bootstrap (see _Design decisions_).

The important failure paths: an unknown permission key on create/edit is rejected up front
(`UnknownPermissionError` → 400); a duplicate active role name conflicts (`RoleNameTakenError` → 409);
mutating or deleting a system role is refused (`SystemRoleProtectedError` → 403); assigning a _system_
role through the API is likewise refused (403).

## Architecture

The feature obeys the dependency rule. The **domain** owns the `Role` aggregate, the `RoleRepository`
_interface_, the permission `PERMISSIONS` catalogue, and the typed domain errors — it depends on
nothing outside `domain`. The **application** layer holds the use cases and the ports they need
(`RoleRepository` from domain, plus `UserRoleRepository`, `PermissionRepository`, `GrantsReader`,
`UnitOfWork`, `IdGenerator`), and the DTO mappers that keep entities off the wire. The
**infrastructure** layer supplies the Prisma adapters that implement those ports. The **presentation**
layer exposes the HTTP routes, the `authorize` guard, and the Zod response schemas. Concretes are
bound to ports in exactly one place — `src/container.ts`.

| Component                                                                                                                                    | Layer              | Responsibility                                                                             | File                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `Role`                                                                                                                                       | Domain             | Aggregate: name/description/permission-set invariants, system-role protection, soft delete | `src/domain/authorization/role-entity.ts`                                               |
| `RoleRepository`                                                                                                                             | Domain             | Port: list/find/save roles                                                                 | `src/domain/authorization/role-repository.ts`                                           |
| `PERMISSIONS` / `ALL_PERMISSIONS` / `isKnownPermissionKey` / `SUPERADMIN_ROLE_KEY`                                                           | Domain             | The permission catalogue (source of truth) and the superadmin role key                     | `src/domain/authorization/permission-catalogue.ts`                                      |
| `RoleNotFoundError`, `RoleNameTakenError`, `UnknownPermissionError`, `RoleDeletedError`, `SystemRoleProtectedError`, `RoleNameRequiredError` | Domain             | Typed errors mapped to HTTP status by the error handler                                    | `src/domain/authorization/role-errors.ts`                                               |
| `CreateRole` / `GetRole` / `ListRoles` / `EditRole` / `DeleteRole`                                                                           | Application        | CRUD use cases over the `Role` aggregate                                                   | `src/application/authorization/{create,get,list,edit,delete}-role.ts`                   |
| `AssignRole` / `RevokeRole`                                                                                                                  | Application        | Grant/withdraw a role to/from a user (refuses system roles on assign)                      | `src/application/authorization/{assign,revoke}-role.ts`                                 |
| `ListPermissions`                                                                                                                            | Application        | Return the catalogue grouped by category                                                   | `src/application/authorization/list-permissions.ts`                                     |
| `SyncAuthorization`                                                                                                                          | Application        | Reconcile catalogue → DB, seed superadmin, promote bootstrap admin                         | `src/application/authorization/sync-authorization.ts`                                   |
| `assertKnownPermissions`                                                                                                                     | Application        | Reject any permission key not in the catalogue                                             | `src/application/authorization/assert-known-permissions.ts`                             |
| `RoleDto` / `toRoleDto`, `PermissionGroupDto` / `groupPermissions`                                                                           | Application        | Shape entities/catalogue into wire DTOs                                                    | `src/application/authorization/{role,permission}-dto.ts`                                |
| `UserRoleRepository`                                                                                                                         | Application (port) | List/assign/revoke the user↔role link                                                      | `src/application/shared/ports/user-role-repository.ts`                                  |
| `PermissionRepository`                                                                                                                       | Application (port) | Persist/prune the permission catalogue                                                     | `src/application/shared/ports/permission-repository.ts`                                 |
| `GrantsReader` (`UserGrants`)                                                                                                                | Application (port) | Read a user's flattened permissions + system-role keys                                     | `src/application/shared/ports/grants-reader.ts`                                         |
| `PrismaRoleRepository` / `toDomain`                                                                                                          | Infrastructure     | `RoleRepository` adapter + row→entity mapper (diffs `rolePermission` join rows on save)    | `src/infrastructure/persistence/prisma-role-repository.ts`, `.../prisma-role-mapper.ts` |
| `PrismaPermissionRepository`                                                                                                                 | Infrastructure     | `PermissionRepository` adapter                                                             | `src/infrastructure/persistence/prisma-permission-repository.ts`                        |
| `PrismaUserRoleRepository`                                                                                                                   | Infrastructure     | `UserRoleRepository` adapter (upsert/deleteMany on `userRole`)                             | `src/infrastructure/persistence/prisma-user-role-repository.ts`                         |
| `PrismaGrantsReader`                                                                                                                         | Infrastructure     | `GrantsReader` adapter (joins `userRole → role → permission`)                              | `src/infrastructure/persistence/prisma-grants-reader.ts`                                |
| `requirePermission` / `requireSelfOrPermission`                                                                                              | Presentation       | Fastify `preHandler` guards enforcing a permission (superadmin bypasses)                   | `src/presentation/http/guards/authorize.ts`                                             |
| `roleRoutes` / `permissionRoutes`                                                                                                            | Presentation       | HTTP surface for `/roles` and `/permissions`                                               | `src/presentation/http/routes/{role,permission}-routes.ts`                              |
| `roleResponse` / `paginatedRoles`, `permissionsResponse`                                                                                     | Presentation       | Zod serialization schemas (fail-closed; strip internal fields)                             | `src/presentation/http/schemas/{role,permission}-response-schema.ts`                    |

## Public surface

Two protected resource groups expose authorization data (`/roles`, `/permissions`), and role
**assignment** is modelled as a sub-resource of the user (`/users/:id/roles`). Every endpoint below
first runs the `authenticate` plugin (missing/invalid bearer token → **401**), then the named
permission guard (missing permission → **403**, unless the caller holds the `super-admin` system role,
which bypasses all permission checks).

| Method   | Path                       | Required permission | Purpose                                                                                                                            |
| -------- | -------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/roles`                   | `roles.read`        | List roles, paginated (`page`, `pageSize` query).                                                                                  |
| `GET`    | `/roles/:id`               | `roles.read`        | Fetch one role by id; 404 if unknown or soft-deleted.                                                                              |
| `POST`   | `/roles`                   | `roles.create`      | Create a role (`name`, optional `description`, optional `permissions[]`); 409 on duplicate active name, 400 on unknown permission. |
| `PATCH`  | `/roles/:id`               | `roles.update`      | Edit name/description and/or replace the permission set; 404 if unknown, 409 on name clash, 400 on unknown permission.             |
| `DELETE` | `/roles/:id`               | `roles.delete`      | Soft-delete a role (204); 403 if it is a system role.                                                                              |
| `GET`    | `/permissions`             | `roles.read`        | Return the whole catalogue grouped by category.                                                                                    |
| `POST`   | `/users/:id/roles`         | `roles.assign`      | Assign a role to a user (204); 404 if user/role unknown, 403 if the role is a system role.                                         |
| `DELETE` | `/users/:id/roles/:roleId` | `roles.assign`      | Revoke a role from a user (204); idempotent.                                                                                       |

> `/users/:id/roles` and `/users/:id/roles/:roleId` are declared in `src/presentation/http/routes/user-routes.ts`
> (they belong to the user resource) but drive the authorization use cases `AssignRole` / `RevokeRole`.
> They are listed here because assignment is part of this feature's public surface.

**The permission catalogue** (`src/domain/authorization/permission-catalogue.ts`) is the exhaustive
set of permission keys the system understands. `requirePermission(...)` accepts only a
`PermissionKey` (a union derived from this catalogue), so a route cannot be guarded by a key that does
not exist.

| Key            | Name                  | Category |
| -------------- | --------------------- | -------- |
| `users.read`   | View users            | `users`  |
| `users.create` | Create users          | `users`  |
| `users.update` | Update users          | `users`  |
| `users.delete` | Delete users          | `users`  |
| `roles.read`   | View roles            | `roles`  |
| `roles.create` | Create roles          | `roles`  |
| `roles.update` | Update roles          | `roles`  |
| `roles.delete` | Delete roles          | `roles`  |
| `roles.assign` | Assign roles to users | `roles`  |

**How the guard enforces grants.** `requirePermission(permission)` returns an `async` Fastify
`preHandler` (async even without an `await` so Fastify treats it as a promise and routes any throw to
the error handler). It:

1. `assertAuthenticated(request)` — throws `UnauthorizedError` (401) if `request.user` is absent.
2. `isSuperadmin(user)` — returns (allows) immediately if `user.systemRoleKeys` includes
   `SUPERADMIN_ROLE_KEY` (`'super-admin'`).
3. Otherwise throws `ForbiddenError` (403, `details: { required: permission }`) unless
   `user.permissions.includes(permission)`.

`requireSelfOrPermission(getTargetUserId, permission)` is the same, with one extra allow branch: the
caller passes if `user.sub` equals the target user id (used on the user resource so a user can act on
their own record without the broad permission).

**The `UserGrants` contract** the guard's data depends on:

```ts
export interface UserGrants {
  systemRoleKeys: string[];
  permissions: string[];
}

export interface GrantsReader {
  grantsFor(userId: string): Promise<UserGrants>;
}
```

`PrismaGrantsReader.grantsFor` reads the user's `userRole` rows (filtered to `role.deletedAt: null`),
collects each role's non-null `key` into `systemRoleKeys`, and flattens every role's permission keys
into a de-duplicated `permissions` array. `SessionService` copies both arrays into the access-token
claims at login.

**The sync-authorization flow** (`SyncAuthorization.execute`) runs entirely inside one
`UnitOfWork.run` transaction:

1. For every entry in `ALL_PERMISSIONS`, call `permissionRepository.upsertByKey(...)` (idempotent
   insert-or-update keyed on `key`).
2. Read all stored permissions, compute the set present in the DB but absent from the catalogue, and
   `deleteByKeys(...)` them — the catalogue is authoritative, so drift is pruned.
3. Look up the `super-admin` role by key; if missing, create it via `Role.createSystem({ ... key:
SUPERADMIN_ROLE_KEY, name: 'Super Admin' })` and save it (`superadminCreated: true`).
4. `promoteBootstrapAdmin`: if `BOOTSTRAP_ADMIN_EMAIL` is set and that user exists and is not already
   linked to the superadmin role, assign the role (`bootstrapPromoted: true`).

It returns `SyncAuthorizationResult { permissionsUpserted, permissionsRemoved, superadminCreated,
bootstrapPromoted }`. It is safe to run repeatedly — every step is idempotent.

## Configuration

Only one env var is read by this feature, and only by `SyncAuthorization`. The guards and use cases
read no configuration. (Login-time grant computation lives in `SessionService`, whose JWT-related env
vars belong to the authentication feature, not this one.)

| Variable                | Default      | Meaning                                                                                                                                                 |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMIN_EMAIL` | `''` (empty) | Email of a pre-existing user to promote to the `super-admin` role during `SyncAuthorization`. Empty ⇒ no promotion. Validated as an email by `envalid`. |

Both `SUPERADMIN_ROLE_KEY` (`'super-admin'`) and the permission catalogue are **code constants**, not
configuration — they are defined in `src/domain/authorization/permission-catalogue.ts` and cannot be
overridden at runtime.

## Usage & extension

### Add a new permission and protect a route with it

Say you are adding a "reports" feature and want a `reports.export` permission gating an export route.

**1. Add the permission to the catalogue** — `src/domain/authorization/permission-catalogue.ts`:

```ts
export const PERMISSIONS = {
  UsersRead: { key: 'users.read', name: 'View users', category: 'users' },
  // ... existing entries ...
  RolesAssign: { key: 'roles.assign', name: 'Assign roles to users', category: 'roles' },
  ReportsExport: { key: 'reports.export', name: 'Export reports', category: 'reports' },
} as const satisfies Record<string, PermissionDef>;
```

That single edit does four things automatically: it widens the `PermissionKey` union (so the guard
will accept `'reports.export'`), adds the entry to `ALL_PERMISSIONS`, makes
`isKnownPermissionKey('reports.export')` return `true` (so roles may include it and
`assertKnownPermissions` will stop rejecting it), and makes it appear under a new `reports` group in
`GET /permissions`.

**2. Reconcile the catalogue into the database** so the permission row exists and the join table can
reference it:

```bash
npm run db:sync-auth
```

This runs `src/scripts/sync-auth.ts` → `SyncAuthorization.execute()`, which upserts the new permission.
Skipping this step means `PrismaRoleRepository.save` cannot match the key to a `permission.id`, so the
permission would silently not be attached to the role.

**3. Guard the route** with `requirePermission` in the relevant routes file
(e.g. a new `src/presentation/http/routes/report-routes.ts`):

```ts
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { requirePermission } from '@/presentation/http/guards/authorize';

export const reportRoutes: FastifyPluginCallbackZod = (app, _opts, done) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/export',
    { preHandler: requirePermission('reports.export') },
    async (request, reply) => {
      // ... handler ...
      return reply.status(202).send();
    },
  );

  done();
};
```

Register the plugin in `src/presentation/http/app.ts`:

```ts
import { reportRoutes } from '@/presentation/http/routes/report-routes';
// ...
await app.register(reportRoutes, { prefix: '/reports' });
```

**4. Grant it.** The permission now exists but no one holds it. Add it to a role and assign that role:

```http
POST /roles                      { "name": "Analyst", "permissions": ["reports.export"] }
POST /users/{userId}/roles       { "roleId": "<the-analyst-role-id>" }
```

The user must **log in again** for the new permission to appear in their access token. A `super-admin`
holder needs none of this — the guard's superadmin bypass covers `reports.export` immediately.

### Add a new authorization use case

Follow the existing pattern: write the class in `src/application/authorization/` with constructor DI
of the ports it needs and a single `execute(input)` method, register it in `src/container.ts` with
`asClass(...).singleton()` and add its type to the `Cradle` interface, then call it from a route via
`request.diScope.cradle`.

## Design decisions & trade-offs

- **The permission catalogue is the single source of truth, in code.** Permissions are a closed union
  defined in `permission-catalogue.ts`, not free-form rows an admin invents. This makes every
  authorizable action grep-able and reviewable in one file, lets `requirePermission` be _type-checked_
  against real keys (a typo'd guard fails to compile), and lets `assertKnownPermissions` reject unknown
  keys at the API boundary. The cost: adding a permission is a code change plus a `db:sync-auth` run,
  not a runtime admin action — which is the intended trade-off for a security-sensitive vocabulary.

- **Grants are snapshotted onto the access token, not read per request.** Enforcement is a plain
  `Array.includes` against claims already on `request.user`, so no database round-trip is needed to
  authorize a call. The deliberate cost is **staleness**: revoking a role or editing its permissions
  does not affect live tokens; the change lands on the user's next login. The integration test
  `roles.int.test.ts` ("assigning a role grants its permissions on next login; revoking removes them")
  pins this contract. Immediate revocation would require either per-request grant reads or token
  invalidation, which this boilerplate intentionally omits.

- **A dedicated `GrantsReader` port, separate from `RoleRepository`.** Login needs one denormalized,
  read-only projection — the flattened permission set plus system-role keys for a user — not the full
  `Role` aggregate. Modelling that as its own port lets `PrismaGrantsReader` issue a single tailored
  join (`userRole → role → permission`, filtered to non-deleted roles) and keeps the read model out of
  the write-side repository. It is a CQRS-flavoured split: `RoleRepository` is the command/aggregate
  side, `GrantsReader` the query side.

- **Superadmin is a role _key_, and it bypasses permission checks entirely.** `super-admin` is a system
  role identified by its stable `key`, and `requirePermission` returns early for anyone holding that
  key. This avoids having to enumerate every permission onto the superadmin role (and re-grant it
  whenever the catalogue grows) — the bypass is checked against `systemRoleKeys`, so a superadmin is
  always fully authorized. The trade-off is that superadmin is an all-or-nothing escape hatch, not a
  permission set you can trim.

- **System roles are protected in the domain, not just the API.** `Role.guardMutable()` and the
  overridden `softDelete()` throw `SystemRoleProtectedError` for any `isSystem` role, and `AssignRole`
  refuses to assign a system role through the API. Putting the invariant on the aggregate means the
  protection holds no matter which caller (HTTP, a script, a future job) tries to mutate it — the rule
  cannot be bypassed by reaching around the route layer.

- **Assignment is a thin link, modelled as a sub-resource of the user.** `UserRoleRepository.assign`
  upserts a `userRole` row (idempotent) and `revoke` is a `deleteMany` (also idempotent, hence the
  204 even when nothing was linked). There is no `UserRole` aggregate — the link carries no behaviour
  beyond "user X has role Y since date Z" — so it stays a simple port over the join table rather than a
  domain entity. The endpoints live under `/users/:id/roles` because the assignment _is_ a property of
  the user.

- **`SyncAuthorization` runs as a script, not at HTTP bootstrap.** `src/main.ts` does **not** call it;
  it is invoked deliberately via `npm run db:sync-auth` (`src/scripts/sync-auth.ts`), and it is the
  reconciliation step you run on deploy/migration. Running catalogue reconciliation (which _prunes_
  permission rows) automatically on every process start would couple a destructive DB operation to
  boot and make concurrent deploys race; keeping it an explicit operational step makes the prune
  auditable. The whole reconciliation runs in one `UnitOfWork` transaction so it is atomic and every
  step is idempotent.

- **Response schemas are fail-closed and mirror the DTOs exactly.** `roleResponse` marks `key` and
  `description` `.nullable()` to match `RoleDto` — a plain `z.string()` there would make the serializer
  reject a legitimate `null` and turn a 200 into a 500 — and it lists only the public fields, so entity
  internals such as `deletedAt` are stripped on the wire (asserted by the "no internal fields" test).

## Testing

Unit tests live beside the source (`*.test.ts`); the cross-layer flows are covered by integration
tests under `test/integration/` (`*.int.test.ts`).

- **Domain** — `src/domain/authorization/role-entity.test.ts`: `Role` invariants (name normalization,
  permission grant/revoke/set, system-role protection on mutate and soft-delete).
- **Application** — one file per use case:
  `src/application/authorization/{create,get,list,edit,delete,assign,revoke}-role.test.ts`,
  `list-permissions.test.ts`, and `sync-authorization.test.ts` (upsert/prune/seed/promote logic with a
  fake unit of work).
- **Presentation** — `src/presentation/http/guards/authorize.test.ts`: `requirePermission` and
  `requireSelfOrPermission` — unauthenticated → 401, missing permission → 403, holder allowed,
  superadmin bypass, and the degraded empty-claims token still yielding a clean 403.
- **Integration (real Fastify + Prisma)** —
  - `test/integration/roles.int.test.ts`: the full `/roles` and `/permissions` HTTP surface — create
    (201 / 409 duplicate / 400 unknown permission / 403 non-superadmin), list, get (200 / 404),
    patch, soft-delete (204 / 403 system role), and the assign→login→grant→revoke lifecycle including
    the refusal to assign a system role.
  - `test/integration/sync.int.test.ts`: `SyncAuthorization` end-to-end — mirrors the catalogue and
    seeds the superadmin idempotently, prunes a stored permission the catalogue dropped, and promotes
    the bootstrap operator once then no-ops.

Run them with:

```bash
npm test                  # all unit + integration tests (vitest run)
npm run test:integration  # integration suite only
```
