import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaUserRepository } from './prisma-user-repository';
import type { PrismaClient, User as UserRow } from '@/generated/prisma/client';
import { ConflictError } from '@/shared/errors';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2024-01-15T10:00:00.000Z');
  return {
    id: 'user-1',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    passwordHash: 'hashed-pw',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrismaError(code: string): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError('prisma error', { code, clientVersion: '6.0.0' });
}

function makeUser(): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'John',
      lastName: 'Doe',
      email: Email.create('john@example.com'),
      passwordHash: 'hashed-pw',
    },
    new Date('2024-01-15T10:00:00.000Z'),
  );
}

function makeRepo() {
  const userDelegate = {
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi
      .fn<
        (args: { create: UserRow; update: Omit<UserRow, 'id' | 'createdAt'> }) => Promise<unknown>
      >()
      .mockResolvedValue(undefined),
  };

  const prisma = {
    $transaction: vi.fn(),
    user: userDelegate,
  } as unknown as PrismaClient;

  const repo = new PrismaUserRepository({ prisma });
  return { repo, prisma, userDelegate };
}

describe('PrismaUserRepository', () => {
  let ctx: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    ctx = makeRepo();
  });

  describe('list', () => {
    it('returns mapped domain items and total', async () => {
      (ctx.prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([[makeUserRow()], 1]);

      const result = await ctx.repo.list({ page: 1, pageSize: 10 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toBe('user-1');
    });

    it('returns empty items and zero total when no records exist', async () => {
      (ctx.prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([[], 0]);

      const result = await ctx.repo.list({ page: 1, pageSize: 10 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('calculates correct skip for page 2', async () => {
      (ctx.prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([[], 0]);
      ctx.userDelegate.findMany.mockResolvedValue([]);
      ctx.userDelegate.count.mockResolvedValue(0);

      await ctx.repo.list({ page: 2, pageSize: 5 });

      expect(ctx.userDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('only fetches non-deleted records', async () => {
      (ctx.prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([[], 0]);
      ctx.userDelegate.findMany.mockResolvedValue([]);
      ctx.userDelegate.count.mockResolvedValue(0);

      await ctx.repo.list({ page: 1, pageSize: 10 });

      expect(ctx.userDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
      expect(ctx.userDelegate.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    });
  });

  describe('findById', () => {
    it('returns a mapped User when found', async () => {
      ctx.userDelegate.findFirst.mockResolvedValue(makeUserRow());

      const result = await ctx.repo.findById('user-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('user-1');
      expect(result!.email.toString()).toBe('john@example.com');
    });

    it('returns null when not found', async () => {
      ctx.userDelegate.findFirst.mockResolvedValue(null);

      const result = await ctx.repo.findById('missing');

      expect(result).toBeNull();
    });

    it('queries with id and deletedAt: null', async () => {
      ctx.userDelegate.findFirst.mockResolvedValue(null);

      await ctx.repo.findById('user-1');

      expect(ctx.userDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'user-1', deletedAt: null },
      });
    });
  });

  describe('findByEmail', () => {
    it('returns a mapped User when found', async () => {
      ctx.userDelegate.findUnique.mockResolvedValue(makeUserRow({ email: 'alice@example.com' }));

      const result = await ctx.repo.findByEmail(Email.create('alice@example.com'));

      expect(result).not.toBeNull();
      expect(result!.email.toString()).toBe('alice@example.com');
    });

    it('returns null when not found', async () => {
      ctx.userDelegate.findUnique.mockResolvedValue(null);

      const result = await ctx.repo.findByEmail(Email.create('missing@example.com'));

      expect(result).toBeNull();
    });

    it('queries by email string', async () => {
      ctx.userDelegate.findUnique.mockResolvedValue(null);

      await ctx.repo.findByEmail(Email.create('alice@example.com'));

      expect(ctx.userDelegate.findUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.com' },
      });
    });
  });

  describe('save', () => {
    it('upserts the user keyed on id', async () => {
      await ctx.repo.save(makeUser());

      expect(ctx.userDelegate.upsert).toHaveBeenCalledOnce();
      expect(ctx.userDelegate.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' } }),
      );
    });

    it('writes immutable columns (id, createdAt) on insert but never on update', async () => {
      await ctx.repo.save(makeUser());

      const [args] = ctx.userDelegate.upsert.mock.calls[0]!;
      expect(args.create).toHaveProperty('id', 'user-1');
      expect(args.create).toHaveProperty('createdAt');
      expect(args.update).not.toHaveProperty('id');
      expect(args.update).not.toHaveProperty('createdAt');
    });

    it('translates a unique constraint violation (P2002) into ConflictError', async () => {
      ctx.userDelegate.upsert.mockRejectedValue(makePrismaError('P2002'));

      await expect(ctx.repo.save(makeUser())).rejects.toThrow(ConflictError);
    });
  });
});
