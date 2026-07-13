import { describe, expect, it, vi } from 'vitest';
import { EXAMPLE_JOB } from '@/application/jobs/example-job';
import { ExampleJobHandler } from '@/application/jobs/example-job-handler';
import type { Logger } from '@/application/shared/ports/logger';

describe('ExampleJobHandler', () => {
  it('exposes the example job name', () => {
    const handler = new ExampleJobHandler({ logger: stubLogger() });
    expect(handler.jobName).toBe(EXAMPLE_JOB);
  });

  it('logs the job payload message', async () => {
    const info = vi.fn();
    const handler = new ExampleJobHandler({ logger: stubLogger({ info }) });

    await handler.handle({ message: 'ping' });

    expect(info).toHaveBeenCalledWith('Example job processed', { message: 'ping' });
  });
});

function stubLogger(overrides: Partial<Logger> = {}): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), ...overrides };
}
