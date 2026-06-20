import type { AuthResultDto } from './auth-dto';
import { SessionService } from './session-service';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import { Email } from '@/domain/user/email-vo';
import { InvalidCredentialsError } from '@/domain/auth/auth-errors';
import { toUserDto } from '@/application/user/user-dto';

export interface LoginInput {
  email: string;
  password: string;
}

export type LoginOutput = AuthResultDto;

interface LoginDeps {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  sessionService: SessionService;
}

export class Login {
  private readonly users: UserRepository;
  private readonly hasher: PasswordHasher;
  private readonly sessions: SessionService;

  constructor({ userRepository, passwordHasher, sessionService }: LoginDeps) {
    this.users = userRepository;
    this.hasher = passwordHasher;
    this.sessions = sessionService;
  }

  async execute(input: LoginInput): Promise<LoginOutput> {
    const email = Email.create(input.email);
    const user = await this.users.findByEmail(email);

    if (!user) throw new InvalidCredentialsError();

    const passwordOk = await this.hasher.verify(input.password, user.passwordHash);
    if (!passwordOk) throw new InvalidCredentialsError();

    if (!user.isActive) throw new InvalidCredentialsError();

    const tokens = await this.sessions.issue(user);
    return { user: toUserDto(user), tokens };
  }
}
