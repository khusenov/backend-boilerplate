import { toUserDto, type UserDto } from '@/application/user/user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import { EmailAlreadyTakenError, UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';

export interface EditUserInput {
  id: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | undefined;
}

export type EditUserOutput = UserDto;

interface EditUserDeps {
  userRepository: UserRepository;
}

export class EditUser {
  private readonly users: UserRepository;

  constructor({ userRepository }: EditUserDeps) {
    this.users = userRepository;
  }

  async execute(input: EditUserInput): Promise<EditUserOutput> {
    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);

    if (input.email !== undefined) {
      const email = Email.create(input.email);
      if (!user.email.equals(email)) {
        const existingUser = await this.users.findByEmail(email);
        if (existingUser) throw new EmailAlreadyTakenError(email.toString());
        user.changeEmail(email);
      }
    }

    if (input.firstName !== undefined) user.changeFirstName(input.firstName);
    if (input.lastName !== undefined) user.changeLastName(input.lastName);

    await this.users.update(user);
    return toUserDto(user);
  }
}
