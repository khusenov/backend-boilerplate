import { toDomain, toPersistence } from './prisma-user-mapper';
import { mapPrismaError } from './prisma-error';
import { UNSAVED_VERSION } from '@/domain/shared/aggregate-root';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PageQuery, PageSlice } from '@/shared/pagination';
import type { User } from '@/domain/user/user-entity';
import type { Email } from '@/domain/user/email-vo';
import type { User as UserRow } from '@/generated/prisma/client';
import type { PrismaTransactionalClient } from './prisma-transactional-client';

const USER_AGGREGATE_NAME = 'User';

type MutableUserFields = Omit<UserRow, 'id' | 'createdAt'>;

interface PrismaUserRepositoryDeps {
  prisma: PrismaTransactionalClient;
}

export class PrismaUserRepository implements UserRepository {
  private readonly prisma: PrismaTransactionalClient;

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
    const { id, createdAt, ...current } = toPersistence(user);
    const expectedVersion = current.version;
    const next: MutableUserFields = { ...current, version: expectedVersion + 1 };

    if (expectedVersion === UNSAVED_VERSION) {
      await this.insert({ id, createdAt, ...next });
      return;
    }

    const updatedRows = await this.guardedUpdate(id, expectedVersion, next);
    if (updatedRows === 0) throw new StaleAggregateError(USER_AGGREGATE_NAME, id);
  }

  private async insert(row: UserRow): Promise<void> {
    try {
      await this.prisma.user.create({ data: row });
    } catch (error) {
      mapPrismaError(error);
    }
  }

  private async guardedUpdate(
    id: string,
    expectedVersion: number,
    data: MutableUserFields,
  ): Promise<number> {
    try {
      const { count } = await this.prisma.user.updateMany({
        where: { id, version: expectedVersion },
        data,
      });
      return count;
    } catch (error) {
      mapPrismaError(error);
    }
  }
}
