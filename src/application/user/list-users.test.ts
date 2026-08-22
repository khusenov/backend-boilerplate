import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListUsers } from './list-users';
import type { UserRepository } from '@/domain/user/user-repository';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import { makeUser } from '@test/unit/support/builders';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.UsersRead.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

function makeListUsers() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const sut = new ListUsers({ userRepository: users });

  return { sut, users };
}

describe('ListUsers', () => {
  let ctx: ReturnType<typeof makeListUsers>;

  beforeEach(() => {
    ctx = makeListUsers();
  });

  describe('execute', () => {
    it('returns a page with mapped UserDtos', async () => {
      ctx.users.list.mockResolvedValue({
        items: [
          makeUser({ id: 'u-1', email: 'u-1@example.com' }),
          makeUser({ id: 'u-2', email: 'u-2@example.com' }),
        ],
        total: 2,
      });

      const result = await ctx.sut.execute({}, ACTOR);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.id).toBe('u-1');
      expect(result.items[1]!.id).toBe('u-2');
      expect(result.total).toBe(2);
    });

    it('uses page=1 and pageSize=10 as defaults when not provided', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({}, ACTOR);

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.page).toBe(1);
      expect(query.pageSize).toBe(10);
    });

    it('passes the provided page and pageSize to the repository', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({ page: 3, pageSize: 25 }, ACTOR);

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.page).toBe(3);
      expect(query.pageSize).toBe(25);
    });

    it('caps pageSize to 100', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({ pageSize: 999 }, ACTOR);

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.pageSize).toBe(100);
    });

    it('sets hasNext when there is a subsequent page', async () => {
      ctx.users.list.mockResolvedValue({
        items: [makeUser({ id: 'u-1', email: 'u-1@example.com' })],
        total: 20,
      });

      const result = await ctx.sut.execute({ page: 1, pageSize: 10 }, ACTOR);

      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    it('sets hasPrev when not on the first page', async () => {
      ctx.users.list.mockResolvedValue({
        items: [makeUser({ id: 'u-1', email: 'u-1@example.com' })],
        total: 20,
      });

      const result = await ctx.sut.execute({ page: 2, pageSize: 10 }, ACTOR);

      expect(result.hasPrev).toBe(true);
    });
  });
});

describe('ListUsers authorization', () => {
  it('denies a caller without users.read before touching the repository', async () => {
    const ctx = makeListUsers();

    await expect(ctx.sut.execute({}, UNPRIVILEGED_ACTOR)).rejects.toThrow(PermissionDeniedError);

    expect(ctx.users.list).not.toHaveBeenCalled();
  });
});
