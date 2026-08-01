import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditRole } from './edit-role';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import {
  RoleNameTakenError,
  RoleNotFoundError,
  SystemRoleProtectedError,
  UnknownPermissionError,
} from '@/domain/authorization/role-errors';
import type { Clock } from '@/application/shared/ports/clock';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeEditRole() {
  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>().mockResolvedValue(null),
    save: vi.fn<RoleRepository['save']>().mockResolvedValue(undefined),
  } satisfies RoleRepository;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new EditRole({ roleRepository: roles, clock });

  return { sut, roles, clock };
}

describe('EditRole', () => {
  let ctx: ReturnType<typeof makeEditRole>;

  beforeEach(() => {
    ctx = makeEditRole();
  });

  it('throws RoleNotFoundError when the role does not exist', async () => {
    ctx.roles.findById.mockResolvedValue(null);

    await expect(ctx.sut.execute({ id: 'missing', name: 'X' })).rejects.toThrow(RoleNotFoundError);
  });

  it('rejects an unknown permission before mutating the role', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);

    await expect(ctx.sut.execute({ id: 'role-1', permissions: ['nope.invalid'] })).rejects.toThrow(
      UnknownPermissionError,
    );
    expect(ctx.roles.save).not.toHaveBeenCalled();
    expect(ctx.clock.now).not.toHaveBeenCalled();
  });

  it('rejects renaming onto a name held by a different active role', async () => {
    ctx.roles.findById.mockResolvedValue(Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT));
    ctx.roles.findByName.mockResolvedValue(
      Role.create({ id: 'role-2', name: 'Manager' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1', name: 'Manager' })).rejects.toThrow(
      RoleNameTakenError,
    );
  });

  it('allows renaming when the colliding row is the role itself', async () => {
    const role = Role.create({ id: 'role-1', name: 'Editor' }, CREATED_AT);
    ctx.roles.findById.mockResolvedValue(role);
    ctx.roles.findByName.mockResolvedValue(role);

    const result = await ctx.sut.execute({ id: 'role-1', name: 'Editor' });

    expect(result.name).toBe('Editor');
    expect(ctx.roles.save).toHaveBeenCalledOnce();
  });

  it('edits description and permissions without touching the name', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] }, CREATED_AT),
    );

    const result = await ctx.sut.execute({
      id: 'role-1',
      description: 'Leads content',
      permissions: ['roles.read'],
    });

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

    const result = await ctx.sut.execute({
      id: 'role-1',
      name: 'Manager',
      description: 'Leads',
      permissions: ['roles.read'],
    });

    expect(result.name).toBe('Manager');
    expect(result.description).toBe('Leads');
    expect(result.permissions).toEqual(['roles.read']);
    expect(ctx.roles.save).toHaveBeenCalledOnce();
  });

  it('stamps three mutations with one shared instant from a single clock reading', async () => {
    const role = Role.create(
      { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
      CREATED_AT,
    );
    ctx.roles.findById.mockResolvedValue(role);

    await ctx.sut.execute({
      id: 'role-1',
      name: 'Manager',
      description: 'Leads',
      permissions: ['roles.read'],
    });

    expect(role.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });

  it('surfaces the domain guard when editing a system role', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ id: 'role-1', name: 'X' })).rejects.toThrow(
      SystemRoleProtectedError,
    );
  });
});
