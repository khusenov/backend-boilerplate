import type { Prisma } from '@/generated/prisma/client';

export type PrismaTransactionalClient = Omit<Prisma.TransactionClient, '$transaction'>;
