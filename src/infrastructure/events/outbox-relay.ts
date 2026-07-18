import { DISPATCH_DOMAIN_EVENT_JOB } from './dispatch-domain-event-job-handler';
import type { DispatchDomainEventPayload } from './dispatch-domain-event-job-handler';
import type { PrismaClient } from '@/generated/prisma/client';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Logger } from '@/application/shared/ports/logger';

export const OUTBOX_RELAY_JOB = 'outbox.relay';
export const OUTBOX_RELAY_INTERVAL_MS = 5_000;
const RELAY_BATCH_SIZE = 100;

export interface OutboxRelayDeps {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  logger: Logger;
}

export class OutboxRelay implements JobHandler {
  readonly jobName = OUTBOX_RELAY_JOB;
  private readonly prisma: PrismaClient;
  private readonly jobQueue: JobQueue;
  private readonly logger: Logger;

  constructor({ prisma, jobQueue, logger }: OutboxRelayDeps) {
    this.prisma = prisma;
    this.jobQueue = jobQueue;
    this.logger = logger;
  }

  async handle(): Promise<void> {
    const pending = await this.prisma.outboxMessage.findMany({
      where: { publishedAt: null },
      orderBy: { occurredAt: 'asc' },
      take: RELAY_BATCH_SIZE,
    });

    const publishedIds: string[] = [];
    for (const message of pending) {
      try {
        const payload: DispatchDomainEventPayload = {
          eventName: message.eventName,
          payload: message.payload,
        };
        await this.jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, payload);
        publishedIds.push(message.id);
      } catch (error) {
        this.logger.error('Failed to relay outbox message', {
          outboxMessageId: message.id,
          eventName: message.eventName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (publishedIds.length > 0) {
      await this.prisma.outboxMessage.updateMany({
        where: { id: { in: publishedIds } },
        data: { publishedAt: new Date() },
      });
    }
  }
}
