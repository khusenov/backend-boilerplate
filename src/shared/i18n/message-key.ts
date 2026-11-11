import type { ErrorCodeType } from '@/shared/errors/error-code';
import type { ValidationRule } from '@/shared/validation/validation-rule';

export type MessageKey = `error.${ErrorCodeType}` | `validation.${ValidationRule}`;

export function errorMessageKey(code: ErrorCodeType): MessageKey {
  return `error.${code}`;
}

export function validationMessageKey(rule: ValidationRule): MessageKey {
  return `validation.${rule}`;
}
