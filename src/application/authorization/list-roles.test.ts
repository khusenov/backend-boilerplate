import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListRoles } from './list-roles';
import { Role } from '@/domain/authorization/role-entity';
import type { RoleRepository } from '@/domain/authorization/role-repository';

function makeListRoles() {
  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>(),
    findByName: vi.fn<RoleRepository['findByName']>(),
    save: vi.fn<RoleRepository['save']>(),
  } satisfies RoleRepository;

  const sut = new ListRoles({ roleRepository: roles });

  return { sut, roles };
}

describe('ListRoles', () => {
  let ctx: ReturnType<typeof makeListRoles>;

  beforeEach(() => {
    ctx = makeListRoles();
  });

  it('normalises the page query and maps the slice to a DTO page', async () => {
    ctx.roles.list.mockResolvedValue({
      items: [Role.create({ id: 'role-1', name: 'Editor' })],
      total: 1,
    });

    const result = await ctx.sut.execute({});

    expect(ctx.roles.list).toHaveBeenCalledWith({ page: 1, pageSize: 10 });
    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      hasNext: false,
      hasPrev: false,
    });
    expect(result.items[0]).toMatchObject({ id: 'role-1', name: 'Editor' });
  });

  it('clamps an oversized pageSize to the maximum', async () => {
    ctx.roles.list.mockResolvedValue({ items: [], total: 0 });

    await ctx.sut.execute({ page: 2, pageSize: 9999 });

    expect(ctx.roles.list).toHaveBeenCalledWith({ page: 2, pageSize: 100 });
  });
});
