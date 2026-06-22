import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListUsers } from './list-users';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import type { UserRepository } from '@/domain/user/user-repository';

function makeUser(id: string): User {
  return User.create({
    id,
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create(`${id}@example.com`),
    passwordHash: 'hashed-pw',
  });
}

function makeListUsers() {
  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>(),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    create: vi.fn<UserRepository['create']>(),
    update: vi.fn<UserRepository['update']>(),
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
      ctx.users.list.mockResolvedValue({ items: [makeUser('u-1'), makeUser('u-2')], total: 2 });

      const result = await ctx.sut.execute({});

      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.id).toBe('u-1');
      expect(result.items[1]!.id).toBe('u-2');
      expect(result.total).toBe(2);
    });

    it('uses page=1 and pageSize=10 as defaults when not provided', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({});

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.page).toBe(1);
      expect(query.pageSize).toBe(10);
    });

    it('passes the provided page and pageSize to the repository', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({ page: 3, pageSize: 25 });

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.page).toBe(3);
      expect(query.pageSize).toBe(25);
    });

    it('caps pageSize to 100', async () => {
      ctx.users.list.mockResolvedValue({ items: [], total: 0 });

      await ctx.sut.execute({ pageSize: 999 });

      const [query] = ctx.users.list.mock.calls[0]!;
      expect(query.pageSize).toBe(100);
    });

    it('sets hasNext when there is a subsequent page', async () => {
      ctx.users.list.mockResolvedValue({ items: [makeUser('u-1')], total: 20 });

      const result = await ctx.sut.execute({ page: 1, pageSize: 10 });

      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    it('sets hasPrev when not on the first page', async () => {
      ctx.users.list.mockResolvedValue({ items: [makeUser('u-1')], total: 20 });

      const result = await ctx.sut.execute({ page: 2, pageSize: 10 });

      expect(result.hasPrev).toBe(true);
    });
  });
});
