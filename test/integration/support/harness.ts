import { buildApp } from '@/presentation/http/app';
import { createLoggerOptions } from '@/infrastructure/logging/logger-options';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@/generated/prisma/client';
import { asValue } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { JobQueue } from '@/application/shared/ports/job-queue';

export interface TestHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
}

export type CradleOverrides = Partial<Cradle>;

export async function createHarness(overrides: CradleOverrides = {}): Promise<TestHarness> {
  const app = await buildApp({
    loggerOptions: createLoggerOptions('silent'),
    disableRequestLogging: true,
    rateLimit: false,
  });
  for (const [name, value] of Object.entries(overrides)) {
    app.diContainer.register({ [name]: asValue(value) });
  }
  await app.ready();

  const prisma = app.diContainer.cradle.prisma;
  return { app, prisma };
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
