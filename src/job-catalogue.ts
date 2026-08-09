import { EXAMPLE_JOB } from '@/application/jobs/example-job';
import { SEND_VERIFICATION_EMAIL_JOB } from '@/application/jobs/send-verification-email-job';
import { DATA_RETENTION_JOB } from '@/application/retention/enforce-data-retention-job';
import type { JobHandler } from '@/application/shared/ports/job-handler';
import { DISPATCH_DOMAIN_EVENT_JOB } from '@/infrastructure/events/dispatch-domain-event-job-handler';
import { OUTBOX_RELAY_JOB } from '@/infrastructure/events/outbox-relay';

export const JOB_NAMES = [
  EXAMPLE_JOB,
  SEND_VERIFICATION_EMAIL_JOB,
  DATA_RETENTION_JOB,
  OUTBOX_RELAY_JOB,
  DISPATCH_DOMAIN_EVENT_JOB,
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export type JobHandlersByName = {
  readonly [TJobName in JobName]: JobHandler<unknown, TJobName>;
};

export function toJobHandlerList(handlersByName: JobHandlersByName): JobHandler[] {
  return Object.values(handlersByName);
}
