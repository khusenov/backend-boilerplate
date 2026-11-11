import { describe, expect, it } from 'vitest';
import { toIcuValues } from '@/infrastructure/i18n/icu-values';

describe('toIcuValues', () => {
  it('passes strings, numbers and booleans through unchanged', () => {
    expect(toIcuValues({ id: 'u-1', count: 3, active: true })).toEqual({
      id: 'u-1',
      count: 3,
      active: true,
    });
  });

  it('passes a Date through unchanged', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');

    expect(toIcuValues({ issuedAt })).toEqual({ issuedAt });
  });

  it('converts a bigint to a number', () => {
    expect(toIcuValues({ total: 9n })).toEqual({ total: 9 });
  });

  it('drops values ICU cannot format', () => {
    expect(
      toIcuValues({
        nested: { a: 1 },
        list: [1, 2],
        nothing: null,
        missing: undefined,
        fn: () => 'x',
      }),
    ).toEqual({});
  });

  it('returns an empty record for empty params', () => {
    expect(toIcuValues({})).toEqual({});
  });
});
