import { describe, expect, it } from 'vitest';
import type { FastifyError } from 'fastify';
import type { Translator } from '@/application/shared/ports/translator';
import {
  toFieldPath,
  toValidationFields,
  toValidationRule,
} from '@/presentation/http/validation-errors';

type SchemaValidationError = NonNullable<FastifyError['validation']>[number];

const ZOD_KEYWORDS = [
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
] as const;

const EMAIL_ISSUE: SchemaValidationError = {
  instancePath: '/email',
  keyword: 'invalid_format',
  schemaPath: '#/email/invalid_format',
  params: { origin: 'string', format: 'email' },
  message: 'Invalid email address',
};

const NO_MESSAGE_ISSUE: SchemaValidationError = {
  instancePath: '/name',
  keyword: 'custom',
  schemaPath: '#/name/custom',
  params: {},
};

const nullTranslator: Translator = { translate: () => undefined };
const echoTranslator: Translator = { translate: (key) => `translated:${key}` };

describe('toValidationRule', () => {
  it.each(ZOD_KEYWORDS)('maps the Zod keyword %s to the rule of the same name', (keyword) => {
    expect(toValidationRule(keyword)).toBe(keyword);
  });

  it('maps a keyword outside the Zod taxonomy to unknown', () => {
    expect(toValidationRule('required')).toBe('unknown');
  });
});

describe('toFieldPath', () => {
  it('returns an empty path for an absent instancePath', () => {
    expect(toFieldPath(undefined)).toBe('');
  });

  it('returns an empty path for the root', () => {
    expect(toFieldPath('')).toBe('');
    expect(toFieldPath('/')).toBe('');
  });

  it('strips the leading slash', () => {
    expect(toFieldPath('/email')).toBe('email');
  });

  it('joins nested segments with dots', () => {
    expect(toFieldPath('/address/city')).toBe('address.city');
  });

  it('renders an array index as a dotted segment', () => {
    expect(toFieldPath('/tags/0')).toBe('tags.0');
  });
});

describe('toValidationFields', () => {
  it('translates each issue into a public field error', () => {
    expect(toValidationFields(echoTranslator, 'en', [EMAIL_ISSUE])).toEqual([
      {
        field: 'email',
        rule: 'invalid_format',
        message: 'translated:validation.invalid_format',
      },
    ]);
  });

  it('falls back to the raw issue message when the translator misses', () => {
    expect(toValidationFields(nullTranslator, 'en', [EMAIL_ISSUE])).toEqual([
      { field: 'email', rule: 'invalid_format', message: 'Invalid email address' },
    ]);
  });

  it('falls back to an empty message when the issue carries none', () => {
    expect(toValidationFields(nullTranslator, 'en', [NO_MESSAGE_ISSUE])).toEqual([
      { field: 'name', rule: 'custom', message: '' },
    ]);
  });

  it('maps every issue in the list', () => {
    expect(toValidationFields(nullTranslator, 'en', [EMAIL_ISSUE, NO_MESSAGE_ISSUE])).toHaveLength(
      2,
    );
  });
});
