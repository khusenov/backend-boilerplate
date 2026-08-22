import { describe, expect, it } from 'vitest';
import { toDomain, toPersistence } from './prisma-role-mapper';
import type { Role as RoleRow } from '@/generated/prisma/client';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-02-01T00:00:00.000Z');
const DELETED_AT = new Date('2026-03-01T00:00:00.000Z');

function makeRoleRow(overrides: Partial<RoleRow> = {}): RoleRow {
  return {
    id: 'role-1',
    key: null,
    name: 'Editor',
    description: 'Content team',
    isSystem: false,
    version: 4,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

function withPermissions(row: RoleRow, keys: string[]) {
  return { ...row, permissions: keys.map((key) => ({ permission: { key } })) };
}

describe('prisma role mapper', () => {
  describe('toDomain', () => {
    it('carries the stored version onto the aggregate', () => {
      expect(toDomain(withPermissions(makeRoleRow({ version: 9 }), [])).version).toBe(9);
    });

    it('flattens the nested permission join rows into keys', () => {
      const role = toDomain(withPermissions(makeRoleRow(), ['users.read', 'roles.read']));

      expect([...role.permissions].sort()).toEqual(['roles.read', 'users.read']);
    });

    it('maps a role with no permission rows to an empty set', () => {
      expect(toDomain(withPermissions(makeRoleRow(), [])).permissions).toEqual([]);
    });

    it('preserves the system key and flag', () => {
      const role = toDomain(
        withPermissions(makeRoleRow({ key: 'super-admin', isSystem: true }), []),
      );

      expect(role.key).toBe('super-admin');
      expect(role.isSystem).toBe(true);
    });

    it('preserves a soft-deleted timestamp', () => {
      expect(
        toDomain(withPermissions(makeRoleRow({ deletedAt: DELETED_AT }), [])).deletedAt,
      ).toEqual(DELETED_AT);
    });
  });

  describe('toPersistence', () => {
    it('carries the version back onto the row', () => {
      expect(
        toPersistence(toDomain(withPermissions(makeRoleRow({ version: 9 }), []))).version,
      ).toBe(9);
    });

    it('round-trips every scalar column', () => {
      const row = makeRoleRow({
        key: 'super-admin',
        isSystem: true,
        description: null,
        deletedAt: DELETED_AT,
        version: 6,
      });

      expect(toPersistence(toDomain(withPermissions(row, ['users.read'])))).toEqual(row);
    });
  });
});
