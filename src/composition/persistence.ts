import { asClass, asFunction } from 'awilix';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/infrastructure/persistence/prisma-client';
import type { UserRepository } from '@/domain/user/user-repository';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import type { EmailVerificationCodeRepository } from '@/domain/verification/email-verification-code-repository';
import type { PasswordResetTokenRepository } from '@/domain/password-reset/password-reset-token-repository';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import type { GrantsReader } from '@/application/shared/ports/grants-reader';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma-user-repository';
import { PrismaRefreshTokenRepository } from '@/infrastructure/persistence/prisma-refresh-token-repository';
import { PrismaEmailVerificationCodeRepository } from '@/infrastructure/persistence/prisma-email-verification-code-repository';
import { PrismaPasswordResetTokenRepository } from '@/infrastructure/persistence/prisma-password-reset-token-repository';
import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma-role-repository';
import { PrismaPermissionRepository } from '@/infrastructure/persistence/prisma-permission-repository';
import { PrismaUserRoleRepository } from '@/infrastructure/persistence/prisma-user-role-repository';
import { PrismaGrantsReader } from '@/infrastructure/persistence/prisma-grants-reader';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma-unit-of-work';
import { PrismaOutboxWriter } from '@/infrastructure/persistence/prisma-outbox-writer';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    prisma: PrismaClient;
    userRepository: UserRepository;
    refreshTokenRepository: RefreshTokenRepository;
    emailVerificationCodeRepository: EmailVerificationCodeRepository;
    passwordResetTokenRepository: PasswordResetTokenRepository;
    roleRepository: RoleRepository;
    permissionRepository: PermissionRepository;
    userRoleRepository: UserRoleRepository;
    grants: GrantsReader;
    unitOfWork: UnitOfWork;
    outboxWriter: PrismaOutboxWriter;
  }
}

export const persistenceRegistrations = {
  prisma: asFunction(createPrismaClient)
    .singleton()
    .disposer((client) => client.$disconnect()),
  userRepository: asClass(PrismaUserRepository).singleton(),
  refreshTokenRepository: asClass(PrismaRefreshTokenRepository).singleton(),
  emailVerificationCodeRepository: asClass(PrismaEmailVerificationCodeRepository).singleton(),
  passwordResetTokenRepository: asClass(PrismaPasswordResetTokenRepository).singleton(),
  roleRepository: asClass(PrismaRoleRepository).singleton(),
  permissionRepository: asClass(PrismaPermissionRepository).singleton(),
  userRoleRepository: asClass(PrismaUserRoleRepository).singleton(),
  grants: asClass(PrismaGrantsReader).singleton(),
  unitOfWork: asClass(PrismaUnitOfWork).singleton(),
  outboxWriter: asClass(PrismaOutboxWriter).singleton(),
} satisfies RegistrationMap;
