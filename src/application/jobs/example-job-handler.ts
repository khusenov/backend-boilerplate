import type { JobHandler } from '@/application/shared/ports/job-handler';
import type { Logger } from '@/application/shared/ports/logger';
import { EXAMPLE_JOB, type ExampleJobPayload } from '@/application/jobs/example-job';

export interface ExampleJobHandlerDeps {
  logger: Logger;
}

export class ExampleJobHandler implements JobHandler<ExampleJobPayload, typeof EXAMPLE_JOB> {
  readonly jobName = EXAMPLE_JOB;
  private readonly logger: Logger;

  constructor({ logger }: ExampleJobHandlerDeps) {
    this.logger = logger;
  }

  handle(payload: ExampleJobPayload): Promise<void> {
    this.logger.info('Example job processed', { message: payload.message });
    return Promise.resolve();
  }
}
