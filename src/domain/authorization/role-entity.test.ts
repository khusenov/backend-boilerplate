import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from './role-entity';
import { RoleDeletedError, RoleNameRequiredError, SystemRoleProtectedError } from './role-errors';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z');

describe('Role', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('creates an admin role with no key, not a system role', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });

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
      const role = Role.create({ id: 'role-1', name: '  Editor  ', description: '   ' });

      expect(role.name).toBe('Editor');
      expect(role.description).toBeNull();
    });

    it('deduplicates the initial permission set', () => {
      const role = Role.create({
        id: 'role-1',
        name: 'Editor',
        permissions: ['users.read', 'users.read', 'users.update'],
      });

      expect([...role.permissions].sort()).toEqual(['users.read', 'users.update']);
    });

    it('throws RoleNameRequiredError for a blank name', () => {
      expect(() => Role.create({ id: 'role-1', name: '   ' })).toThrow(RoleNameRequiredError);
    });
  });

  describe('createSystem', () => {
    it('creates a protected role carrying the given key', () => {
      const role = Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' });

      expect(role.key).toBe('super-admin');
      expect(role.isSystem).toBe(true);
    });
  });

  describe('permissions getter', () => {
    it('returns a copy, so external mutation cannot corrupt the aggregate', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });

      role.permissions.push('users.delete');

      expect(role.permissions).toEqual(['users.read']);
    });
  });

  describe('rename', () => {
    it('updates the name and bumps updatedAt', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });
      vi.advanceTimersByTime(1000);

      role.rename('Manager');

      expect(role.name).toBe('Manager');
      expect(role.updatedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    });

    it('is a no-op when the name is unchanged', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });
      vi.advanceTimersByTime(1000);

      role.rename('Editor');

      expect(role.updatedAt).toEqual(BASE_TIME);
    });

    it('throws RoleNameRequiredError for a blank name', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });
      expect(() => role.rename('  ')).toThrow(RoleNameRequiredError);
    });
  });

  describe('changeDescription', () => {
    it('sets and clears the description', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });

      role.changeDescription('Handles content');
      expect(role.description).toBe('Handles content');

      role.changeDescription(null);
      expect(role.description).toBeNull();
    });

    it('is a no-op when the normalised description is unchanged', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor', description: 'Handles content' });
      vi.advanceTimersByTime(1000);

      role.changeDescription('  Handles content  ');

      expect(role.description).toBe('Handles content');
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });

  describe('grant / revoke', () => {
    it('grants a permission once (idempotent) and bumps updatedAt', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });
      vi.advanceTimersByTime(1000);

      role.grant('users.read');
      role.grant('users.read');

      expect(role.permissions).toEqual(['users.read']);
      expect(role.updatedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    });

    it('does not touch the role when granting an already-held permission', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });
      vi.advanceTimersByTime(1000);

      role.grant('users.read');

      expect(role.updatedAt).toEqual(BASE_TIME);
    });

    it('revokes a permission and is a no-op when absent', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });

      role.revoke('users.read');
      expect(role.permissions).toEqual([]);

      vi.advanceTimersByTime(1000);
      role.revoke('users.read');
      expect(role.updatedAt).toEqual(BASE_TIME);
    });
  });

  describe('setPermissions / hasPermission', () => {
    it('replaces the whole permission set', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor', permissions: ['users.read'] });

      role.setPermissions(['roles.read', 'roles.update']);

      expect([...role.permissions].sort()).toEqual(['roles.read', 'roles.update']);
      expect(role.hasPermission('users.read')).toBe(false);
      expect(role.hasPermission('roles.read')).toBe(true);
    });
  });

  describe('system-role protection', () => {
    it('blocks rename / grant / revoke / setPermissions on a system role', () => {
      const role = Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' });

      expect(() => role.rename('x')).toThrow(SystemRoleProtectedError);
      expect(() => role.changeDescription('x')).toThrow(SystemRoleProtectedError);
      expect(() => role.grant('users.read')).toThrow(SystemRoleProtectedError);
      expect(() => role.revoke('users.read')).toThrow(SystemRoleProtectedError);
      expect(() => role.setPermissions([])).toThrow(SystemRoleProtectedError);
    });

    it('blocks soft-deleting a system role', () => {
      const role = Role.createSystem({ id: 'role-1', key: 'super-admin', name: 'Super Admin' });
      expect(() => role.softDelete()).toThrow(SystemRoleProtectedError);
      expect(role.isDeleted).toBe(false);
    });
  });

  describe('deleted-role protection', () => {
    it('soft-deletes an admin role and blocks further mutation', () => {
      const role = Role.create({ id: 'role-1', name: 'Editor' });

      role.softDelete();
      expect(role.isDeleted).toBe(true);

      expect(() => role.rename('x')).toThrow(RoleDeletedError);
      expect(() => role.grant('users.read')).toThrow(RoleDeletedError);
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
