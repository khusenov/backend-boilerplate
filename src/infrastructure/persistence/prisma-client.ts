import { PrismaClient } from '@/generated/prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { env } from '@/config/env';

export function createPrismaClient(): PrismaClient {
  const adapter = new PrismaMariaDb(env.DATABASE_URL);
  return new PrismaClient({ adapter });
}
