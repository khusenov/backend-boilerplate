import { DISPATCH_DOMAIN_EVENT_JOB } from './dispatch-domain-event-job-handler';
import type { DispatchDomainEventPayload } from './dispatch-domain-event-job-handler';
import type { PrismaClient } from '@/generated/prisma/client';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { JobQueue } from '@/application/shared/ports/job-queue';
import type { Clock } from '@/application/shared/ports/clock';
import type { Logger } from '@/application/shared/ports/logger';

export const OUTBOX_RELAY_JOB = 'outbox.relay';
export const OUTBOX_RELAY_INTERVAL_MS = 5_000;
const RELAY_BATCH_SIZE = 100;

interface PendingOutboxMessage {
  readonly id: string;
  readonly eventName: string;
  readonly payload: string;
}

export interface OutboxRelayDeps {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  clock: Clock;
  logger: Logger;
}

export class OutboxRelay implements JobHandler {
  readonly jobName = OUTBOX_RELAY_JOB;
  private readonly prisma: PrismaClient;
  private readonly jobQueue: JobQueue;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor({ prisma, jobQueue, clock, logger }: OutboxRelayDeps) {
    this.prisma = prisma;
    this.jobQueue = jobQueue;
    this.clock = clock;
    this.logger = logger;
  }

  async handle(): Promise<void> {
    const pending = await this.findPending();

    const publishedIds: string[] = [];
    for (const message of pending) {
      if (await this.tryRelay(message)) {
        publishedIds.push(message.id);
      }
    }

    await this.markPublished(publishedIds);
  }

  private findPending(): Promise<PendingOutboxMessage[]> {
    return this.prisma.outboxMessage.findMany({
      where: { publishedAt: null },
      orderBy: { occurredAt: 'asc' },
      take: RELAY_BATCH_SIZE,
    });
  }

  private async tryRelay(message: PendingOutboxMessage): Promise<boolean> {
    const payload: DispatchDomainEventPayload = {
      eventName: message.eventName,
      payload: message.payload,
    };
    try {
      // Rows are marked published only after a successful enqueue, so a crash in between
      // replays the batch on the next tick. The row id as deduplication key makes that
      // replay a no-op instead of a second delivery.
      await this.jobQueue.enqueue(DISPATCH_DOMAIN_EVENT_JOB, payload, {
        deduplicationKey: message.id,
      });
      return true;
    } catch (error) {
      this.reportRelayFailure(message, error);
      return false;
    }
  }

  private reportRelayFailure(message: PendingOutboxMessage, error: unknown): void {
    this.logger.error('Failed to relay outbox message', {
      outboxMessageId: message.id,
      eventName: message.eventName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.prisma.outboxMessage.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: this.clock.now() },
    });
  }
}
