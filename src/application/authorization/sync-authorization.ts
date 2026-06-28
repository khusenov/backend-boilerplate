import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { Env } from '@/config/env';
import { Role } from '@/domain/authorization/role-entity';
import { Email } from '@/domain/user/email-vo';
import { ALL_PERMISSIONS, SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';

export interface SyncAuthorizationResult {
  permissionsUpserted: number;
  permissionsRemoved: string[];
  superadminCreated: boolean;
  bootstrapPromoted: boolean;
}

interface SyncAuthorizationDeps {
  permissionRepository: PermissionRepository;
  roleRepository: RoleRepository;
  userRepository: UserRepository;
  userRoleRepository: UserRoleRepository;
  idGenerator: IdGenerator;
  env: Env;
}

export class SyncAuthorization {
  private readonly permissions: PermissionRepository;
  private readonly roles: RoleRepository;
  private readonly users: UserRepository;
  private readonly userRoles: UserRoleRepository;
  private readonly ids: IdGenerator;
  private readonly env: Env;

  constructor({
    permissionRepository,
    roleRepository,
    userRepository,
    userRoleRepository,
    idGenerator,
    env,
  }: SyncAuthorizationDeps) {
    this.permissions = permissionRepository;
    this.roles = roleRepository;
    this.users = userRepository;
    this.userRoles = userRoleRepository;
    this.ids = idGenerator;
    this.env = env;
  }

  async execute(): Promise<SyncAuthorizationResult> {
    const now = new Date();

    for (const def of ALL_PERMISSIONS) {
      await this.permissions.upsertByKey({
        id: this.ids.generate(),
        key: def.key,
        name: def.name,
        description: null,
        category: def.category,
        createdAt: now,
        updatedAt: now,
      });
    }

    const catalogueKeys = new Set(ALL_PERMISSIONS.map((p) => p.key));
    const stored = await this.permissions.findAll();
    const permissionsRemoved = stored.map((p) => p.key).filter((key) => !catalogueKeys.has(key));
    await this.permissions.deleteByKeys(permissionsRemoved);

    let superadmin = await this.roles.findByKey(SUPERADMIN_ROLE_KEY);
    let superadminCreated = false;
    if (!superadmin) {
      superadmin = Role.createSystem({
        id: this.ids.generate(),
        key: SUPERADMIN_ROLE_KEY,
        name: 'Super Admin',
      });
      await this.roles.save(superadmin);
      superadminCreated = true;
    }

    const bootstrapPromoted = await this.promoteBootstrapAdmin(superadmin.id, now);

    return {
      permissionsUpserted: ALL_PERMISSIONS.length,
      permissionsRemoved,
      superadminCreated,
      bootstrapPromoted,
    };
  }

  private async promoteBootstrapAdmin(superadminRoleId: string, now: Date): Promise<boolean> {
    const configured = this.env.BOOTSTRAP_ADMIN_EMAIL;
    if (!configured) return false;

    const user = await this.users.findByEmail(Email.create(configured));
    if (!user) return false;

    const roleIds = await this.userRoles.listRoleIdsForUser(user.id);
    if (roleIds.includes(superadminRoleId)) return false;

    await this.userRoles.assign(user.id, superadminRoleId, now);
    return true;
  }
}
