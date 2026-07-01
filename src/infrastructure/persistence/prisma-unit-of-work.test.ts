import type { PrismaClient } from '@/generated/prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

describe('PrismaUnitOfWork', () => {
  function makePrisma() {
    return {
      $transaction: vi
        .fn()
        .mockImplementation((work: (tx: object) => Promise<unknown>) => work({})),
    } as unknown as PrismaClient;
  }

  it('executes work inside a Prisma transaction', async () => {
    const prisma = makePrisma();
    const sut = new PrismaUnitOfWork({ prisma });

    const result = await sut.run((repos) => {
      expect(repos.userRepository).toBeDefined();
      expect(repos.roleRepository).toBeDefined();
      expect(repos.permissionRepository).toBeDefined();
      expect(repos.userRoleRepository).toBeDefined();
      return Promise.resolve('ok' as const);
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(result).toBe('ok');
  });

  it('propagates errors so Prisma rolls back the transaction', async () => {
    const prisma = makePrisma();
    const sut = new PrismaUnitOfWork({ prisma });

    await expect(sut.run(() => Promise.reject(new Error('rollback-trigger')))).rejects.toThrow(
      'rollback-trigger',
    );
  });
});
