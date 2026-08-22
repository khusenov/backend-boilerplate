import { beforeEach, describe, expect, it } from 'vitest';
import { DeleteRole } from './delete-role';
import { Role } from '@/domain/authorization/role-entity';
import { RoleNotFoundError, SystemRoleProtectedError } from '@/domain/authorization/role-errors';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.RolesDelete.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeDeleteRole() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.roleRepository.save.mockResolvedValue(undefined);

  const clock = makeFixedClock(NOW);

  const sut = new DeleteRole({ unitOfWork, clock });

  return { sut, unitOfWork, roles: context.roleRepository, clock };
}

describe('DeleteRole', () => {
  let ctx: ReturnType<typeof makeDeleteRole>;

  beforeEach(() => {
    ctx = makeDeleteRole();
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ id: 'missing' }, ACTOR)).rejects.toThrow(RoleNotFoundError);
  });

  it('soft-deletes an admin role and persists it', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute({ id: 'role-1' }, ACTOR);

    expect(role.isDeleted).toBe(true);
    expect(ctx.roles.save).toHaveBeenCalledWith(role);
  });

  it('loads and persists inside one transaction', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));

    await ctx.sut.execute({ id: 'role-1' }, ACTOR);

    expect(ctx.unitOfWork.run).toHaveBeenCalledOnce();
  });

  it('propagates a stale-aggregate conflict from the repository', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));
    ctx.roles.save.mockRejectedValue(new StaleAggregateError('Role', 'role-1'));

    await expect(ctx.sut.execute({ id: 'role-1' }, ACTOR)).rejects.toThrow(StaleAggregateError);
  });

  it('stamps deletedAt and updatedAt from a single clock reading', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute({ id: 'role-1' }, ACTOR);

    expect(role.deletedAt).toEqual(NOW);
    expect(role.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });

  it('refuses to delete a system role', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1' }, ACTOR)).rejects.toThrow(
      SystemRoleProtectedError,
    );
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });
});

describe('DeleteRole authorization', () => {
  it('denies a caller without roles.delete before touching the repository', async () => {
    const ctx = makeDeleteRole();

    await expect(ctx.sut.execute({ id: 'role-1' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.roles.findById).not.toHaveBeenCalled();
  });

  it('denies an unauthorized caller without opening a transaction', async () => {
    const ctx = makeDeleteRole();

    await expect(ctx.sut.execute({ id: 'role-1' }, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.unitOfWork.run).not.toHaveBeenCalled();
  });
});
