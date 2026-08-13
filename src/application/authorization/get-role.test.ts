import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetRole } from './get-role';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesRead.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

function makeGetRole() {
  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>(),
    save: vi.fn<RoleRepository['save']>(),
  } satisfies RoleRepository;

  const sut = new GetRole({ roleRepository: roles });

  return { sut, roles };
}

describe('GetRole', () => {
  let ctx: ReturnType<typeof makeGetRole>;

  beforeEach(() => {
    ctx = makeGetRole();
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ id: 'missing' }, ACTOR)).rejects.toThrow(RoleNotFoundError);
  });

  it('returns the mapped role DTO', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.create(
        { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    );

    const result = await ctx.sut.execute({ id: 'role-1' }, ACTOR);

    expect(result).toMatchObject({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });
  });
});

describe('GetRole authorization', () => {
  it('denies a caller without roles.read before touching the repository', async () => {
    const ctx = makeGetRole();

    await expect(ctx.sut.execute({ id: 'role-1' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.roles.findById).not.toHaveBeenCalled();
  });
});
