import { toRoleDto, type RoleDto } from './role-dto';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import {
  createPage,
  normalizePageQuery,
  type Page,
  type PageQueryInput,
} from '@/shared/pagination';

export type ListRolesInput = PageQueryInput;

export type ListRolesOutput = Page<RoleDto>;

interface ListRolesDeps {
  roleRepository: RoleRepository;
}

export class ListRoles {
  private readonly roles: RoleRepository;

  constructor({ roleRepository }: ListRolesDeps) {
    this.roles = roleRepository;
  }

  async execute(input: ListRolesInput): Promise<ListRolesOutput> {
    const query = normalizePageQuery(input);
    const { items, total } = await this.roles.list(query);
    return createPage(items.map(toRoleDto), total, query);
  }
}
