import { z } from 'zod';

export const domainEventEnvelopeSchema = z.object({
  eventName: z.string().min(1),
  eventVersion: z.int().positive(),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEventEnvelope = z.infer<typeof domainEventEnvelopeSchema>;
