import { toRoleDto, type RoleDto } from './role-dto';
import { assertKnownPermissions } from './assert-known-permissions';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import { Role } from '@/domain/authorization/role-entity';
import { RoleNameTakenError } from '@/domain/authorization/role-errors';

export interface CreateRoleInput {
  name: string;
  description?: string | null | undefined;
  permissions?: string[] | undefined;
}

export type CreateRoleOutput = RoleDto;

interface CreateRoleDeps {
  roleRepository: RoleRepository;
  idGenerator: IdGenerator;
}

export class CreateRole {
  private readonly roles: RoleRepository;
  private readonly ids: IdGenerator;

  constructor({ roleRepository, idGenerator }: CreateRoleDeps) {
    this.roles = roleRepository;
    this.ids = idGenerator;
  }

  async execute(input: CreateRoleInput): Promise<CreateRoleOutput> {
    const permissions = input.permissions ?? [];
    assertKnownPermissions(permissions);

    const role = Role.create({
      id: this.ids.generate(),
      name: input.name,
      description: input.description ?? null,
      permissions,
    });

    const existing = await this.roles.findByName(role.name);
    if (existing) throw new RoleNameTakenError(role.name);

    await this.roles.save(role);
    return toRoleDto(role);
  }
}
