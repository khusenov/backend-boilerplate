import { toUserDto, type UserDto } from './user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import { UserNotFoundError } from '@/domain/user/user-errors';

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

  async execute(input: GetUserInput): Promise<GetUserOutput> {
    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);
    return toUserDto(user);
  }
}
