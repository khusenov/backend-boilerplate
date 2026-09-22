import type { FastifyError } from 'fastify';
import type { $ZodIssueCode } from 'zod/v4/core';
import type { Locale } from '@/config/locales';
import type { Translator } from '@/application/shared/ports/translator';
import { validationMessageKey } from '@/shared/i18n/message-key';
import type { ValidationRule } from '@/shared/validation/validation-rule';

type SchemaValidationError = NonNullable<FastifyError['validation']>[number];

const UNKNOWN_RULE: ValidationRule = 'unknown';

const ZOD_KEYWORD_TO_RULE = {
  invalid_type: 'invalid_type',
  invalid_format: 'invalid_format',
  invalid_value: 'invalid_value',
  too_small: 'too_small',
  too_big: 'too_big',
  not_multiple_of: 'not_multiple_of',
  unrecognized_keys: 'unrecognized_keys',
  invalid_union: 'invalid_union',
  invalid_key: 'invalid_key',
  invalid_element: 'invalid_element',
  custom: 'custom',
} satisfies Record<$ZodIssueCode, ValidationRule>;

export interface ValidationFieldError {
  field: string;
  rule: ValidationRule;
  message: string;
}

export function toValidationRule(keyword: string): ValidationRule {
  return ZOD_KEYWORD_TO_RULE[keyword as $ZodIssueCode] ?? UNKNOWN_RULE;
}

export function toFieldPath(instancePath: string | undefined): string {
  return (instancePath ?? '').replace(/^\//, '').replaceAll('/', '.');
}

export function toValidationFields(
  translator: Translator,
  locale: Locale,
  issues: readonly SchemaValidationError[],
): ValidationFieldError[] {
  return issues.map((issue) => {
    const rule = toValidationRule(issue.keyword);
    return {
      field: toFieldPath(issue.instancePath),
      rule,
      message:
        translator.translate(validationMessageKey(rule), locale, issue.params) ??
        issue.message ??
        '',
    };
  });
}
