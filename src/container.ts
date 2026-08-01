import { asClass, asFunction, asValue, aliasTo, type AwilixContainer } from 'awilix';
import { env, type Env } from '@/config/env';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/infrastructure/persistence/prisma-client';
import type { UserRepository } from '@/domain/user/user-repository';
import type { Clock } from '@/application/shared/ports/clock';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import { CreateUser } from '@/application/user/create-user';
import { GetUser } from '@/application/user/get-user';
import { ListUsers } from '@/application/user/list-users';
import { EditUser } from '@/application/user/edit-user';
import { DeleteUser } from '@/application/user/delete-user';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma-user-repository';
import { UuidIdGenerator } from '@/infrastructure/identity/uuid-id-generator';
import { SystemClock } from '@/infrastructure/time/system-clock';
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
import { DomainEventSerializer } from '@/infrastructure/events/domain-event-serializer';
import { domainEventFactories } from '@/infrastructure/events/domain-event-factories';
import { DomainEventHandlerRegistry } from '@/infrastructure/events/domain-event-handler-registry';
import { DispatchDomainEventJobHandler } from '@/infrastructure/events/dispatch-domain-event-job-handler';
import { OutboxRelay } from '@/infrastructure/events/outbox-relay';
import { PrismaOutboxWriter } from '@/infrastructure/persistence/prisma-outbox-writer';
import { BullMqJobScheduler } from '@/infrastructure/jobs/bullmq-job-scheduler';
import type { JobScheduler } from '@/application/shared/ports/job-scheduler';
import type { MetricsExposition, MetricsRecorder } from '@/application/shared/ports/metrics';
import { PrometheusMetricsRecorder } from '@/infrastructure/observability/prometheus-metrics-recorder';
import { RedisHealthCheck } from '@/infrastructure/jobs/redis-health-check';
import { CompositeHealthCheck } from '@/infrastructure/health/composite-health-check';
import { createRateLimitRedis } from '@/infrastructure/security/rate-limit-redis';
import { RefreshTokenRetentionTask } from '@/infrastructure/persistence/refresh-token-retention-task';
import { OutboxRetentionTask } from '@/infrastructure/persistence/outbox-retention-task';
import { EnforceDataRetentionJob } from '@/application/retention/enforce-data-retention-job';
import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { Queue } from 'bullmq';
import { createDashboardQueue } from '@/infrastructure/jobs/dashboard-queue';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    logger: Logger;
    prisma: PrismaClient;

    // ports
    userRepository: UserRepository;
    idGenerator: IdGenerator;
    clock: Clock;
    passwordHasher: PasswordHasher;
    accessTokenService: AccessTokenService;
    opaqueTokenService: OpaqueTokenService;
    refreshTokenRepository: RefreshTokenRepository;
    grants: GrantsReader;
    healthCheck: HealthCheck;
    databaseHealthCheck: HealthCheck;
    redisHealthCheck: HealthCheck;
    healthCheckRedisConnection: Redis;
    healthCheckTimeoutMs: number;
    roleRepository: RoleRepository;
    permissionRepository: PermissionRepository;
    userRoleRepository: UserRoleRepository;
    unitOfWork: UnitOfWork;
    domainEventDispatcher: DomainEventDispatcher;
    userCreatedLogHandler: DomainEventHandler;
    domainEventHandlers: DomainEventHandler[];
    domainEventHandlerRegistry: DomainEventHandlerRegistry;
    domainEventSerializer: DomainEventSerializer;
    outboxWriter: PrismaOutboxWriter;
    dispatchDomainEventJobHandler: DispatchDomainEventJobHandler;
    outboxRelay: OutboxRelay;
    queuePrefix: string;
    queueConcurrency: number;
    redisConnection: Redis;
    workerConnection: Redis;
    rateLimitRedis: Redis;
    exampleJobHandler: ExampleJobHandler;
    jobQueue: JobQueue;
    jobWorker: JobWorker;
    jobScheduler: JobScheduler;
    dashboardQueue: Queue;
    dataRetentionWindowMs: number;
    refreshTokenRetentionTask: RetentionTask;
    outboxRetentionTask: RetentionTask;
    enforceDataRetentionJob: EnforceDataRetentionJob;
    metricsRecorder: MetricsRecorder;
    metricsExposition: MetricsExposition;

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
  domainEventHandlerRegistry,
  logger,
}: Pick<Cradle, 'domainEventHandlerRegistry' | 'logger'>): DomainEventDispatcher {
  return new InProcessDomainEventDispatcher({ domainEventHandlerRegistry, logger });
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
    clock: asClass(SystemClock).singleton(),
    passwordHasher: asClass(Argon2PasswordHasher).singleton(),
    accessTokenService: asClass(JoseAccessTokenService).singleton(),
    opaqueTokenService: asClass(CryptoOpaqueTokenService).singleton(),
    refreshTokenRepository: asClass(PrismaRefreshTokenRepository).singleton(),
    grants: asClass(PrismaGrantsReader).singleton(),
    databaseHealthCheck: asClass(PrismaHealthCheck).singleton(),
    healthCheckRedisConnection: asFunction(() => createRedisConnection({ redisUrl: env.REDIS_URL }))
      .singleton()
      .disposer((connection) => connection.disconnect()),
    redisHealthCheck: asClass(RedisHealthCheck).singleton(),
    healthCheck: asFunction(
      ({
        databaseHealthCheck,
        redisHealthCheck,
      }: Pick<Cradle, 'databaseHealthCheck' | 'redisHealthCheck'>) =>
        new CompositeHealthCheck([databaseHealthCheck, redisHealthCheck]),
    ).singleton(),
    healthCheckTimeoutMs: asValue(env.HEALTHCHECK_TIMEOUT_MS),
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
    rateLimitRedis: asFunction(() => createRateLimitRedis({ redisUrl: env.REDIS_URL }))
      .singleton()
      .disposer((connection) => connection.disconnect()),
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
        outboxRelay,
        dispatchDomainEventJobHandler,
        enforceDataRetentionJob,
        logger,
        queuePrefix,
        queueConcurrency,
      }: Pick<
        Cradle,
        | 'workerConnection'
        | 'exampleJobHandler'
        | 'outboxRelay'
        | 'dispatchDomainEventJobHandler'
        | 'enforceDataRetentionJob'
        | 'logger'
        | 'queuePrefix'
        | 'queueConcurrency'
      >) =>
        new JobWorker({
          connection: workerConnection,
          queuePrefix,
          concurrency: queueConcurrency,
          handlers: [
            exampleJobHandler,
            outboxRelay,
            dispatchDomainEventJobHandler,
            enforceDataRetentionJob,
          ],
          logger,
        }),
    )
      .singleton()
      .disposer((worker) => worker.close()),
    dataRetentionWindowMs: asValue(env.DATA_RETENTION_TTL * 1000),
    refreshTokenRetentionTask: asClass(RefreshTokenRetentionTask).singleton(),
    outboxRetentionTask: asClass(OutboxRetentionTask).singleton(),
    enforceDataRetentionJob: asFunction(
      ({
        refreshTokenRetentionTask,
        outboxRetentionTask,
        dataRetentionWindowMs,
        clock,
        logger,
      }: Pick<
        Cradle,
        | 'refreshTokenRetentionTask'
        | 'outboxRetentionTask'
        | 'dataRetentionWindowMs'
        | 'clock'
        | 'logger'
      >) =>
        new EnforceDataRetentionJob({
          retentionTasks: [refreshTokenRetentionTask, outboxRetentionTask],
          dataRetentionWindowMs,
          clock,
          logger,
        }),
    ).singleton(),
    domainEventHandlers: asFunction(
      ({ userCreatedLogHandler }: Pick<Cradle, 'userCreatedLogHandler'>) => [userCreatedLogHandler],
    ).singleton(),
    domainEventHandlerRegistry: asFunction(
      ({ domainEventHandlers }: Pick<Cradle, 'domainEventHandlers'>) =>
        new DomainEventHandlerRegistry({ handlers: domainEventHandlers }),
    ).singleton(),
    domainEventSerializer: asFunction(
      () => new DomainEventSerializer({ factories: domainEventFactories }),
    ).singleton(),
    outboxWriter: asClass(PrismaOutboxWriter).singleton(),
    dispatchDomainEventJobHandler: asClass(DispatchDomainEventJobHandler).singleton(),
    outboxRelay: asClass(OutboxRelay).singleton(),
    jobScheduler: asFunction(
      ({ redisConnection, queuePrefix }: Pick<Cradle, 'redisConnection' | 'queuePrefix'>) =>
        new BullMqJobScheduler({ connection: redisConnection, queuePrefix }),
    )
      .singleton()
      .disposer((scheduler) => scheduler.close()),
    dashboardQueue: asFunction(createDashboardQueue)
      .singleton()
      .disposer((queue) => queue.close()),
    metricsRecorder: asClass(PrometheusMetricsRecorder).singleton(),
    metricsExposition: aliasTo('metricsRecorder'),

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
