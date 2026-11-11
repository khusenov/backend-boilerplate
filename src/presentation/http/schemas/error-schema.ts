import { z } from 'zod';
import { VALIDATION_RULES } from '@/shared/validation/validation-rule';

export const validationFieldError = z.object({
  field: z.string(),
  rule: z.enum(VALIDATION_RULES),
  message: z.string(),
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .union([
        z.object({ fields: z.array(validationFieldError) }),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
    requestId: z.string(),
  }),
});
