import { toUserDto, type UserDto } from './user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';
import type { Actor } from '@/domain/authorization/actor';
import { ensureSelfOrPermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

export interface GetUserInput {
  id: string;
}

export type GetUserOutput = UserDto;

interface GetUserDeps {
  userRepository: UserRepository;
}

export class GetUser {
  private readonly users: UserRepository;

  constructor({ userRepository }: GetUserDeps) {
    this.users = userRepository;
  }

  async execute(input: GetUserInput, actor: Actor): Promise<GetUserOutput> {
    ensureSelfOrPermission(actor, input.id, PERMISSIONS.UsersRead.key);

    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);
    return toUserDto(user);
  }
}
