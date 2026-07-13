import { asClass, asFunction, asValue, type AwilixContainer } from 'awilix';
import { env, type Env } from '@/config/env';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/infrastructure/persistence/prisma-client';
import type { UserRepository } from '@/domain/user/user-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import { CreateUser } from '@/application/user/create-user';
import { GetUser } from '@/application/user/get-user';
import { ListUsers } from '@/application/user/list-users';
import { EditUser } from '@/application/user/edit-user';
import { DeleteUser } from '@/application/user/delete-user';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma-user-repository';
import { UuidIdGenerator } from '@/infrastructure/identity/uuid-id-generator';
import { Argon2PasswordHasher } from '@/infrastructure/security/argon2-password-hasher';
import type { AccessTokenService } from '@/application/shared/ports/access-token-service';
import type { OpaqueTokenService } from '@/application/shared/ports/opaque-token-service';
import type { RefreshTokenRepository } from '@/domain/auth/refresh-token-repository';
import { SessionService } from '@/application/auth/session-service';
import { Login } from '@/application/auth/login';
import { RefreshSession } from '@/application/auth/refresh-session';
import { Logout } from '@/application/auth/logout';
import { JoseAccessTokenService } from '@/infrastructure/security/jose-access-token-service';
import { CryptoOpaqueTokenService } from '@/infrastructure/security/crypto-opaque-token-service';
import { PrismaRefreshTokenRepository } from '@/infrastructure/persistence/prisma-refresh-token-repository';
import type { GrantsReader } from '@/application/shared/ports/grants-reader';
import type { HealthCheck } from '@/application/shared/ports/health-check';
import type { RoleRepository } from '@/domain/authorization/role-repository';
import type { PermissionRepository } from '@/application/shared/ports/permission-repository';
import type { UserRoleRepository } from '@/application/shared/ports/user-role-repository';
import { PrismaGrantsReader } from '@/infrastructure/persistence/prisma-grants-reader';
import { PrismaHealthCheck } from '@/infrastructure/persistence/prisma-health-check';
import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma-role-repository';
import { PrismaPermissionRepository } from '@/infrastructure/persistence/prisma-permission-repository';
import { PrismaUserRoleRepository } from '@/infrastructure/persistence/prisma-user-role-repository';
import { CreateRole } from '@/application/authorization/create-role';
import { GetRole } from '@/application/authorization/get-role';
import { ListRoles } from '@/application/authorization/list-roles';
import { EditRole } from '@/application/authorization/edit-role';
import { DeleteRole } from '@/application/authorization/delete-role';
import { AssignRole } from '@/application/authorization/assign-role';
import { RevokeRole } from '@/application/authorization/revoke-role';
import { ListPermissions } from '@/application/authorization/list-permissions';
import { SyncAuthorization } from '@/application/authorization/sync-authorization';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from '@/application/shared/ports/logger';
import { PinoLogger } from '@/infrastructure/logging/pino-logger';
import { RequestContextProvider } from '@/infrastructure/logging/request-context-provider';
import type { UnitOfWork } from '@/application/shared/ports/unit-of-work';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma-unit-of-work';
import type { DomainEventDispatcher } from '@/application/shared/ports/domain-event-dispatcher';
import type { DomainEventHandler } from '@/application/shared/ports/domain-event-handler';
import { InProcessDomainEventDispatcher } from '@/infrastructure/events/in-process-domain-event-dispatcher';
import type { Cradle } from '@fastify/awilix';
import { UserCreatedLogHandler } from '@/application/user/events/user-created-log-handler';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '@/infrastructure/jobs/redis-connection';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { JobWorker } from '@/infrastructure/jobs/job-worker';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import { ExampleJobHandler } from '@/application/jobs/example-job-handler';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    logger: Logger;
    prisma: PrismaClient;

    // ports
    userRepository: UserRepository;
    idGenerator: IdGenerator;
    passwordHasher: PasswordHasher;
    accessTokenService: AccessTokenService;
    opaqueTokenService: OpaqueTokenService;
    refreshTokenRepository: RefreshTokenRepository;
    grants: GrantsReader;
    healthCheck: HealthCheck;
    roleRepository: RoleRepository;
    permissionRepository: PermissionRepository;
    userRoleRepository: UserRoleRepository;
    unitOfWork: UnitOfWork;
    domainEventDispatcher: DomainEventDispatcher;
    userCreatedLogHandler: DomainEventHandler;

    // jobs
    queuePrefix: string;
    queueConcurrency: number;
    redisConnection: Redis;
    workerConnection: Redis;
    exampleJobHandler: ExampleJobHandler;
    jobQueue: JobQueue;
    jobWorker: JobWorker;

    // use cases
    listUsers: ListUsers;
    getUser: GetUser;
    createUser: CreateUser;
    editUser: EditUser;
    deleteUser: DeleteUser;
    sessionService: SessionService;
    login: Login;
    refreshSession: RefreshSession;
    logout: Logout;
    createRole: CreateRole;
    getRole: GetRole;
    listRoles: ListRoles;
    editRole: EditRole;
    deleteRole: DeleteRole;
    assignRole: AssignRole;
    revokeRole: RevokeRole;
    listPermissions: ListPermissions;
    syncAuthorization: SyncAuthorization;
  }
}

