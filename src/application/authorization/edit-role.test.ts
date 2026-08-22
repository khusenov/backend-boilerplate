import { beforeEach, describe, expect, it } from 'vitest';
import { EditRole } from './edit-role';
import { Role } from '@/domain/authorization/role-entity';
import {
  RoleNameTakenError,
  RoleNotFoundError,
  SystemRoleProtectedError,
  UnknownPermissionError,
} from '@/domain/authorization/role-errors';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesUpdate.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeEditRole() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.roleRepository.findByName.mockResolvedValue(null);
  context.roleRepository.save.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);

  const sut = new EditRole({ unitOfWork, clock });

  return { sut, unitOfWork, roles: context.roleRepository, clock };
}

describe('EditRole', () => {
  let ctx: ReturnType<typeof makeEditRole>;

  beforeEach(() => {
    ctx = makeEditRole();
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ id: 'missing', name: 'X' }, ACTOR)).rejects.toThrow(
      RoleNotFoundError,
    );
  });

  it('rejects an unknown permission before mutating the role', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await expect(
      ctx.sut.execute({ id: 'role-1', permissions: ['nope.invalid'] }, ACTOR),
    ).rejects.toThrow(UnknownPermissionError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
    expect(ctx.clock.now).not.toHaveBeenCalled();
  });

  it('rejects an unknown permission key without opening a transaction', async () => {
    await expect(
      ctx.sut.execute({ id: 'role-1', permissions: ['nope.invalid'] }, ACTOR),
    ).rejects.toThrow(UnknownPermissionError);
    expect(ctx.unitOfWork.run).not.toHaveBeenCalled();
  });

  it('validates permissions before looking the role up', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(
      ctx.sut.execute({ id: 'missing', permissions: ['nope.invalid'] }, ACTOR),
    ).rejects.toThrow(UnknownPermissionError);
  });

  it('rejects renaming onto a name held by a different active role', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));
    ctx.roles.findByName.mockResolvedValue(
      Role.create({ id: 'role-2', name: 'Manager' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1', name: 'Manager' }, ACTOR)).rejects.toThrow(
      RoleNameTakenError,
    );
  });

  it('allows renaming when the colliding row is the role itself', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);
    ctx.roles.findByName.mockResolvedValue(role);

    const result = await ctx.sut.execute({ id: 'role-1', name: 'Editor' }, ACTOR);

    expect(result.name).toBe('Editor');
    expect(ctx.roles.save).toHaveBeenCalledOnce();
  });

  it('edits description and permissions without touching the name', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] }, CREATED_AT),
    );

    const result = await ctx.sut.execute(
      {
        id: 'role-1',
        description: 'Leads content',
        permissions: ['roles.read'],
      },
      ACTOR,
    );

    expect(result.name).toBe('Editor');
    expect(result.description).toBe('Leads content');
    expect(result.permissions).toEqual(['roles.read']);
    expect(ctx.roles.findByName).not.toHaveBeenCalled();
    expect(ctx.roles.save).toHaveBeenCalledOnce();
  });

  it('applies rename, description, and permissions then persists', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] }, CREATED_AT),
    );

    const result = await ctx.sut.execute(
      {
        id: 'role-1',
        name: 'Manager',
        description: 'Leads',
        permissions: ['roles.read'],
      },
      ACTOR,
    );

    expect(result.name).toBe('Manager');
    expect(result.description).toBe('Leads');
    expect(result.permissions).toEqual(['roles.read']);
    expect(ctx.roles.save).toHaveBeenCalledOnce();
  });

  it('loads, mutates and persists inside one transaction', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));

    await ctx.sut.execute({ id: 'role-1', description: 'Leads' }, ACTOR);

    expect(ctx.unitOfWork.run).toHaveBeenCalledOnce();
  });

  it('propagates a stale-aggregate conflict from the repository', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));
    ctx.roles.save.mockRejectedValue(new StaleAggregateError('Role', 'role-1'));

    await expect(ctx.sut.execute({ id: 'role-1', description: 'Leads' }, ACTOR)).rejects.toThrow(
      StaleAggregateError,
    );
  });

  it('stamps three mutations with one shared instant from a single clock reading', async () => {
    const role = Role.create(
      { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
      CREATED_AT,
    );
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute(
      {
        id: 'role-1',
        name: 'Manager',
        description: 'Leads',
        permissions: ['roles.read'],
      },
      ACTOR,
    );

    expect(role.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });

  it('surfaces the domain guard when editing a system role', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1', name: 'X' }, ACTOR)).rejects.toThrow(
      SystemRoleProtectedError,
    );
  });
});

describe('EditRole authorization', () => {
  it('denies a caller without roles.update before touching the repository', async () => {
    const ctx = makeEditRole();

    await expect(
      ctx.sut.execute({ id: 'role-1', name: 'auditor' }, UNPRIVILEGED_ACTOR),
    ).rejects.toThrow(PermissionDeniedError);

    expect(ctx.roles.findById).not.toHaveBeenCalled();
  });

  it('denies an unauthorized caller without opening a transaction', async () => {
    const ctx = makeEditRole();

    await expect(
      ctx.sut.execute({ id: 'role-1', name: 'auditor' }, UNPRIVILEGED_ACTOR),
    ).rejects.toThrow(PermissionDeniedError);

    expect(ctx.unitOfWork.run).not.toHaveBeenCalled();
  });
});
