import { User } from '@/domain/user/user-entity';
import { Email } from '@/domain/user/email-vo';
import type { User as UserRow } from '@/generated/prisma/client';

export function toDomain(row: UserRow): User {
  return User.hydrate({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: Email.create(row.email),
    passwordHash: row.passwordHash,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

export function toPersistence(user: User): UserRow {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email.toString(),
    passwordHash: user.passwordHash,
    status: user.status,
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    deletedAt: user.deletedAt,
  };
}
