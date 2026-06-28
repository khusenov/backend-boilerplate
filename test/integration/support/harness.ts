import { buildApp } from '@/presentation/http/app';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@/generated/prisma/client';

export interface TestHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
}

export async function createHarness(): Promise<TestHarness> {
  const app = await buildApp({ logLevel: 'silent', disableRequestLogging: true });
  await app.ready();

  const prisma = app.diContainer.cradle.prisma;
  return { app, prisma };
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.refreshToken.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.user.deleteMany();
}
