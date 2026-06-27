import type { FastifyInstance } from 'fastify';

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

let counter = 0;

export async function seedUser(
  app: FastifyInstance,
  overrides: Partial<{ firstName: string; lastName: string; email: string; password: string }> = {},
): Promise<SeededUser> {
  const firstName = overrides.firstName ?? 'Test';
  const lastName = overrides.lastName ?? 'User';
  const email = overrides.email ?? `user${++counter}@finflow.test`;
  const password = overrides.password ?? 'super-secret-password';

  const { createUser } = app.diContainer.cradle;
  const dto = await createUser.execute({ firstName, lastName, email, password });

  return { id: dto.id, email, password };
}

export interface AuthSession {
  accessToken: string;
  authHeader: { authorization: string };
  refreshCookies: Record<string, string>;
}

export function refreshCookiesFrom(res: {
  cookies: { name: string; value: string }[];
}): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

export async function login(app: FastifyInstance, user: SeededUser): Promise<AuthSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: user.email, password: user.password },
  });
  if (res.statusCode !== 200)
    throw new Error(`Login failed in test setup: ${res.statusCode} ${res.body}`);

  const { accessToken } = res.json<{ accessToken: string }>();

  return {
    accessToken,
    authHeader: { authorization: `Bearer ${accessToken}` },
    refreshCookies: refreshCookiesFrom(res),
  };
}

export async function authHeader(
  app: FastifyInstance,
  user: SeededUser,
): Promise<{ authorization: string }> {
  return (await login(app, user)).authHeader;
}
