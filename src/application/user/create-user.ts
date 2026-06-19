import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { toUserDto, type UserDto } from '@/application/user/user-dto';

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export type CreateUserOutput = UserDto;

interface CreateUserDeps {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  idGenerator: IdGenerator;
}

export class CreateUser {
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly ids: IdGenerator;

  constructor({ userRepository, passwordHasher, idGenerator }: CreateUserDeps) {
    this.users = userRepository;
    this.hasher = passwordHasher;
    this.ids = idGenerator;
  }

  async execute(input: CreateUserInput): Promise<CreateUserOutput> {
    const email = Email.create(input.email);

    const existingUser = await this.users.findByEmail(email);

    if (existingUser) throw new EmailAlreadyTakenError(email.toString());

    const passwordHash = await this.hasher.hash(input.password);

    const newUser = User.create({
      id: this.ids.generate(),
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      passwordHash,
    });

    await this.users.create(newUser);

    return toUserDto(newUser);
  }
}
