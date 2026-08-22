import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Clock } from '@/application/shared/ports/clock';
import type {
  OutboxStaging,
  TransactionContext,
  UnitOfWork,
} from '@/application/shared/ports/unit-of-work';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { UserRepository } from '@/domain/user/user-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';

function strictMock<T>(): MockProxy<T> & T {
  return mock<T>(undefined, {
    fallbackMockImplementation: () => {
      throw new Error('unstubbed port method: stub it explicitly in the test');
    },
  });
}

export function makeFixedClock(now: Date): MockProxy<Clock> & Clock {
  const clock = mock<Clock>();
  clock.now.mockReturnValue(now);
  return clock;
}

export function makeUnitOfWork() {
  const context = {
    userRepository: strictMock<UserRepository>(),
    roleRepository: strictMock<RoleRepository>(),
    permissionRepository: strictMock<PermissionRepository>(),
    userRoleRepository: strictMock<UserRoleRepository>(),
    emailVerificationCodeRepository: strictMock<EmailVerificationCodeRepository>(),
    passwordResetTokenRepository: strictMock<PasswordResetTokenRepository>(),
    outbox: mock<OutboxStaging>(),
  } satisfies TransactionContext;

  const unitOfWork = mock<UnitOfWork>();
  unitOfWork.run.mockImplementation((work) => work(context));

  return { unitOfWork, context };
}
