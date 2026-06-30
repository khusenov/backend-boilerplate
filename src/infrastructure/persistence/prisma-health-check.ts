import type { HealthCheck } from '@/application/shared/ports/health-check';
import type { PrismaClient } from '@/generated/prisma/client';

interface PrismaHealthCheckDeps {
  prisma: PrismaClient;
}

export class PrismaHealthCheck implements HealthCheck {
  private readonly prisma: PrismaClient;

  constructor({ prisma }: PrismaHealthCheckDeps) {
    this.prisma = prisma;
  }

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
