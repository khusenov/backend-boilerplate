import type { AwilixContainer } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import { OUTBOX_RELAY_JOB, OUTBOX_RELAY_INTERVAL_MS } from '@/infrastructure/events/outbox-relay';
import {
  DATA_RETENTION_JOB,
  DATA_RETENTION_INTERVAL_MS,
} from '@/application/retention/enforce-data-retention-job';

export async function startWorker(
  container: Pick<AwilixContainer<Cradle>, 'resolve'>,
): Promise<void> {
  void container.resolve('jobWorker');
  const scheduler = container.resolve('jobScheduler');
  await scheduler.schedule(OUTBOX_RELAY_JOB, {}, { everyMs: OUTBOX_RELAY_INTERVAL_MS });
  await scheduler.schedule(DATA_RETENTION_JOB, {}, { everyMs: DATA_RETENTION_INTERVAL_MS });
}
