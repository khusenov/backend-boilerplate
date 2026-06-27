import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { authHeader, seedUser, type SeededUser } from './support/factories';

describe('/users (integration)', () => {
  let h: TestHarness;
  let actor: SeededUser;
  let auth: { authorization: string };

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  // Every /users route is guarded by the `authenticate` hook, so each test runs
  // as a freshly seeded, logged-in "actor". The actor is itself a persisted user,
  // which the read assertions below account for.
  beforeEach(async () => {
    actor = await seedUser(h.app);
    auth = await authHeader(h.app, actor);
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  describe('POST /users', () => {
    it('creates and persists a user (201)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@finflow.test',
          password: 'password123',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ id: string; firstName: string; email: string }>();
      expect(body).toMatchObject({ firstName: 'John', email: 'john@finflow.test' });
      expect(body).not.toHaveProperty('passwordHash');

      const inDb = await h.prisma.user.findUnique({ where: { email: 'john@finflow.test' } });
      expect(inDb).not.toBeNull();
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/users',
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@finflow.test',
          password: 'password123',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a duplicate email (409)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        // actor.email is already persisted by the beforeEach hook.
        payload: { firstName: 'A', lastName: 'B', email: actor.email, password: 'password123' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects invalid input (400)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/users',
        headers: auth,
        payload: { firstName: '', lastName: 'B', email: 'not-an-email', password: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /users', () => {
    it('lists users with pagination metadata (200)', async () => {
      // actor (beforeEach) + 2 = 3 persisted users.
      await seedUser(h.app);
      await seedUser(h.app);

      const res = await h.app.inject({ method: 'GET', url: '/users', headers: auth });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        items: { id: string; email: string }[];
        total: number;
        page: number;
        pageSize: number;
        hasNext: boolean;
        hasPrev: boolean;
      }>();
      expect(body).toMatchObject({
        total: 3,
        page: 1,
        pageSize: 10,
        hasNext: false,
        hasPrev: false,
      });
      expect(body.items).toHaveLength(3);
      expect(body.items.map((u) => u.email)).toContain(actor.email);
      for (const u of body.items) expect(u).not.toHaveProperty('passwordHash');
    });

    it('honours page and pageSize query params (200)', async () => {
      // actor + 4 = 5 persisted users; with pageSize 2 that is 3 pages.
      await seedUser(h.app);
      await seedUser(h.app);
      await seedUser(h.app);
      await seedUser(h.app);

      const first = await h.app.inject({
        method: 'GET',
        url: '/users?page=1&pageSize=2',
        headers: auth,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json<{
        items: unknown[];
        total: number;
        hasNext: boolean;
        hasPrev: boolean;
      }>();
      expect(firstBody.items).toHaveLength(2);
      expect(firstBody).toMatchObject({ total: 5, hasNext: true, hasPrev: false });

      const last = await h.app.inject({
        method: 'GET',
        url: '/users?page=3&pageSize=2',
        headers: auth,
      });
      const lastBody = last.json<{ items: unknown[]; hasNext: boolean; hasPrev: boolean }>();
      expect(lastBody.items).toHaveLength(1); // 5 users across 3 pages -> last page holds one
      expect(lastBody).toMatchObject({ hasNext: false, hasPrev: true });
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/users' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /users/:id', () => {
    it('returns a user by id (200)', async () => {
      const target = await seedUser(h.app, { email: 'target@finflow.test' });

      const res = await h.app.inject({
        method: 'GET',
        url: `/users/${target.id}`,
        headers: auth,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; email: string }>();
      expect(body).toMatchObject({ id: target.id, email: 'target@finflow.test' });
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('returns 404 for a well-formed but unknown id', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/users/${randomUUID()}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for a malformed id', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/users/not-a-uuid', headers: auth });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({ method: 'GET', url: `/users/${randomUUID()}` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates a subset of fields and leaves the rest intact (200)', async () => {
      const target = await seedUser(h.app, { firstName: 'Old', lastName: 'Name' });

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${target.id}`,
        headers: auth,
        payload: { firstName: 'New' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ firstName: string; lastName: string; fullName: string }>();
      expect(body).toMatchObject({ firstName: 'New', lastName: 'Name', fullName: 'New Name' });

      const inDb = await h.prisma.user.findUnique({ where: { id: target.id } });
      expect(inDb?.firstName).toBe('New');
    });

    it('updates the email (200)', async () => {
      const target = await seedUser(h.app, { email: 'before@finflow.test' });

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${target.id}`,
        headers: auth,
        payload: { email: 'after@finflow.test' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ email: string }>().email).toBe('after@finflow.test');

      const inDb = await h.prisma.user.findUnique({ where: { id: target.id } });
      expect(inDb?.email).toBe('after@finflow.test');
    });

    it('rejects an email already taken by another user (409)', async () => {
      const target = await seedUser(h.app);

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${target.id}`,
        headers: auth,
        // actor already owns this email.
        payload: { email: actor.email },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 404 for a well-formed but unknown id', async () => {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${randomUUID()}`,
        headers: auth,
        payload: { firstName: 'Nope' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid input', async () => {
      const target = await seedUser(h.app);

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${target.id}`,
        headers: auth,
        payload: { email: 'not-an-email' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/users/${randomUUID()}`,
        payload: { firstName: 'X' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /users/:id', () => {
    it('soft-deletes a user (204) and hides it from subsequent reads', async () => {
      const target = await seedUser(h.app);

      const res = await h.app.inject({
        method: 'DELETE',
        url: `/users/${target.id}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);

      // Soft delete: the row is retained but stamped with deletedAt.
      const inDb = await h.prisma.user.findUnique({ where: { id: target.id } });
      expect(inDb).not.toBeNull();
      expect(inDb?.deletedAt).not.toBeNull();

      // Reads no longer surface the user.
      const getRes = await h.app.inject({
        method: 'GET',
        url: `/users/${target.id}`,
        headers: auth,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('excludes soft-deleted users from the list', async () => {
      const target = await seedUser(h.app); // actor + target = 2 persisted users
      await h.app.inject({ method: 'DELETE', url: `/users/${target.id}`, headers: auth });

      const res = await h.app.inject({ method: 'GET', url: '/users', headers: auth });
      const body = res.json<{ total: number; items: { id: string }[] }>();
      expect(body.total).toBe(1); // only the actor remains visible
      expect(body.items.map((u) => u.id)).not.toContain(target.id);
    });

    it('returns 404 for a well-formed but unknown id', async () => {
      const res = await h.app.inject({
        method: 'DELETE',
        url: `/users/${randomUUID()}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when deleting an already-deleted user', async () => {
      const target = await seedUser(h.app);

      const first = await h.app.inject({
        method: 'DELETE',
        url: `/users/${target.id}`,
        headers: auth,
      });
      expect(first.statusCode).toBe(204);

      const second = await h.app.inject({
        method: 'DELETE',
        url: `/users/${target.id}`,
        headers: auth,
      });
      expect(second.statusCode).toBe(404);
    });

    it('rejects an unauthenticated request (401)', async () => {
      const res = await h.app.inject({ method: 'DELETE', url: `/users/${randomUUID()}` });
      expect(res.statusCode).toBe(401);
    });
  });
});
