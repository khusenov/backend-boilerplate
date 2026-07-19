import { buildApp } from '@/presentation/http/app';
import { createLoggerOptions } from '@/infrastructure/logging/logger-options';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@/generated/prisma/client';

export interface TestHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
}

export async function createHarness(): Promise<TestHarness> {
  const app = await buildApp({
    loggerOptions: createLoggerOptions('silent'),
    disableRequestLogging: true,
    rateLimit: false,
  });
  await app.ready();

  const prisma = app.diContainer.cradle.prisma;
  return { app, prisma };
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.outboxMessage.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.user.deleteMany();
}
