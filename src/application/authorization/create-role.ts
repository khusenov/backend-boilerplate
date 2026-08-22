import { toRoleDto, type RoleDto } from './role-dto';
import { assertKnownPermissions } from './assert-known-permissions';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import { Role } from '@/domain/authorization/role-entity';
import { RoleNameTakenError } from '@/domain/authorization/role-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface CreateRoleInput {
  name: string;
  description?: string | null | undefined;
  permissions?: string[] | undefined;
}

export type CreateRoleOutput = RoleDto;

interface CreateRoleDeps {
  unitOfWork: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}

export class CreateRole {
  private readonly unitOfWork: UnitOfWork;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;

  constructor({ unitOfWork, idGenerator, clock }: CreateRoleDeps) {
    this.unitOfWork = unitOfWork;
    this.ids = idGenerator;
    this.clock = clock;
  }

  async execute(input: CreateRoleInput, actor: Actor): Promise<CreateRoleOutput> {
    ensurePermission(actor, PERMISSIONS.RolesCreate.key);

    const permissions = input.permissions ?? [];
    assertKnownPermissions(permissions);

    const role = Role.create(
      {
        id: this.ids.generate(),
        name: input.name,
        description: input.description ?? null,
        permissions,
      },
      this.clock.now(),
    );

    return this.unitOfWork.run(async ({ roleRepository }) => {
      const existing = await roleRepository.findByName(role.name);
      if (existing) throw new RoleNameTakenError(role.name);

      await roleRepository.save(role);
      return toRoleDto(role);
    });
  }
}
