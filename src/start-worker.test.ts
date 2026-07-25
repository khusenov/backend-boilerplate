import { describe, expect, it, vi } from 'vitest';
import type { AwilixContainer } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import { startWorker } from '@/start-worker';
import { OUTBOX_RELAY_JOB, OUTBOX_RELAY_INTERVAL_MS } from '@/infrastructure/events/outbox-relay';
import {
  DATA_RETENTION_JOB,
  DATA_RETENTION_INTERVAL_MS,
} from '@/application/retention/enforce-data-retention-job';

describe('startWorker', () => {
  it('starts the job worker and registers the recurring jobs', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn((name: string) => (name === 'jobScheduler' ? { schedule } : {}));
    const container = { resolve } as unknown as Pick<AwilixContainer<Cradle>, 'resolve'>;

    await startWorker(container);

    expect(resolve).toHaveBeenCalledWith('jobWorker');
    expect(schedule).toHaveBeenCalledWith(
      OUTBOX_RELAY_JOB,
      {},
      { everyMs: OUTBOX_RELAY_INTERVAL_MS },
    );
    expect(schedule).toHaveBeenCalledWith(
      DATA_RETENTION_JOB,
      {},
      { everyMs: DATA_RETENTION_INTERVAL_MS },
    );
  });
});
