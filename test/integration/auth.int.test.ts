import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { login, refreshCookiesFrom, seedUser } from './support/factories';

describe('/auth (integration)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  // Each test is self-contained: it seeds exactly the users/sessions it needs,
  // then the DB is wiped between tests. (Unlike the /users suite, the auth flows
  // need different starting states — raw credentials, a live session, an
  // inactive account — so there is no shared "actor".)
  afterEach(async () => {
    await resetDb(h.prisma);
  });

  describe('POST /auth/login', () => {
    it('returns { user, accessToken } and sets the refresh cookie (200)', async () => {
      const user = await seedUser(h.app, { email: 'ada@finflow.test' });

      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: user.password },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ user: { id: string; email: string }; accessToken: string }>();
      expect(body.user).toMatchObject({ id: user.id, email: 'ada@finflow.test' });
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(typeof body.accessToken).toBe('string');
      expect(body.accessToken.length).toBeGreaterThan(0);

      // httpOnly refresh cookie, scoped to the /auth path so it is only sent to
      // /auth/refresh and /auth/logout.
      const cookie = res.cookies.find((c) => c.name === 'refreshToken');
      expect(cookie).toMatchObject({ httpOnly: true, path: '/auth' });
      expect(cookie?.value.length).toBeGreaterThan(0);

      // The opaque refresh token is persisted (hashed) and tied to the user.
      const persisted = await h.prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.tokenHash).not.toBe(cookie?.value); // stored hashed, not raw
    });

    it('rejects a wrong password (401)', async () => {
      const user = await seedUser(h.app);

      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: 'definitely-wrong' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects an unknown email (401)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@finflow.test', password: 'whatever-123' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a deactivated user (401)', async () => {
      const user = await seedUser(h.app);
      // Flip the persisted account to inactive; login must refuse it even with
      // the correct password (Login throws InvalidCredentialsError on !isActive).
      await h.prisma.user.update({ where: { id: user.id }, data: { status: 'inactive' } });

      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: user.password },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects invalid input (400)', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the refresh token and issues a fresh access token (200)', async () => {
      const session = await login(h.app, await seedUser(h.app));

      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: session.refreshCookies,
      });

      expect(res.statusCode).toBe(200);
      expect(typeof res.json<{ accessToken: string }>().accessToken).toBe('string');

      // Rotation: a brand-new refresh cookie, different from the one we sent.
      const rotated = refreshCookiesFrom(res);
      expect(rotated.refreshToken).toBeDefined();
      expect(rotated.refreshToken).not.toBe(session.refreshCookies.refreshToken);

      // ...and the rotated cookie is itself usable, so the chain continues.
      const next = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: rotated,
      });
      expect(next.statusCode).toBe(200);
    });

    it('detects reuse of a rotated token and revokes the whole family (401)', async () => {
      const session = await login(h.app, await seedUser(h.app));

      // First refresh rotates the original token -> `rotated`.
      const first = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: session.refreshCookies,
      });
      expect(first.statusCode).toBe(200);
      const rotated = refreshCookiesFrom(first);

      // Replaying the now-used original token is treated as theft.
      const reuse = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: session.refreshCookies,
      });
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json<{ error: { code: string } }>().error.code).toBe('REFRESH_TOKEN_REUSED');

      // Reuse revokes the entire family, so even the legitimately rotated token
      // is now dead — the defining property of refresh-token theft detection.
      const afterReuse = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: rotated,
      });
      expect(afterReuse.statusCode).toBe(401);
    });

    it('rejects a refresh with no token at all (401)', async () => {
      const res = await h.app.inject({ method: 'POST', url: '/auth/refresh' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a refresh with an unknown token (401)', async () => {
      // No cookie -> route falls back to the body token, which does not match
      // any stored hash. Exercises the body-token path as a side effect.
      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: 'not-a-real-token' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('REFRESH_TOKEN_INVALID');
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the cookie and kills the refresh token (204)', async () => {
      const session = await login(h.app, await seedUser(h.app));

      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: session.refreshCookies,
      });
      expect(res.statusCode).toBe(204);

      // The Set-Cookie clears the refresh cookie (empty value).
      const cleared = res.cookies.find((c) => c.name === 'refreshToken');
      expect(cleared?.value).toBe('');

      // The revoked token can no longer be refreshed.
      const refresh = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: session.refreshCookies,
      });
      expect(refresh.statusCode).toBe(401);
    });

    it('is a no-op when no token is supplied (204)', async () => {
      const res = await h.app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the authenticated user (200)', async () => {
      const user = await seedUser(h.app, { email: 'me@finflow.test' });
      const session = await login(h.app, user);

      const res = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: session.authHeader,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; email: string }>();
      expect(body).toMatchObject({ id: user.id, email: 'me@finflow.test' });
      expect(body).not.toHaveProperty('passwordHash');
    });

    it('rejects a request with no token (401)', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a malformed bearer token (401)', async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // Capstone: the whole session lifecycle wired together, proving the endpoints
  // interoperate (e.g. a refreshed access token really does authenticate /me).
  describe('full lifecycle', () => {
    it('login -> me -> refresh -> me(new token) -> logout -> refresh fails', async () => {
      const user = await seedUser(h.app, { email: 'flow@finflow.test' });

      const session = await login(h.app, user);

      const me1 = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: session.authHeader,
      });
      expect(me1.statusCode).toBe(200);
      expect(me1.json<{ email: string }>().email).toBe('flow@finflow.test');

      const refreshed = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: session.refreshCookies,
      });
      expect(refreshed.statusCode).toBe(200);
      const newAccessToken = refreshed.json<{ accessToken: string }>().accessToken;
      const rotated = refreshCookiesFrom(refreshed);

      const me2 = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${newAccessToken}` },
      });
      expect(me2.statusCode).toBe(200);

      const out = await h.app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: rotated,
      });
      expect(out.statusCode).toBe(204);

      const refreshAfterLogout = await h.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: rotated,
      });
      expect(refreshAfterLogout.statusCode).toBe(401);
    });
  });
});
