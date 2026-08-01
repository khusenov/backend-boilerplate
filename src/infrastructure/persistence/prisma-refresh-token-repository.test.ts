import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaRefreshTokenRepository } from './prisma-refresh-token-repository';
import type { PrismaClient, RefreshToken as RefreshTokenRow } from '@/generated/prisma/client';
import { ConflictError, NotFoundError } from '@/shared/errors';
import { RefreshToken } from '@/domain/auth/refresh-token-entity';

function makeTokenRow(overrides: Partial<RefreshTokenRow> = {}): RefreshTokenRow {
  const now = new Date('2024-01-15T10:00:00.000Z');
  return {
    id: 'token-1',
    userId: 'user-1',
    familyId: 'family-1',
    tokenHash: 'hash-abc',
    expiresAt: new Date('2024-02-15T10:00:00.000Z'),
    usedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePrismaError(code: string): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError('prisma error', { code, clientVersion: '6.0.0' });
}

function makeToken(): RefreshToken {
  return RefreshToken.create(
    {
      id: 'token-1',
      userId: 'user-1',
      familyId: 'family-1',
      tokenHash: 'hash-abc',
      expiresAt: new Date('2024-02-15T10:00:00.000Z'),
    },
    new Date('2024-01-15T10:00:00.000Z'),
  );
}

function makeRepo() {
  const tokenDelegate = {
    create: vi.fn().mockResolvedValue(undefined),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };

  const prisma = {
    refreshToken: tokenDelegate,
  } as unknown as PrismaClient;

  const repo = new PrismaRefreshTokenRepository({ prisma });
  return { repo, tokenDelegate };
}

describe('PrismaRefreshTokenRepository', () => {
  let ctx: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    ctx = makeRepo();
  });

  describe('create', () => {
    it('persists the token via refreshToken.create', async () => {
      await ctx.repo.create(makeToken());

      expect(ctx.tokenDelegate.create).toHaveBeenCalledOnce();
    });

    it('throws ConflictError on unique constraint violation (P2002)', async () => {
      ctx.tokenDelegate.create.mockRejectedValue(makePrismaError('P2002'));

      await expect(ctx.repo.create(makeToken())).rejects.toThrow(ConflictError);
    });
  });

  describe('findByTokenHash', () => {
    it('returns a mapped RefreshToken when found', async () => {
      ctx.tokenDelegate.findUnique.mockResolvedValue(makeTokenRow());

      const result = await ctx.repo.findByTokenHash('hash-abc');

      expect(result).not.toBeNull();
      expect(result!.tokenHash).toBe('hash-abc');
      expect(result!.userId).toBe('user-1');
      expect(result!.familyId).toBe('family-1');
    });

    it('returns null when not found', async () => {
      ctx.tokenDelegate.findUnique.mockResolvedValue(null);

      const result = await ctx.repo.findByTokenHash('unknown-hash');

      expect(result).toBeNull();
    });

    it('queries by tokenHash', async () => {
      ctx.tokenDelegate.findUnique.mockResolvedValue(null);

      await ctx.repo.findByTokenHash('hash-abc');

      expect(ctx.tokenDelegate.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: 'hash-abc' },
      });
    });
  });

  describe('update', () => {
    it('updates the token record by id', async () => {
      await ctx.repo.update(makeToken());

      expect(ctx.tokenDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'token-1' } }),
      );
    });

    it('throws NotFoundError when record does not exist (P2025)', async () => {
      ctx.tokenDelegate.update.mockRejectedValue(makePrismaError('P2025'));

      await expect(ctx.repo.update(makeToken())).rejects.toThrow(NotFoundError);
    });
  });

  describe('revokeFamily', () => {
    it('marks all active tokens in a family as revoked', async () => {
      const revokedAt = new Date('2024-06-01T00:00:00.000Z');

      await ctx.repo.revokeFamily('family-1', revokedAt);

      expect(ctx.tokenDelegate.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: { revokedAt, updatedAt: revokedAt },
      });
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes all active tokens for a user', async () => {
      const revokedAt = new Date('2024-06-01T00:00:00.000Z');

      await ctx.repo.revokeAllForUser('user-1', revokedAt);

      expect(ctx.tokenDelegate.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt, updatedAt: revokedAt },
      });
    });
  });

  describe('deleteExpired', () => {
    it('deletes tokens whose expiresAt is before the given date', async () => {
      const cutoff = new Date('2024-06-01T00:00:00.000Z');
      ctx.tokenDelegate.deleteMany.mockResolvedValue({ count: 3 });

      const count = await ctx.repo.deleteExpired(cutoff);

      expect(ctx.tokenDelegate.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: cutoff } },
      });
      expect(count).toBe(3);
    });

    it('returns zero when no expired tokens exist', async () => {
      ctx.tokenDelegate.deleteMany.mockResolvedValue({ count: 0 });

      const count = await ctx.repo.deleteExpired(new Date());

      expect(count).toBe(0);
    });
  });
});