function createDomainEventDispatcher({
  logger,
  userCreatedLogHandler,
}: Pick<Cradle, 'logger' | 'userCreatedLogHandler'>): DomainEventDispatcher {
  return new InProcessDomainEventDispatcher({ handlers: [userCreatedLogHandler], logger });
}

export function registerDependencies(
  container: AwilixContainer,
  baseLogger: FastifyBaseLogger,
): void {
  container.register({
    env: asValue(env),
    logger: asValue(new PinoLogger(baseLogger, new RequestContextProvider())),
    prisma: asFunction(createPrismaClient)
      .singleton()
      .disposer((client) => client.$disconnect()),

    userRepository: asClass(PrismaUserRepository).singleton(),
    idGenerator: asClass(UuidIdGenerator).singleton(),
    passwordHasher: asClass(Argon2PasswordHasher).singleton(),
    accessTokenService: asClass(JoseAccessTokenService).singleton(),
    opaqueTokenService: asClass(CryptoOpaqueTokenService).singleton(),
    refreshTokenRepository: asClass(PrismaRefreshTokenRepository).singleton(),
    grants: asClass(PrismaGrantsReader).singleton(),
    healthCheck: asClass(PrismaHealthCheck).singleton(),
    roleRepository: asClass(PrismaRoleRepository).singleton(),
    permissionRepository: asClass(PrismaPermissionRepository).singleton(),
    userRoleRepository: asClass(PrismaUserRoleRepository).singleton(),
    unitOfWork: asClass(PrismaUnitOfWork).singleton(),
    userCreatedLogHandler: asClass(UserCreatedLogHandler).singleton(),
    domainEventDispatcher: asFunction(createDomainEventDispatcher).singleton(),

    queuePrefix: asValue(env.QUEUE_PREFIX),
    queueConcurrency: asValue(env.QUEUE_CONCURRENCY),
    redisConnection: asFunction(() =>
      createRedisConnection({ redisUrl: env.REDIS_URL }),
    ).singleton(),
    workerConnection: asFunction(() =>
      createRedisConnection({ redisUrl: env.REDIS_URL }),
    ).singleton(),
    exampleJobHandler: asClass(ExampleJobHandler).singleton(),
    jobQueue: asFunction(
      ({ redisConnection, queuePrefix }: Pick<Cradle, 'redisConnection' | 'queuePrefix'>) =>
        new BullMqJobQueue({
          connection: redisConnection,
          queuePrefix,
        }),
    )
      .singleton()
      .disposer((queue) => queue.close()),
    jobWorker: asFunction(
      ({
        workerConnection,
        exampleJobHandler,
        logger,
        queuePrefix,
        queueConcurrency,
      }: Pick<
        Cradle,
        'workerConnection' | 'exampleJobHandler' | 'logger' | 'queuePrefix' | 'queueConcurrency'
      >) =>
        new JobWorker({
          connection: workerConnection,
          queuePrefix,
          concurrency: queueConcurrency,
          handlers: [exampleJobHandler],
          logger,
        }),
    )
      .singleton()
      .disposer((worker) => worker.close()),

    listUsers: asClass(ListUsers).singleton(),
    getUser: asClass(GetUser).singleton(),
    createUser: asClass(CreateUser).singleton(),
    editUser: asClass(EditUser).singleton(),
    deleteUser: asClass(DeleteUser).singleton(),
    sessionService: asClass(SessionService).singleton(),
    login: asClass(Login).singleton(),
    refreshSession: asClass(RefreshSession).singleton(),
    logout: asClass(Logout).singleton(),
    createRole: asClass(CreateRole).singleton(),
    getRole: asClass(GetRole).singleton(),
    listRoles: asClass(ListRoles).singleton(),
    editRole: asClass(EditRole).singleton(),
    deleteRole: asClass(DeleteRole).singleton(),
    assignRole: asClass(AssignRole).singleton(),
    revokeRole: asClass(RevokeRole).singleton(),
    listPermissions: asClass(ListPermissions).singleton(),
    syncAuthorization: asClass(SyncAuthorization).singleton(),
  });
}
