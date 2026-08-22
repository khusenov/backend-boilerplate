import type { FastifyBaseLogger } from 'fastify';
import type { CompleteRegistrations } from '@/composition/registration-map';
import { createPlatformRegistrations } from '@/composition/platform';
import { persistenceRegistrations } from '@/composition/persistence';
import { securityRegistrations } from '@/composition/security';
import { metricsRegistrations } from '@/composition/metrics';
import { healthRegistrations } from '@/composition/health';
import { idempotencyRegistrations } from '@/composition/idempotency';
import { emailRegistrations } from '@/composition/email';
import { jobsRegistrations } from '@/composition/jobs';
import { eventsRegistrations } from '@/composition/events';
import { userRegistrations } from '@/composition/user';
import { authRegistrations } from '@/composition/auth';
import { authorizationRegistrations } from '@/composition/authorization';
import { retentionRegistrations } from '@/composition/retention';

export function createRegistrations(baseLogger: FastifyBaseLogger): CompleteRegistrations {
  return {
    ...createPlatformRegistrations(baseLogger),
    ...persistenceRegistrations,
    ...securityRegistrations,
    ...metricsRegistrations,
    ...healthRegistrations,
    ...idempotencyRegistrations,
    ...emailRegistrations,
    ...jobsRegistrations,
    ...eventsRegistrations,
    ...userRegistrations,
    ...authRegistrations,
    ...authorizationRegistrations,
    ...retentionRegistrations,
  };
}
