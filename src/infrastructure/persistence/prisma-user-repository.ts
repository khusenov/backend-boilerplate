import { toDomain, toPersistence } from './prisma-user-mapper';
import { mapPrismaError } from './prisma-error';
import type { PrismaClient } from '@/generated/prisma/client';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PageQuery, PageSlice } from '@/shared/pagination';
import type { User } from '@/domain/user/user-entity';
import type { Email } from '@/domain/user/email-vo';

interface PrismaUserRepositoryDeps {
  prisma: PrismaClient;
}

export class PrismaUserRepository implements UserRepository {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: PrismaUserRepositoryDeps) {
    this.prisma = prisma;
  }

  async list(query: PageQuery): Promise<PageSlice<User>> {
    const where = { deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(toDomain), total };
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    return row ? toDomain(row) : null;
  }

  async findByEmail(email: Email): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { email: email.toString() } });
    return row ? toDomain(row) : null;
  }

  async save(user: User): Promise<void> {
    // id and createdAt are immutable: written on insert, never on update.
    const { id, createdAt, ...mutable } = toPersistence(user);
    try {
      await this.prisma.user.upsert({
        where: { id },
        create: { id, createdAt, ...mutable },
        update: mutable,
      });
    } catch (error) {
      mapPrismaError(error);
    }
  }
}
