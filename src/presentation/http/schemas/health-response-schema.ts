import { z } from 'zod';

/**
 * The probe bodies are fixed single-word statuses, so `z.literal(...)` documents
 * each one exactly in the OpenAPI spec. Liveness answers `ok`; readiness answers
 * `ready` (200) or `unavailable` (503, sent directly by the handler — not an
 * error-handler body, hence its own schema rather than `errorResponse`).
 */
export const livenessResponse = z.object({ status: z.literal('ok') });
export const readinessResponse = z.object({ status: z.literal('ready') });
export const readinessUnavailableResponse = z.object({ status: z.literal('unavailable') });
