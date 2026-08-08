import { describe, expect, it, vi } from 'vitest';
import { SyncAuthorization } from './sync-authorization';
import { Role } from '@/domain/authorization/role-entity';
import { User } from '@/domain/user/user-entity';
import { Email } from '@/domain/user/email-vo';
import { ALL_PERMISSIONS, SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Clock } from '@/application/shared/ports/clock';
import type { Env } from '@/config/env';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '@/application/shared/ports/unit-of-work';

const SUPERADMIN_ID = 'superadmin-id';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

function existingSuperadmin(): Role {
  return Role.createSystem(
    { id: SUPERADMIN_ID, key: SUPERADMIN_ROLE_KEY, name: 'Super Admin' },
    CREATED_AT,
  );
}

function bootstrapUser(): User {
  return User.create(
    {
      id: 'admin-user',
      firstName: 'Boot',
      lastName: 'Strap',
      email: Email.create('admin@finflow.com'),
      passwordHash: 'hash',
    },
    CREATED_AT,
  );
}

function makeSync(envOverrides: Partial<Env> = {}) {
  const permissions = {
    findAll: vi.fn<PermissionRepository['findAll']>().mockResolvedValue([]),
    upsertByKey: vi.fn<PermissionRepository['upsertByKey']>().mockResolvedValue(undefined),
    deleteByKeys: vi.fn<PermissionRepository['deleteByKeys']>().mockResolvedValue(undefined),
  } satisfies PermissionRepository;

  const roles = {
    list: vi.fn<RoleRepository['list']>(),
    findById: vi.fn<RoleRepository['findById']>(),
    findByKey: vi.fn<RoleRepository['findByKey']>().mockResolvedValue(null),
    findByName: vi.fn<RoleRepository['findByName']>(),
    save: vi.fn<RoleRepository['save']>().mockResolvedValue(undefined),
  } satisfies RoleRepository;

  const users = {
    findByEmail: vi.fn<UserRepository['findByEmail']>().mockResolvedValue(null),
    findById: vi.fn<UserRepository['findById']>(),
    list: vi.fn<UserRepository['list']>(),
    save: vi.fn<UserRepository['save']>(),
  } satisfies UserRepository;

  const userRoles = {
    listRoleIdsForUser: vi.fn<UserRoleRepository['listRoleIdsForUser']>().mockResolvedValue([]),
    assign: vi.fn<UserRoleRepository['assign']>().mockResolvedValue(undefined),
    revoke: vi.fn<UserRoleRepository['revoke']>(),
  } satisfies UserRoleRepository;

  const verificationCodes = {
    create: vi.fn<EmailVerificationCodeRepository['create']>(),
    update: vi.fn<EmailVerificationCodeRepository['update']>(),
    findActiveByUserId: vi.fn<EmailVerificationCodeRepository['findActiveByUserId']>(),
  } satisfies EmailVerificationCodeRepository;

  const ids = {
    generate: vi.fn<IdGenerator['generate']>().mockReturnValue('gen-id'),
  } satisfies IdGenerator;

  const env = { BOOTSTRAP_ADMIN_EMAIL: '', ...envOverrides } as Env;

  const txRepos = {
    permissionRepository: permissions,
    roleRepository: roles,
    userRepository: users,
    userRoleRepository: userRoles,
    emailVerificationCodeRepository: verificationCodes,
  } satisfies TransactionalRepositories;

  const unitOfWork: UnitOfWork = {
    run: vi
      .fn()
      .mockImplementation((work: (repos: TransactionalRepositories) => Promise<unknown>) =>
        work(txRepos),
      ),
  };

  const clock = { now: vi.fn<Clock['now']>().mockReturnValue(NOW) } satisfies Clock;

  const sut = new SyncAuthorization({ unitOfWork, idGenerator: ids, clock, env });

  return { sut, permissions, roles, users, userRoles, ids, unitOfWork, clock };
}

