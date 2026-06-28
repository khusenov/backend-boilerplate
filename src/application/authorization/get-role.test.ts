import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetRole } from './get-role';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import { RoleNotFoundError } from '@/domain/authorization/role-errors';

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

    await expect(ctx.sut.execute({ id: 'missing' })).rejects.toThrow(RoleNotFoundError);
  });

  it('returns the mapped role DTO', async () => {
    ctx.roles.findById.mockResolvedValue(
      Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] }),
    );

    const result = await ctx.sut.execute({ id: 'role-1' });

    expect(result).toMatchObject({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });
  });
});
