import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { authHeader, makeSuperadmin, seedUser, type SeededUser } from './support/factories';

describe('/roles & /permissions (integration)', () => {
  let h: TestHarness;
  let admin: SeededUser;
  let auth: { authorization: string };

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  beforeEach(async () => {
    await h.app.diContainer.cradle.syncAuthorization.execute();
    admin = await seedUser(h.app);
    await makeSuperadmin(h.app, admin.id);
    auth = await authHeader(h.app, admin);
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  async function createRole(payload: Record<string, unknown>) {
    return h.app.inject({ method: 'POST', url: '/v1/roles', headers: auth, payload });
  }

  describe('GET /permissions', () => {
    it('returns the catalogue grouped by category (200)', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/v1/permissions', headers: auth });

      expect(res.statusCode).toBe(200);
      const groups = res.json<{ category: string; permissions: { key: string }[] }[]>();
      expect(groups.map((g) => g.category)).toContain('users');
      const allKeys = groups.flatMap((g) => g.permissions.map((p) => p.key));
      expect(allKeys).toContain('roles.assign');

      // Every group/item carries exactly its contract keys — the response schema
      // strips anything the catalogue might carry internally.
      for (const g of groups) {
        expect(Object.keys(g).sort()).toEqual(['category', 'permissions']);
        for (const p of g.permissions) {
          expect(Object.keys(p).sort()).toEqual(['key', 'name']);
        }
      }
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/v1/permissions' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /roles', () => {
    it('creates a role with permissions (201)', async () => {
      const res = await createRole({
        name: 'Support',
        description: 'Read-only staff',
        permissions: ['users.read'],
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{
        id: string;
        name: string;
        permissions: string[];
        isSystem: boolean;
      }>();
      expect(body).toMatchObject({ name: 'Support', isSystem: false, permissions: ['users.read'] });

      const inDb = await h.prisma.role.findUnique({ where: { id: body.id } });
      expect(inDb?.name).toBe('Support');
    });

    it('returns exactly the public role contract (no internal fields)', async () => {
      const created = await createRole({
        name: 'Contract',
        description: 'x',
        permissions: ['users.read'],
      });
      expect(created.statusCode).toBe(201);
      const body = created.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(
        [
          'createdAt',
          'description',
          'id',
          'isSystem',
          'key',
          'name',
          'permissions',
          'updatedAt',
        ].sort(),
      );
      // `deletedAt` (soft-delete) and other entity internals are not in the contract.
      expect(body).not.toHaveProperty('deletedAt');
    });

    it('rejects a duplicate active name (409)', async () => {
      await createRole({ name: 'Support' });
      const res = await createRole({ name: 'Support' });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('ROLE_NAME_TAKEN');
    });

    it('rejects an unknown permission key (400)', async () => {
      const res = await createRole({ name: 'Bad', permissions: ['users.read', 'users.reign'] });
      expect(res.statusCode).toBe(400);
    });

    it('forbids a non-superadmin (403)', async () => {
      const pleb = await seedUser(h.app);
      const plebAuth = await authHeader(h.app, pleb);

      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/roles',
        headers: plebAuth,
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /roles', () => {
    it('lists roles with pagination metadata (200)', async () => {
      await createRole({ name: 'Alpha' });
      await createRole({ name: 'Beta' });

      const res = await h.app.inject({ method: 'GET', url: '/v1/roles', headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { name: string }[]; total: number }>();
      expect(body.items.map((r) => r.name)).toEqual(
        expect.arrayContaining(['Alpha', 'Beta', 'Super Admin']),
      );
    });
  });

  describe('GET /roles/:id', () => {
    it('returns a role by id (200) and 404 for an unknown id', async () => {
      const created = await createRole({ name: 'Solo', permissions: ['roles.read'] });
      const { id } = created.json<{ id: string }>();

      const ok = await h.app.inject({ method: 'GET', url: `/v1/roles/${id}`, headers: auth });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ permissions: string[] }>().permissions).toEqual(['roles.read']);

      const missing = await h.app.inject({
        method: 'GET',
        url: `/v1/roles/${randomUUID()}`,
        headers: auth,
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('PATCH /roles/:id', () => {
    it('renames and replaces the permission set (200)', async () => {
      const created = await createRole({ name: 'Old', permissions: ['users.read'] });
      const { id } = created.json<{ id: string }>();

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/v1/roles/${id}`,
        headers: auth,
        payload: { name: 'New', permissions: ['users.read', 'users.update'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ name: string; permissions: string[] }>();
      expect(body.name).toBe('New');
      expect([...body.permissions].sort()).toEqual(['users.read', 'users.update']);
    });
  });

  describe('DELETE /roles/:id', () => {
    it('soft-deletes an admin role (204) and hides it from reads', async () => {
      const created = await createRole({ name: 'Temp' });
      const { id } = created.json<{ id: string }>();

      const del = await h.app.inject({ method: 'DELETE', url: `/v1/roles/${id}`, headers: auth });
      expect(del.statusCode).toBe(204);

      const inDb = await h.prisma.role.findUnique({ where: { id } });
      expect(inDb?.deletedAt).not.toBeNull();

      const get = await h.app.inject({ method: 'GET', url: `/v1/roles/${id}`, headers: auth });
      expect(get.statusCode).toBe(404);
    });

    it('refuses to delete a system role (403)', async () => {
      const superadmin = await h.prisma.role.findUnique({ where: { key: 'super-admin' } });

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/v1/roles/${superadmin!.id}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('ROLE_PROTECTED');
    });
  });

  describe('role assignment lifecycle', () => {
    it('assigning a role grants its permissions on next login; revoking removes them', async () => {
      const created = await createRole({ name: 'Reader', permissions: ['users.read'] });
      const { id: roleId } = created.json<{ id: string }>();
      const member = await seedUser(h.app);

      const before = await authHeader(h.app, member);
      expect(
        (await h.app.inject({ method: 'GET', url: '/v1/users', headers: before })).statusCode,
      ).toBe(403);

      const assign = await h.app.inject({
        method: 'POST',
        url: `/v1/users/${member.id}/roles`,
        headers: auth,
        payload: { roleId },
      });
      expect(assign.statusCode).toBe(204);

      const granted = await authHeader(h.app, member);
      expect(
        (await h.app.inject({ method: 'GET', url: '/v1/users', headers: granted })).statusCode,
      ).toBe(200);

      const revoke = await h.app.inject({
        method: 'DELETE',
        url: `/v1/users/${member.id}/roles/${roleId}`,
        headers: auth,
      });
      expect(revoke.statusCode).toBe(204);

      const revoked = await authHeader(h.app, member);
      expect(
        (await h.app.inject({ method: 'GET', url: '/v1/users', headers: revoked })).statusCode,
      ).toBe(403);
    });

    it('refuses to assign a system role through the API (403)', async () => {
      const superadmin = await h.prisma.role.findUnique({ where: { key: 'super-admin' } });
      const member = await seedUser(h.app);

      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/users/${member.id}/roles`,
        headers: auth,
        payload: { roleId: superadmin!.id },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
