import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import {
  authHeader,
  INTEGRATION_SYSTEM_ACTOR,
  makeSuperadmin,
  seedRoleWithPermissions,
  seedUser,
  type SeededUser,
} from './support/factories';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import { Role } from '@/domain/authorization/role-entity';
import { PrismaRoleReader } from '@/infrastructure/persistence/prisma-role-reader';

const LATER = new Date('2026-09-01T00:00:00.000Z');

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.app.close();
});

afterEach(async () => {
  await resetDb(h.prisma);
});

describe('optimistic concurrency on the user aggregate (integration)', () => {
  it('inserts a new user at version 1', async () => {
    const user = await seedUser(h.app);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(row.version).toBe(1);
  });

  it('increments the stored version on every accepted edit', async () => {
    const user = await seedUser(h.app);
    const auth = await authHeader(h.app, user);

    const first = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${user.id}`,
      headers: auth,
      payload: { firstName: 'First' },
    });
    const second = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${user.id}`,
      headers: auth,
      payload: { firstName: 'Second' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(row.version).toBe(3);
  });

  it('rejects the second of two writers that loaded the same version', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const first = await users.findById(seeded.id);
    const second = await users.findById(seeded.id);
    if (!first || !second) throw new Error('seeded user was not readable');

    first.changeFirstName('Winner', LATER);
    second.changeFirstName('Loser', LATER);

    await users.save(first);

    await expect(users.save(second)).rejects.toThrow(StaleAggregateError);
  });

  it('keeps the winning write intact after the losing write is rejected', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const first = await users.findById(seeded.id);
    const second = await users.findById(seeded.id);
    if (!first || !second) throw new Error('seeded user was not readable');

    first.changeFirstName('Winner', LATER);
    second.changeFirstName('Loser', LATER);

    await users.save(first);
    await expect(users.save(second)).rejects.toThrow(StaleAggregateError);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Winner');
    expect(row.version).toBe(2);
  });

  it('accepts a writer that reloads after losing', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const winner = await users.findById(seeded.id);
    const stale = await users.findById(seeded.id);
    if (!winner || !stale) throw new Error('seeded user was not readable');

    winner.changeFirstName('Winner', LATER);
    await users.save(winner);

    stale.changeFirstName('Retrier', LATER);
    await expect(users.save(stale)).rejects.toThrow(StaleAggregateError);

    const reloaded = await users.findById(seeded.id);
    if (!reloaded) throw new Error('user vanished');
    reloaded.changeFirstName('Retrier', LATER);
    await users.save(reloaded);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Retrier');
    expect(row.version).toBe(3);
  });

  it('surfaces a real stale write over HTTP as 409 STALE_AGGREGATE', async () => {
    const seeded = await seedUser(h.app);
    const auth = await authHeader(h.app, seeded);
    const users = h.app.diContainer.cradle.userRepository;

    const stale = await users.findById(seeded.id);
    if (!stale) throw new Error('seeded user was not readable');

    const bump = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${seeded.id}`,
      headers: auth,
      payload: { firstName: 'Winner' },
    });
    expect(bump.statusCode).toBe(200);

    const spy = vi.spyOn(users, 'findById').mockResolvedValueOnce(stale);
    try {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/v1/users/${seeded.id}`,
        headers: auth,
        payload: { firstName: 'Loser' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STALE_AGGREGATE');
    } finally {
      spy.mockRestore();
    }

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Winner');
    expect(row.version).toBe(2);
  });
});

interface Barrier {
  readonly reached: Promise<void>;
  release(): void;
}

