import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { EXAMPLE_JOB } from '@/application/jobs/example-job';
import { ExampleJobHandler } from '@/application/jobs/example-job-handler';
import type { Logger } from '@/application/shared/ports/logger';

describe('ExampleJobHandler', () => {
  it('exposes the example job name', () => {
    const handler = new ExampleJobHandler({ logger: mock<Logger>() });
    expect(handler.jobName).toBe(EXAMPLE_JOB);
  });

  it('logs the job payload message', async () => {
    const logger = mock<Logger>();
    const handler = new ExampleJobHandler({ logger });

    await handler.handle({ message: 'ping' });

    expect(logger.info).toHaveBeenCalledWith('Example job processed', { message: 'ping' });
  });
});
