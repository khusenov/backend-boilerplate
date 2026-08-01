import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteRole } from './delete-role';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { RoleNotFoundError, SystemRoleProtectedError } from '@/domain/authorization/role-errors';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeDeleteRole() {
  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>(),
    save: vi.fn<RoleRepository['save']>().mockResolvedValue(undefined),
  } satisfies RoleRepository;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new DeleteRole({ roleRepository: roles, clock });

  return { sut, roles, clock };
}

describe('DeleteRole', () => {
  let ctx: ReturnType<typeof makeDeleteRole>;

  beforeEach(() => {
    ctx = makeDeleteRole();
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ id: 'missing' })).rejects.toThrow(RoleNotFoundError);
  });

  it('soft-deletes an admin role and persists it', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute({ id: 'role-1' });

    expect(role.isDeleted).toBe(true);
    expect(ctx.roles.save).toHaveBeenCalledWith(role);
  });

  it('stamps deletedAt and updatedAt from a single clock reading', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute({ id: 'role-1' });

    expect(role.deletedAt).toEqual(NOW);
    expect(role.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });

  it('refuses to delete a system role', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1' })).rejects.toThrow(SystemRoleProtectedError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });
});
