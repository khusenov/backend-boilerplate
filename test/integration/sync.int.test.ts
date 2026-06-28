import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { seedUser } from './support/factories';
import { SyncAuthorization } from '@/application/authorization/sync-authorization';
import { ALL_PERMISSIONS, SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';
import type { Env } from '@/config/env';

describe('SyncAuthorization (integration)', () => {
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

  function makeSync(bootstrapEmail = ''): SyncAuthorization {
    const c = h.app.diContainer.cradle;
    return new SyncAuthorization({
      permissionRepository: c.permissionRepository,
      roleRepository: c.roleRepository,
      userRepository: c.userRepository,
      userRoleRepository: c.userRoleRepository,
      idGenerator: c.idGenerator,
      env: { BOOTSTRAP_ADMIN_EMAIL: bootstrapEmail } as Env,
    });
  }

  it('mirrors the catalogue and seeds the superadmin role, idempotently', async () => {
    const sync = makeSync();

    const first = await sync.execute();
    expect(first.superadminCreated).toBe(true);
    expect(first.permissionsUpserted).toBe(ALL_PERMISSIONS.length);

    expect(await h.prisma.permission.count()).toBe(ALL_PERMISSIONS.length);
    const role = await h.prisma.role.findUnique({ where: { key: SUPERADMIN_ROLE_KEY } });
    expect(role?.isSystem).toBe(true);

    // Running again is a no-op: same permission count, superadmin not recreated.
    const second = await sync.execute();
    expect(second.superadminCreated).toBe(false);
    expect(await h.prisma.permission.count()).toBe(ALL_PERMISSIONS.length);
    expect(await h.prisma.role.count({ where: { key: SUPERADMIN_ROLE_KEY } })).toBe(1);
  });

  it('prunes a stored permission the catalogue no longer defines', async () => {
    await makeSync().execute();
    const now = new Date();
    await h.prisma.permission.create({
      data: { id: 'legacy-id', key: 'legacy.gone', name: 'Legacy', createdAt: now, updatedAt: now },
    });

    const result = await makeSync().execute();

    expect(result.permissionsRemoved).toEqual(['legacy.gone']);
    expect(await h.prisma.permission.findUnique({ where: { key: 'legacy.gone' } })).toBeNull();
  });

  it('promotes the bootstrap operator once they exist, then no-ops', async () => {
    const operator = await seedUser(h.app, { email: 'boot@finflow.test' });
    const sync = makeSync('boot@finflow.test');

    const first = await sync.execute();
    expect(first.bootstrapPromoted).toBe(true);

    const role = await h.prisma.role.findUnique({ where: { key: SUPERADMIN_ROLE_KEY } });
    const link = await h.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: operator.id, roleId: role!.id } },
    });
    expect(link).not.toBeNull();

    const second = await sync.execute();
    expect(second.bootstrapPromoted).toBe(false);
  });

  it('does not promote when the operator has not registered yet', async () => {
    const result = await makeSync('absent@finflow.test').execute();
    expect(result.bootstrapPromoted).toBe(false);
  });
});
