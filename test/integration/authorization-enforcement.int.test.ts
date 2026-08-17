import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import {
  authHeader,
  seedRoleWithPermissions,
  seedUser,
  INTEGRATION_SYSTEM_ACTOR,
} from './support/factories';
import { API_V1_PREFIX } from '@/presentation/http/api-version';
import { PERMISSIONS, type PermissionKey } from '@/domain/authorization/permission-catalogue';

// Fastify's own HTTPMethods is wider than what inject accepts (it includes TRACE, MKCOL, …),
// so deriving the type from InjectOptions is what keeps `method` assignable.
type InjectMethod = NonNullable<InjectOptions['method']>;

interface PathsDocument {
  paths?: Record<string, Record<string, unknown> | undefined>;
}

interface DerivedRoute {
  key: string;
  method: InjectMethod;
  path: string;
}

interface SelfAccessRoute extends DerivedRoute {
  permission: PermissionKey;
  payload?: Record<string, unknown>;
}

const VERSIONED_PATH_PREFIX = `${API_V1_PREFIX}/`;
const ANONYMOUS_PATH_PREFIX = `${API_V1_PREFIX}/auth/`;

// Self-access routes admit their own owner with no permissions at all, so the zero-permission
// probe cannot be used on them. Their self-access behaviour is covered by users.int.test.ts;
// the permission each one falls back to is pinned by the cross-user test below.
const SELF_ACCESS_ROUTES: SelfAccessRoute[] = [
  {
    key: 'GET /v1/users/{id}',
    method: 'GET',
    path: '/v1/users/{id}',
    permission: PERMISSIONS.UsersRead.key,
  },
  {
    key: 'PATCH /v1/users/{id}',
    method: 'PATCH',
    path: '/v1/users/{id}',
    permission: PERMISSIONS.UsersUpdate.key,
    payload: { firstName: 'Renamed' },
  },
];

const ROUTE_PERMISSIONS: Record<string, PermissionKey> = {
  'GET /v1/users': PERMISSIONS.UsersRead.key,
  'POST /v1/users': PERMISSIONS.UsersCreate.key,
  'DELETE /v1/users/{id}': PERMISSIONS.UsersDelete.key,
  'POST /v1/users/{id}/roles': PERMISSIONS.RolesAssign.key,
  'DELETE /v1/users/{id}/roles/{roleId}': PERMISSIONS.RolesAssign.key,
  'GET /v1/roles': PERMISSIONS.RolesRead.key,
  'POST /v1/roles': PERMISSIONS.RolesCreate.key,
  'GET /v1/roles/{id}': PERMISSIONS.RolesRead.key,
  'PATCH /v1/roles/{id}': PERMISSIONS.RolesUpdate.key,
  'DELETE /v1/roles/{id}': PERMISSIONS.RolesDelete.key,
  'GET /v1/permissions': PERMISSIONS.RolesRead.key,
};

// Mutating routes need a schema-valid body, or Fastify answers 400 before authorization runs.
const ROUTE_BODIES: Record<string, Record<string, unknown>> = {
  'POST /v1/users': {
    firstName: 'Probe',
    lastName: 'User',
    email: 'probe@example.test',
    password: 'super-secret-password',
  },
  'POST /v1/users/{id}/roles': { roleId: '00000000-0000-4000-8000-000000000000' },
  'POST /v1/roles': { name: 'probe-role' },
  'PATCH /v1/roles/{id}': { name: 'probe-role-renamed' },
};

// app.swagger() emits collection roots with a trailing slash ('/v1/users/') and parameterised
// paths without ('/v1/users/{id}'); normalise so map keys have one spelling.
function normalizePath(path: string): string {
  return path.replace(/\/$/, '') || '/';
}

function urlFor(path: string): string {
  return path.replace(/\{[^}]+\}/g, () => randomUUID());
}

function derivedRoutes(app: TestHarness['app']): DerivedRoute[] {
  const document = app.swagger() as PathsDocument;

  return Object.entries(document.paths ?? {})
    .flatMap(([rawPath, item]) => {
      const path = normalizePath(rawPath);
      return Object.keys(item ?? {}).map((method) => ({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase() as InjectMethod,
        path,
      }));
    })
    .filter((route) => route.path.startsWith(VERSIONED_PATH_PREFIX))
    .filter((route) => !route.path.startsWith(ANONYMOUS_PATH_PREFIX));
}

function guardedRoutes(app: TestHarness['app']): DerivedRoute[] {
  const selfAccessKeys = SELF_ACCESS_ROUTES.map((route) => route.key);
  return derivedRoutes(app).filter((route) => !selfAccessKeys.includes(route.key));
}

describe('authorization enforcement (integration)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  beforeEach(async () => {
    await h.app.diContainer.cradle.syncAuthorization.execute(INTEGRATION_SYSTEM_ACTOR);
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  it('accounts for every versioned route the app exposes', () => {
    const derived = derivedRoutes(h.app)
      .map((route) => route.key)
      .sort();
    const accounted = [
      ...Object.keys(ROUTE_PERMISSIONS),
      ...SELF_ACCESS_ROUTES.map((route) => route.key),
    ].sort();

    expect(derived).toEqual(accounted);
  });

  it('denies every guarded route to a caller holding no permissions', async () => {
    const stranger = await seedUser(h.app);
    const strangerAuth = await authHeader(h.app, stranger);
    const failures: string[] = [];

    for (const route of guardedRoutes(h.app)) {
      const expected = ROUTE_PERMISSIONS[route.key];
      const body = ROUTE_BODIES[route.key];

      const res = await h.app.inject({
        method: route.method,
        url: urlFor(route.path),
        headers: strangerAuth,
        ...(body ? { payload: body } : {}),
      });

      const required =
        res.statusCode === 403
          ? res.json<{ error?: { details?: { required?: string } } }>().error?.details?.required
          : undefined;

      if (required !== expected) {
        failures.push(`${route.key} -> ${String(res.statusCode)} ${res.body}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('admits every guarded route to a caller holding exactly the mapped permission', async () => {
    const failures: string[] = [];

    for (const route of guardedRoutes(h.app)) {
      const permission = ROUTE_PERMISSIONS[route.key];
      if (!permission) continue;

      const holder = await seedUser(h.app);
      await seedRoleWithPermissions(h.app, holder.id, [permission]);
      const holderAuth = await authHeader(h.app, holder);
      const body = ROUTE_BODIES[route.key];

      const res = await h.app.inject({
        method: route.method,
        url: urlFor(route.path),
        headers: holderAuth,
        ...(body ? { payload: body } : {}),
      });

      if (res.statusCode === 403) failures.push(`${route.key} -> 403 ${res.body}`);
    }

    expect(failures).toEqual([]);
  });

  it('admits a caller holding the mapped permission on a different user record', async () => {
    const failures: string[] = [];

    for (const route of SELF_ACCESS_ROUTES) {
      const holder = await seedUser(h.app);
      await seedRoleWithPermissions(h.app, holder.id, [route.permission]);
      const holderAuth = await authHeader(h.app, holder);
      const target = await seedUser(h.app);

      const res = await h.app.inject({
        method: route.method,
        url: route.path.replace('{id}', target.id),
        headers: holderAuth,
        ...(route.payload ? { payload: route.payload } : {}),
      });

      if (res.statusCode === 403) failures.push(`${route.key} -> 403 ${res.body}`);
    }

    expect(failures).toEqual([]);
  });
});
