import { toUserDto, type UserDto } from '@/application/user/user-dto';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import { EmailAlreadyTakenError, UserNotFoundError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import type { User } from '@/domain/user/user-entity';
import type { Actor } from '@/domain/authorization/actor';
import { ensureSelfOrPermission } from '@/domain/authorization/access-policy';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { EmailVerificationCode } from '@/domain/verification/email-verification-code-entity';
import type { VerificationCodeIssuer } from '@/application/auth/verification-code-issuer';
import {
  SEND_VERIFICATION_EMAIL_JOB,
  type SendVerificationEmailPayload,
} from '@/application/jobs/send-verification-email-job';

export interface EditUserInput {
  id: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | undefined;
}

export type EditUserOutput = UserDto;

interface EditUserDeps {
  userRepository: UserRepository;
  clock: Clock;
  unitOfWork: UnitOfWork;
  emailVerificationCodeRepository: EmailVerificationCodeRepository;
  verificationCodeIssuer: VerificationCodeIssuer;
  jobQueue: JobQueue;
}

interface ResolvedVerificationCode {
  code: EmailVerificationCode;
  rawCode: string;
  isNew: boolean;
}

export class EditUser {
  private readonly users: UserRepository;
  private readonly clock: Clock;
  private readonly uow: UnitOfWork;
  private readonly verificationCodes: EmailVerificationCodeRepository;
  private readonly codeIssuer: VerificationCodeIssuer;
  private readonly queue: JobQueue;

  constructor({
    userRepository,
    clock,
    unitOfWork,
    emailVerificationCodeRepository,
    verificationCodeIssuer,
    jobQueue,
  }: EditUserDeps) {
    this.users = userRepository;
    this.clock = clock;
    this.uow = unitOfWork;
    this.verificationCodes = emailVerificationCodeRepository;
    this.codeIssuer = verificationCodeIssuer;
    this.queue = jobQueue;
  }

  async execute(input: EditUserInput, actor: Actor): Promise<EditUserOutput> {
    ensureSelfOrPermission(actor, input.id, PERMISSIONS.UsersUpdate.key);

    const user = await this.users.findById(input.id);
    if (!user) throw new UserNotFoundError(input.id);

    const now = this.clock.now();
    const newEmail = await this.changeEmailIfRequested(user, input.email, now);

    if (input.firstName !== undefined) user.changeFirstName(input.firstName, now);
    if (input.lastName !== undefined) user.changeLastName(input.lastName, now);

    const verificationCode = newEmail
      ? await this.resolveVerificationCode(user.id, now)
      : undefined;

    await this.uow.run(async ({ userRepository, emailVerificationCodeRepository }) => {
      await userRepository.save(user);
      if (verificationCode) {
        await this.persistVerificationCode(emailVerificationCodeRepository, verificationCode);
      }
    });

    if (newEmail && verificationCode) {
      const payload: SendVerificationEmailPayload = {
        email: newEmail,
        code: verificationCode.rawCode,
      };
      await this.queue.enqueue(SEND_VERIFICATION_EMAIL_JOB, payload);
    }

    return toUserDto(user);
  }

  private async persistVerificationCode(
    repository: EmailVerificationCodeRepository,
    verificationCode: ResolvedVerificationCode,
  ): Promise<void> {
    if (verificationCode.isNew) {
      await repository.create(verificationCode.code);
    } else {
      await repository.update(verificationCode.code);
    }
  }

  private async changeEmailIfRequested(
    user: User,
    rawEmail: string | undefined,
    now: Date,
  ): Promise<string | undefined> {
    if (rawEmail === undefined) return undefined;

    const email = Email.create(rawEmail);
    if (user.email.equals(email)) return undefined;

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) throw new EmailAlreadyTakenError(email.toString());

    user.changeEmail(email, now);
    return email.toString();
  }

  private async resolveVerificationCode(
    userId: string,
    now: Date,
  ): Promise<ResolvedVerificationCode> {
    const existingCode = await this.verificationCodes.findActiveByUserId(userId);

    if (existingCode) {
      const rawCode = this.codeIssuer.reissue(existingCode, now);
      return { code: existingCode, rawCode, isNew: false };
    }

    const { code, rawCode } = this.codeIssuer.issue(userId, now);
    return { code, rawCode, isNew: true };
  }
}
