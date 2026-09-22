import type { AppError, SerializedError } from '@/shared/errors';

export const INTERNAL_FALLBACK_MESSAGE = 'Internal Server Error';

export function publicErrorBody(error: AppError): SerializedError {
  if (error.isOperational) return error.toJSON();
  return { code: error.code, message: INTERNAL_FALLBACK_MESSAGE };
}
