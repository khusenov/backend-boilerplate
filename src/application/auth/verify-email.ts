import { Email } from '@/domain/user/email-vo';
import { VerificationCodeInvalidError } from '@/domain/verification/verification-errors';
import { toUserDto, type UserDto } from '@/application/user/user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { VerificationCodeService } from '@/application/shared/ports/verification-code-service';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { Clock } from '@/application/shared/ports/clock';

export interface VerifyEmailInput {
  email: string;
  code: string;
}

export type VerifyEmailOutput = UserDto;

export interface VerifyEmailDeps {
  unitOfWork: UnitOfWork;
  userRepository: UserRepository;
  emailVerificationCodeRepository: EmailVerificationCodeRepository;
  verificationCodeService: VerificationCodeService;
  clock: Clock;
}

export class VerifyEmail {
  private readonly uow: UnitOfWork;
  private readonly users: UserRepository;
  private readonly codes: EmailVerificationCodeRepository;
  private readonly codeService: VerificationCodeService;
  private readonly clock: Clock;

  constructor({
    unitOfWork,
    userRepository,
    emailVerificationCodeRepository,
    verificationCodeService,
    clock,
  }: VerifyEmailDeps) {
    this.uow = unitOfWork;
    this.users = userRepository;
    this.codes = emailVerificationCodeRepository;
    this.codeService = verificationCodeService;
    this.clock = clock;
  }

  async execute(input: VerifyEmailInput): Promise<VerifyEmailOutput> {
    const email = Email.create(input.email);

    const user = await this.users.findByEmail(email);
    if (!user) throw new VerificationCodeInvalidError();

    const code = await this.codes.findActiveByUserId(user.id);
    if (!code) throw new VerificationCodeInvalidError();

    const candidateHash = this.codeService.hash(input.code);
    const now = this.clock.now();
    const attemptsBefore = code.attempts;

    try {
      code.verify(candidateHash, now);
    } catch (error) {
      if (code.attempts !== attemptsBefore) {
        await this.codes.update(code);
      }
      throw error;
    }

    user.activate(now);

    await this.uow.run(async ({ userRepository, emailVerificationCodeRepository }) => {
      await userRepository.save(user);
      await emailVerificationCodeRepository.update(code);
    });

    return toUserDto(user);
  }
}
