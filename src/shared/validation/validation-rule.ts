export const VALIDATION_RULES = [
  'invalid_type',
  'invalid_format',
  'invalid_value',
  'too_small',
  'too_big',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'custom',
  'unknown',
] as const;

export type ValidationRule = (typeof VALIDATION_RULES)[number];
