import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import {
  DATA_RETENTION_JOB,
  EnforceDataRetentionJob,
} from '@/application/retention/enforce-data-retention-job';
import type { RetentionTask } from '@/application/shared/ports/retention-task';
import type { Clock } from '@/application/shared/ports/clock';
import type { Logger } from '@/application/shared/ports/logger';

const WINDOW_MS = 1_000;
const NOW = new Date('2026-07-21T00:00:00.000Z');
const EXPECTED_CUTOFF = new Date(NOW.getTime() - WINDOW_MS);

function fakeTask(resource: string, prune = vi.fn().mockResolvedValue(0)) {
  const task: RetentionTask = { resource, prune };
  return { task, prune };
}

function makeJob(tasks: RetentionTask[]) {
  const logger = mock<Logger>();
  const clock = { now: () => NOW } satisfies Clock;

  const job = new EnforceDataRetentionJob({
    retentionTasks: tasks,
    dataRetentionWindowMs: WINDOW_MS,
    clock,
    logger,
  });
  return { job, logger };
}

describe('EnforceDataRetentionJob', () => {
  it('exposes the data-retention job name', () => {
    const { job } = makeJob([]);
    expect(job.jobName).toBe(DATA_RETENTION_JOB);
  });

  it('prunes every task with the cutoff derived from now minus the retention window', async () => {
    const outbox = fakeTask('outbox_messages');
    const tokens = fakeTask('refresh_tokens');
    const { job } = makeJob([outbox.task, tokens.task]);

    await job.handle();

    expect(outbox.prune).toHaveBeenCalledWith(EXPECTED_CUTOFF);
    expect(tokens.prune).toHaveBeenCalledWith(EXPECTED_CUTOFF);
  });

  it('logs the deleted count for each pruned resource', async () => {
    const outbox = fakeTask('outbox_messages', vi.fn().mockResolvedValue(7));
    const { job, logger } = makeJob([outbox.task]);

    await job.handle();

    expect(logger.info).toHaveBeenCalledWith('Pruned expired records', {
      resource: 'outbox_messages',
      deleted: 7,
      cutoff: EXPECTED_CUTOFF,
    });
  });

  it('keeps pruning remaining resources when a task throws an Error, logging its message', async () => {
    const failing = fakeTask('outbox_messages', vi.fn().mockRejectedValue(new Error('db down')));
    const healthy = fakeTask('refresh_tokens');
    const { job, logger } = makeJob([failing.task, healthy.task]);

    await job.handle();

    expect(healthy.prune).toHaveBeenCalledWith(EXPECTED_CUTOFF);
    expect(logger.error).toHaveBeenCalledWith('Failed to prune expired records', {
      resource: 'outbox_messages',
      error: 'db down',
    });
  });

  it('stringifies a non-Error rejection when logging a prune failure', async () => {
    const failing = fakeTask('outbox_messages', vi.fn().mockRejectedValue('boom'));
    const { job, logger } = makeJob([failing.task]);

    await job.handle();

    expect(logger.error).toHaveBeenCalledWith('Failed to prune expired records', {
      resource: 'outbox_messages',
      error: 'boom',
    });
  });

  it('does nothing when no retention tasks are registered', async () => {
    const { job, logger } = makeJob([]);

    await job.handle();

    expect(logger.info).not.toHaveBeenCalled();
  });
});
