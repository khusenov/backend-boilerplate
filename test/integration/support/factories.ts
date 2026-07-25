import type { FastifyInstance } from 'fastify';
import { SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

let counter = 0;

export async function makeSuperadmin(app: FastifyInstance, userId: string): Promise<void> {
  const { prisma, idGenerator } = app.diContainer.cradle;
  const now = new Date();
  const role = await prisma.role.upsert({
    where: { key: SUPERADMIN_ROLE_KEY },
    create: {
      id: idGenerator.generate(),
      key: SUPERADMIN_ROLE_KEY,
      name: 'Super Admin',
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    },
    update: {},
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id, createdAt: now },
    update: {},
  });
}

export async function seedRoleWithPermissions(
  app: FastifyInstance,
  userId: string,
  permissionKeys: string[],
): Promise<string> {
  const { prisma, idGenerator } = app.diContainer.cradle;
  const now = new Date();
  const role = await prisma.role.create({
    data: {
      id: idGenerator.generate(),
      name: `role-${++counter}`,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const key of permissionKeys) {
    const permission = await prisma.permission.upsert({
      where: { key },
      create: { id: idGenerator.generate(), key, name: key, createdAt: now, updatedAt: now },
      update: {},
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  await prisma.userRole.create({ data: { userId, roleId: role.id, createdAt: now } });
  return role.id;
}

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
    url: '/v1/auth/login',
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
