import type { UserRepository } from '@/domain/user/user-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';

export interface TransactionalRepositories {
  userRepository: UserRepository;
  roleRepository: RoleRepository;
  permissionRepository: PermissionRepository;
  userRoleRepository: UserRoleRepository;
  emailVerificationCodeRepository: EmailVerificationCodeRepository;
}

export interface OutboxStaging {
  stage(events: readonly DomainEvent[]): void;
}

export interface TransactionContext extends TransactionalRepositories {
  readonly outbox: OutboxStaging;
}

export interface UnitOfWork {
  run<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}
