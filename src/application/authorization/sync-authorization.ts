import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type {
  UnitOfWork,
  TransactionalRepositories,
} from '@/application/shared/ports/unit-of-work';
import type { Env } from '@/config/env';
import { Role } from '@/domain/authorization/role-entity';
import { Email } from '@/domain/user/email-vo';
import { ALL_PERMISSIONS, SUPERADMIN_ROLE_KEY } from '@/domain/authorization/permission-catalogue';
import type { Actor } from '@/domain/authorization/actor';
import { ensureSystemActor } from '@/domain/authorization/access-policy';

export interface SyncAuthorizationResult {
  permissionsUpserted: number;
  permissionsRemoved: string[];
  superadminCreated: boolean;
  bootstrapPromoted: boolean;
}

interface SyncAuthorizationDeps {
  unitOfWork: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
  env: Env;
}

export class SyncAuthorization {
  private readonly unitOfWork: UnitOfWork;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly env: Env;

  constructor({ unitOfWork, idGenerator, clock, env }: SyncAuthorizationDeps) {
    this.unitOfWork = unitOfWork;
    this.ids = idGenerator;
    this.clock = clock;
    this.env = env;
  }

  async execute(actor: Actor): Promise<SyncAuthorizationResult> {
    ensureSystemActor(actor);

    const now = this.clock.now();

    return this.unitOfWork.run(async (repos) => {
      for (const def of ALL_PERMISSIONS) {
        await repos.permissionRepository.upsertByKey({
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
      const stored = await repos.permissionRepository.findAll();
      const permissionsRemoved = stored.map((p) => p.key).filter((key) => !catalogueKeys.has(key));
      await repos.permissionRepository.deleteByKeys(permissionsRemoved);

      let superadmin = await repos.roleRepository.findByKey(SUPERADMIN_ROLE_KEY);
      let superadminCreated = false;
      if (!superadmin) {
        superadmin = Role.createSystem(
          {
            id: this.ids.generate(),
            key: SUPERADMIN_ROLE_KEY,
            name: 'Super Admin',
          },
          now,
        );
        await repos.roleRepository.save(superadmin);
        superadminCreated = true;
      }

      const bootstrapPromoted = await this.promoteBootstrapAdmin(repos, superadmin.id, now);

      return {
        permissionsUpserted: ALL_PERMISSIONS.length,
        permissionsRemoved,
        superadminCreated,
        bootstrapPromoted,
      };
    });
  }

  private async promoteBootstrapAdmin(
    repos: TransactionalRepositories,
    superadminRoleId: string,
    now: Date,
  ): Promise<boolean> {
    const configured = this.env.BOOTSTRAP_ADMIN_EMAIL;
    if (!configured) return false;

    const user = await repos.userRepository.findByEmail(Email.create(configured));
    if (!user) return false;

    const roleIds = await repos.userRoleRepository.listRoleIdsForUser(user.id);
    if (roleIds.includes(superadminRoleId)) return false;

    await repos.userRoleRepository.assign(user.id, superadminRoleId, now);
    return true;
  }
}
