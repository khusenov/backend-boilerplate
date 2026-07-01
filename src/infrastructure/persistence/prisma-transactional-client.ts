import { Prisma, type PrismaClient } from '@/generated/prisma/client';

export type PrismaTransactionalClient = PrismaClient | Prisma.TransactionClient;
