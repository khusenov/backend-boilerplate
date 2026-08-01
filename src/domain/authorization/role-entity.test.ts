import { describe, expect, it } from 'vitest';
import { Role } from './role-entity';
import { RoleDeletedError, RoleNameRequiredError, SystemRoleProtectedError } from './role-errors';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:00:01.000Z');

describe('Role', () => {
  describe('create', () => {
    it('creates an admin role with no key, not a system role', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      expect(role.id).toBe('role-1');
      expect(role.key).toBeNull();
      expect(role.name).toBe('Editor');
      expect(role.isSystem).toBe(false);
      expect(role.permissions).toEqual([]);
      expect(role.createdAt).toEqual(BASE_TIME);
      expect(role.updatedAt).toEqual(BASE_TIME);
      expect(role.isDeleted).toBe(false);
    });

    it('trims the name and normalises empty description to null', () => {
      const role = Role.create({ id: 'role-1', name: '  Editor  ', description: '   ' }, BASE_TIME);

      expect(role.name).toBe('Editor');
      expect(role.description).toBeNull();
    });

    it('deduplicates the initial permission set', () => {
      const role = Role.create(
        {
          id: 'role-1',
          name: 'Editor',
          permissions: ['users.read', 'users.read', 'users.update'],
        },
        BASE_TIME,
      );

      expect([...role.permissions].sort()).toEqual(['users.read', 'users.update']);
    });

    it('throws RoleNameRequiredError for a blank name', () => {
      expect(() => Role.create({ id: 'role-1', name: '   ' }, BASE_TIME)).toThrow(
        RoleNameRequiredError,
      );
    });
  });

  describe('createSystem', () => {
    it('creates a protected role carrying the given key', () => {
      const role = Role.createSystem(
        { id: 'role-1', key: 'super-admin', name: 'Super Admin' },
        BASE_TIME,
      );

      expect(role.key).toBe('super-admin');
      expect(role.isSystem).toBe(true);
      expect(role.createdAt).toEqual(BASE_TIME);
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });

  describe('permissions getter', () => {
    it('returns a copy, so external mutation cannot corrupt the aggregate', () => {
      const role = Role.create(
        { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
        BASE_TIME,
      );

      role.permissions.push('users.delete');

      expect(role.permissions).toEqual(['users.read']);
    });
  });

  describe('rename', () => {
    it('updates the name and sets updatedAt to the supplied instant', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      role.rename('Manager', LATER);

      expect(role.name).toBe('Manager');
      expect(role.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the name is unchanged', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      role.rename('Editor', LATER);

      expect(role.updatedAt).toEqual(BASE_TIME);
    });

    it('throws RoleNameRequiredError for a blank name', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);
      expect(() => role.rename('  ', LATER)).toThrow(RoleNameRequiredError);
    });
  });

  describe('changeDescription', () => {
    it('sets and clears the description', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      role.changeDescription('Handles content', LATER);
      expect(role.description).toBe('Handles content');

      role.changeDescription(null, LATER);
      expect(role.description).toBeNull();
    });

    it('is a no-op when the normalised description is unchanged', () => {
      const role = Role.create(
        { id: 'role-1', name: 'Editor', description: 'Handles content' },
        BASE_TIME,
      );

      role.changeDescription('  Handles content  ', LATER);

      expect(role.description).toBe('Handles content');
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });

  describe('grant / revoke', () => {
    it('grants a permission once (idempotent) and sets updatedAt to the supplied instant', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      role.grant('users.read', LATER);
      role.grant('users.read', LATER);

      expect(role.permissions).toEqual(['users.read']);
      expect(role.updatedAt).toEqual(LATER);
    });

    it('does not touch the role when granting an already-held permission', () => {
      const role = Role.create(
        { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
        BASE_TIME,
      );

      role.grant('users.read', LATER);

      expect(role.updatedAt).toEqual(BASE_TIME);
    });

    it('revokes a permission and is a no-op when absent', () => {
      const role = Role.create(
        { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
        BASE_TIME,
      );

      role.revoke('users.read', BASE_TIME);
      expect(role.permissions).toEqual([]);

      role.revoke('users.read', LATER);
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });

  describe('setPermissions / hasPermission', () => {
    it('replaces the whole permission set', () => {
      const role = Role.create(
        { id: 'role-1', name: 'Editor', permissions: ['users.read'] },
        BASE_TIME,
      );

      role.setPermissions(['roles.read', 'roles.update'], LATER);

      expect([...role.permissions].sort()).toEqual(['roles.read', 'roles.update']);
      expect(role.hasPermission('users.read')).toBe(false);
      expect(role.hasPermission('roles.read')).toBe(true);
    });
  });

  describe('system-role protection', () => {
    it('blocks rename / grant / revoke / setPermissions on a system role', () => {
      const role = Role.createSystem(
        { id: 'role-1', key: 'super-admin', name: 'Super Admin' },
        BASE_TIME,
      );

      expect(() => role.rename('x', LATER)).toThrow(SystemRoleProtectedError);
      expect(() => role.changeDescription('x', LATER)).toThrow(SystemRoleProtectedError);
      expect(() => role.grant('users.read', LATER)).toThrow(SystemRoleProtectedError);
      expect(() => role.revoke('users.read', LATER)).toThrow(SystemRoleProtectedError);
      expect(() => role.setPermissions([], LATER)).toThrow(SystemRoleProtectedError);
    });

    it('blocks soft-deleting a system role', () => {
      const role = Role.createSystem(
        { id: 'role-1', key: 'super-admin', name: 'Super Admin' },
        BASE_TIME,
      );
      expect(() => role.softDelete(LATER)).toThrow(SystemRoleProtectedError);
      expect(role.isDeleted).toBe(false);
    });
  });

  describe('deleted-role protection', () => {
    it('soft-deletes an admin role and blocks further mutation', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' }, BASE_TIME);

      role.softDelete(LATER);
      expect(role.isDeleted).toBe(true);
      expect(role.deletedAt).toEqual(LATER);

      expect(() => role.rename('x', LATER)).toThrow(RoleDeletedError);
      expect(() => role.grant('users.read', LATER)).toThrow(RoleDeletedError);
    });
  });

  describe('hydrate', () => {
    it('reconstructs a role from stored props without side effects', () => {
      const role = Role.hydrate({
        id: 'role-1',
        key: null,
        name: 'Editor',
        description: 'desc',
        isSystem: false,
        permissions: new Set(['users.read']),
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        deletedAt: null,
      });

      expect(role.name).toBe('Editor');
      expect(role.permissions).toEqual(['users.read']);
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });
});