function barrier(): Barrier {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

describe('optimistic concurrency on the role aggregate (integration)', () => {
  let admin: SeededUser;
  let auth: { authorization: string };

  beforeEach(async () => {
    await h.app.diContainer.cradle.syncAuthorization.execute(INTEGRATION_SYSTEM_ACTOR);
    admin = await seedUser(h.app);
    await makeSuperadmin(h.app, admin.id);
    auth = await authHeader(h.app, admin);
  });

  // Two transactions that both load the role before either saves. The barriers pin the
  // order load(winner) -> load(loser) -> save(winner) -> commit -> save(loser); relying on
  // microtask ordering alone would make the interleaving likely rather than certain.
  async function raceTwoWriters(
    roleId: string,
    mutateWinner: (role: Role) => void,
    mutateLoser: (role: Role) => void,
  ): Promise<{ loserError: unknown }> {
    const uow = h.app.diContainer.cradle.unitOfWork;
    const loserLoaded = barrier();
    const winnerCommitted = barrier();

    const winner = uow.run(async ({ roleRepository }) => {
      const role = await roleRepository.findById(roleId);
      await loserLoaded.reached;
      if (!role) throw new Error('seeded role was not readable');
      mutateWinner(role);
      await roleRepository.save(role);
    });

    const loser = uow.run(async ({ roleRepository }) => {
      const role = await roleRepository.findById(roleId);
      loserLoaded.release();
      await winnerCommitted.reached;
      if (!role) throw new Error('seeded role was not readable');
      mutateLoser(role);
      await roleRepository.save(role);
    });
    const loserSettled = loser.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await winner;
    } finally {
      winnerCommitted.release();
    }

    return { loserError: await loserSettled };
  }

  async function storedPermissionKeys(roleId: string): Promise<string[]> {
    const rows = await h.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    return rows.map((row) => row.permission.key).sort();
  }

  it('inserts a new role at version 1', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/roles',
      headers: auth,
      payload: { name: 'Support', permissions: ['users.read'] },
    });
    expect(res.statusCode).toBe(201);

    const row = await h.prisma.role.findUniqueOrThrow({
      where: { id: res.json<{ id: string }>().id },
    });

    expect(row.version).toBe(1);
  });

  it('increments the stored version on every accepted edit', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, []);

    for (const description of ['First', 'Second']) {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/v1/roles/${roleId}`,
        headers: auth,
        payload: { description },
      });
      expect(res.statusCode).toBe(200);
    }

    const row = await h.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

    expect(row.version).toBe(3);
  });

  it('rejects the second of two overlapping transactions that loaded the same version', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, []);

    const { loserError } = await raceTwoWriters(
      roleId,
      (role) => role.rename('Winner', LATER),
      (role) => role.rename('Loser', LATER),
    );

    expect(loserError).toBeInstanceOf(StaleAggregateError);
    expect(loserError).toMatchObject({ code: 'STALE_AGGREGATE' });
  });

  it('keeps the winning write intact after the losing write is rejected', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, []);

    const { loserError } = await raceTwoWriters(
      roleId,
      (role) => {
        role.rename('Winner', LATER);
        role.setPermissions(['users.read', 'users.update'], LATER);
      },
      (role) => role.rename('Loser', LATER),
    );
    expect(loserError).toBeInstanceOf(StaleAggregateError);

    const row = await h.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

    expect(row.name).toBe('Winner');
    expect(row.version).toBe(2);
    expect(await storedPermissionKeys(roleId)).toEqual(['users.read', 'users.update']);
  });

  it('does not silently lose a permission-set edit under concurrency', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, ['users.read']);

    const { loserError } = await raceTwoWriters(
      roleId,
      (role) => role.setPermissions(['roles.read', 'roles.update'], LATER),
      (role) => role.setPermissions(['users.delete'], LATER),
    );
    expect(loserError).toBeInstanceOf(StaleAggregateError);

    expect(await storedPermissionKeys(roleId)).toEqual(['roles.read', 'roles.update']);
  });

  it('accepts a writer that reloads after losing', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, []);

    const { loserError } = await raceTwoWriters(
      roleId,
      (role) => role.rename('Winner', LATER),
      (role) => role.rename('Retrier', LATER),
    );
    expect(loserError).toBeInstanceOf(StaleAggregateError);

    await h.app.diContainer.cradle.unitOfWork.run(async ({ roleRepository }) => {
      const reloaded = await roleRepository.findById(roleId);
      if (!reloaded) throw new Error('role vanished');
      reloaded.rename('Retrier', LATER);
      await roleRepository.save(reloaded);
    });

    const row = await h.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

    expect(row.name).toBe('Retrier');
    expect(row.version).toBe(3);
  });

  it('surfaces a stale role edit over HTTP as 409 STALE_AGGREGATE', async () => {
    const roleId = await seedRoleWithPermissions(h.app, admin.id, []);
    const stale = await h.app.diContainer.cradle.unitOfWork.run(({ roleRepository }) =>
      roleRepository.findById(roleId),
    );
    if (!stale) throw new Error('seeded role was not readable');

    const bump = await h.app.inject({
      method: 'PATCH',
      url: `/v1/roles/${roleId}`,
      headers: auth,
      payload: { description: 'Winner' },
    });
    expect(bump.statusCode).toBe(200);

    // EditRole resolves its repository from the TransactionContext — a fresh instance the
    // cradle never hands out — so the stale aggregate has to be injected via the prototype.
    const spy = vi.spyOn(PrismaRoleReader.prototype, 'findById').mockResolvedValueOnce(stale);
    try {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/v1/roles/${roleId}`,
        headers: auth,
        payload: { description: 'Loser' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STALE_AGGREGATE');
    } finally {
      spy.mockRestore();
    }

    const row = await h.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

    expect(row.description).toBe('Winner');
    expect(row.version).toBe(2);
  });

  it('rolls back the role row and its permission rows together', async () => {
    const roleId = randomUUID();

    await expect(
      h.app.diContainer.cradle.unitOfWork.run(async ({ roleRepository }) => {
        await roleRepository.save(
          Role.create({ id: roleId, name: 'Doomed', permissions: ['users.read'] }, LATER),
        );
        throw new Error('rollback-trigger');
      }),
    ).rejects.toThrow('rollback-trigger');

    expect(await h.prisma.role.findUnique({ where: { id: roleId } })).toBeNull();
    expect(await h.prisma.rolePermission.findMany({ where: { roleId } })).toEqual([]);
  });
});
