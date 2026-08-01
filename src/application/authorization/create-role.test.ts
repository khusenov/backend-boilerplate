import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRole } from './create-role';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Clock } from '@/application/shared/ports/clock';
import { RoleNameTakenError, UnknownPermissionError } from '@/domain/authorization/role-errors';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeCreateRole() {
  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>().mockResolvedValue(null),
    save: vi.fn<RoleRepository['save']>().mockResolvedValue(undefined),
  } satisfies RoleRepository;

  const ids = {
    generate: vi.fn<IdGenerator['generate']>().mockReturnValue('new-role-id'),
  } satisfies IdGenerator;

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new CreateRole({ roleRepository: roles, idGenerator: ids, clock });

  return { sut, roles, ids, clock };
}

describe('CreateRole', () => {
  let ctx: ReturnType<typeof makeCreateRole>;

  beforeEach(() => {
    ctx = makeCreateRole();
  });

  it('rejects a permission key that is not in the catalogue', async () => {
    await expect(
      ctx.sut.execute({ name: 'Editor', permissions: ['users.read', 'users.reed'] }),
    ).rejects.toThrow(UnknownPermissionError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });

  it('rejects a name already held by an active role', async () => {
    ctx.roles.findByName.mockResolvedValue(
      Role.create({ id: 'other', name: 'Editor' }, CREATED_AT),
    );

    await expect(ctx.sut.execute({ name: 'Editor' })).rejects.toThrow(RoleNameTakenError);
    expect(ctx.roles.save).not.toHaveBeenCalled();
  });

  it('checks uniqueness against the trimmed/normalised name', async () => {
    await ctx.sut.execute({ name: '  Editor  ' });

    expect(ctx.roles.findByName).toHaveBeenCalledWith('Editor');
  });

  it('persists a new role and returns its DTO', async () => {
    const result = await ctx.sut.execute({
      name: 'Editor',
      description: 'Content team',
      permissions: ['users.read', 'users.update'],
    });

    expect(ctx.ids.generate).toHaveBeenCalledOnce();
    expect(ctx.roles.save).toHaveBeenCalledOnce();
    expect(result.id).toBe('new-role-id');
    expect(result.name).toBe('Editor');
    expect(result.key).toBeNull();
    expect(result.isSystem).toBe(false);
    expect([...result.permissions].sort()).toEqual(['users.read', 'users.update']);
  });

  it('stamps the new role from a single clock reading', async () => {
    await ctx.sut.execute({ name: 'Editor' });

    const [savedRole] = ctx.roles.save.mock.calls[0]!;
    expect(savedRole.createdAt).toEqual(NOW);
    expect(savedRole.updatedAt).toEqual(NOW);
    expect(ctx.clock.now).toHaveBeenCalledOnce();
  });
});
