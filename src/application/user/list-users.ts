import { toUserDto, type UserDto } from './user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Actor } from '@/domain/authorization/actor';
import { ensurePermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import {
  createPage,
  normalizePageQuery,
  type Page,
  type PageQueryInput,
} from '@/shared/pagination';

export type ListUsersInput = PageQueryInput;

export type ListUsersOutput = Page<UserDto>;

interface ListUsersDeps {
  userRepository: UserRepository;
}

export class ListUsers {
  private readonly users: UserRepository;

  constructor({ userRepository }: ListUsersDeps) {
    this.users = userRepository;
  }

  async execute(input: ListUsersInput, actor: Actor): Promise<ListUsersOutput> {
    ensurePermission(actor, PERMISSIONS.UsersRead.key);

    const query = normalizePageQuery(input);
    const { items, total } = await this.users.list(query);
    return createPage(items.map(toUserDto), total, query);
  }
}
