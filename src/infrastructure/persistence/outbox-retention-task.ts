import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { PrismaClient } from '@/generated/prisma/client';

export interface OutboxRetentionTaskDeps {
  prisma: PrismaClient;
}

export class OutboxRetentionTask implements RetentionTask {
  readonly resource = 'outbox_messages';
  private readonly prisma: PrismaClient;

  constructor({ prisma }: OutboxRetentionTaskDeps) {
    this.prisma = prisma;
  }

  async prune(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.outboxMessage.deleteMany({
      where: { publishedAt: { lt: cutoff } },
    });
    return count;
  }
}