describe('SyncAuthorization', () => {
  describe('catalogue', () => {
    it('upserts every catalogue permission by key', async () => {
      const ctx = makeSync();

      const result = await ctx.sut.execute();

      expect(ctx.permissions.upsertByKey).toHaveBeenCalledTimes(ALL_PERMISSIONS.length);
      expect(result.permissionsUpserted).toBe(ALL_PERMISSIONS.length);
      const upsertedKeys = ctx.permissions.upsertByKey.mock.calls.map(([r]) => r.key).sort();
      expect(upsertedKeys).toEqual(ALL_PERMISSIONS.map((p) => p.key).sort());
    });

    it('prunes stored permissions the catalogue no longer defines', async () => {
      const ctx = makeSync();
      const now = new Date();
      ctx.permissions.findAll.mockResolvedValue([
        {
          id: '1',
          key: 'users.read',
          name: 'x',
          description: null,
          category: 'users',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: '2',
          key: 'legacy.gone',
          name: 'x',
          description: null,
          category: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await ctx.sut.execute();

      expect(ctx.permissions.deleteByKeys).toHaveBeenCalledWith(['legacy.gone']);
      expect(result.permissionsRemoved).toEqual(['legacy.gone']);
    });
  });

  describe('superadmin role', () => {
    it('creates the superadmin system role when absent', async () => {
      const ctx = makeSync();

      const result = await ctx.sut.execute();

      expect(ctx.roles.save).toHaveBeenCalledOnce();
      const [saved] = ctx.roles.save.mock.calls[0]!;
      expect(saved.key).toBe(SUPERADMIN_ROLE_KEY);
      expect(saved.isSystem).toBe(true);
      expect(result.superadminCreated).toBe(true);
    });

    it('does not recreate the superadmin role when it already exists', async () => {
      const ctx = makeSync();
      ctx.roles.findByKey.mockResolvedValue(existingSuperadmin());

      const result = await ctx.sut.execute();

      expect(ctx.roles.save).not.toHaveBeenCalled();
      expect(result.superadminCreated).toBe(false);
    });
  });

  describe('bootstrap promotion', () => {
    it('does nothing when no bootstrap email is configured', async () => {
      const ctx = makeSync({ BOOTSTRAP_ADMIN_EMAIL: '' });

      const result = await ctx.sut.execute();

      expect(ctx.users.findByEmail).not.toHaveBeenCalled();
      expect(ctx.userRoles.assign).not.toHaveBeenCalled();
      expect(result.bootstrapPromoted).toBe(false);
    });

    it('no-ops when the configured operator has not registered yet', async () => {
      const ctx = makeSync({ BOOTSTRAP_ADMIN_EMAIL: 'admin@finflow.com' });
      ctx.roles.findByKey.mockResolvedValue(existingSuperadmin());
      ctx.users.findByEmail.mockResolvedValue(null);

      const result = await ctx.sut.execute();

      expect(ctx.userRoles.assign).not.toHaveBeenCalled();
      expect(result.bootstrapPromoted).toBe(false);
    });

    it('promotes the operator once they exist and lack the role', async () => {
      const ctx = makeSync({ BOOTSTRAP_ADMIN_EMAIL: 'admin@finflow.com' });
      ctx.roles.findByKey.mockResolvedValue(existingSuperadmin());
      ctx.users.findByEmail.mockResolvedValue(bootstrapUser());
      ctx.userRoles.listRoleIdsForUser.mockResolvedValue([]);

      const result = await ctx.sut.execute();

      expect(ctx.userRoles.assign).toHaveBeenCalledOnce();
      const [userId, roleId] = ctx.userRoles.assign.mock.calls[0]!;
      expect(userId).toBe('admin-user');
      expect(roleId).toBe(SUPERADMIN_ID);
      expect(result.bootstrapPromoted).toBe(true);
    });

    it('stamps upserts, the superadmin role and the promotion with one shared instant', async () => {
      const ctx = makeSync({ BOOTSTRAP_ADMIN_EMAIL: 'admin@finflow.com' });
      ctx.users.findByEmail.mockResolvedValue(bootstrapUser());

      await ctx.sut.execute();

      for (const [record] of ctx.permissions.upsertByKey.mock.calls) {
        expect(record.createdAt).toEqual(NOW);
        expect(record.updatedAt).toEqual(NOW);
      }
      const [savedRole] = ctx.roles.save.mock.calls[0]!;
      expect(savedRole.createdAt).toEqual(NOW);
      expect(ctx.userRoles.assign).toHaveBeenCalledWith('admin-user', 'gen-id', NOW);
      expect(ctx.clock.now).toHaveBeenCalledOnce();
    });

    it('is idempotent when the operator already holds the role', async () => {
      const ctx = makeSync({ BOOTSTRAP_ADMIN_EMAIL: 'admin@finflow.com' });
      ctx.roles.findByKey.mockResolvedValue(existingSuperadmin());
      ctx.users.findByEmail.mockResolvedValue(bootstrapUser());
      ctx.userRoles.listRoleIdsForUser.mockResolvedValue([SUPERADMIN_ID]);

      const result = await ctx.sut.execute();

      expect(ctx.userRoles.assign).not.toHaveBeenCalled();
      expect(result.bootstrapPromoted).toBe(false);
    });

    it('wraps all operations in a single transaction', async () => {
      const ctx = makeSync();

      await ctx.sut.execute();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ctx.unitOfWork.run).toHaveBeenCalledOnce();
    });
  });
});
