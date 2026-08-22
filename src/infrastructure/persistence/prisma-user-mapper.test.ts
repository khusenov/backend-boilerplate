import { describe, expect, it } from 'vitest';
import { toDomain, toPersistence } from './prisma-user-mapper';
import type { User as UserRow } from '@/generated/prisma/client';

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2024-01-15T10:00:00.000Z');
  return {
    id: 'user-1',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    passwordHash: 'hashed-password',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('prisma-user-mapper', () => {
  describe('toDomain', () => {
    it('maps all scalar fields from the row', () => {
      const row = makeUserRow();
      const user = toDomain(row);

      expect(user.id).toBe('user-1');
      expect(user.firstName).toBe('John');
      expect(user.lastName).toBe('Doe');
      expect(user.email.toString()).toBe('john@example.com');
      expect(user.passwordHash).toBe('hashed-password');
      expect(user.status).toBe('active');
      expect(user.createdAt).toEqual(row.createdAt);
      expect(user.updatedAt).toEqual(row.updatedAt);
    });

    it('maps null deletedAt', () => {
      const user = toDomain(makeUserRow({ deletedAt: null }));
      expect(user.deletedAt).toBeNull();
    });

    it('maps a non-null deletedAt', () => {
      const deletedAt = new Date('2024-06-01T00:00:00.000Z');
      const user = toDomain(makeUserRow({ deletedAt }));
      expect(user.deletedAt).toEqual(deletedAt);
    });

    it('maps inactive status', () => {
      const user = toDomain(makeUserRow({ status: 'inactive' }));
      expect(user.status).toBe('inactive');
    });
  });

  describe('toPersistence', () => {
    it('serialises the Email value object to a plain string', () => {
      const user = toDomain(makeUserRow({ email: 'alice@example.com' }));
      const row = toPersistence(user);

      expect(row.email).toBe('alice@example.com');
    });

    it('round-trips losslessly through toDomain', () => {
      const row = makeUserRow();
      expect(toPersistence(toDomain(row))).toEqual(row);
    });

    it('round-trips with a non-null deletedAt', () => {
      const deletedAt = new Date('2024-06-01T00:00:00.000Z');
      const row = makeUserRow({ deletedAt });
      expect(toPersistence(toDomain(row))).toEqual(row);
    });
  });
});
