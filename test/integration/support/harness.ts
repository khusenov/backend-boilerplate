import { buildApp } from '@/presentation/http/app';
import { createAppContainer } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@/generated/prisma/client';
import { asValue } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import { SILENT_LOG_LEVEL } from './log-level';

export interface TestHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
}

export type CradleOverrides = Partial<Cradle>;

export async function createHarness(overrides: CradleOverrides = {}): Promise<TestHarness> {
  const container = createAppContainer(createBaseLogger(SILENT_LOG_LEVEL));
  for (const [name, value] of Object.entries(overrides)) {
    container.register({ [name]: asValue(value) });
  }

  const app = await buildApp({
    container,
    disableRequestLogging: true,
    rateLimit: false,
  });
  await app.ready();

  return { app, prisma: container.cradle.prisma };
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.outboxMessage.deleteMany();
  await prisma.emailVerificationCode.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.user.deleteMany();
}

export class CapturingJobQueue implements JobQueue {
  readonly enqueued: { jobName: string; payload: unknown }[] = [];

  enqueue<TPayload>(jobName: string, payload: TPayload): Promise<void> {
    this.enqueued.push({ jobName, payload });
    return Promise.resolve();
  }
}
