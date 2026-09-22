import { describe, expect, it } from 'vitest';
import { ACCEPT_LANGUAGE_HEADER, withVaryValue } from '@/presentation/http/vary';

describe('withVaryValue', () => {
  it('adds the header when there is no current value', () => {
    expect(withVaryValue(undefined, ACCEPT_LANGUAGE_HEADER)).toBe('Accept-Language');
  });

  it('adds the header when the current value is empty', () => {
    expect(withVaryValue('', ACCEPT_LANGUAGE_HEADER)).toBe('Accept-Language');
  });

  it('appends to an existing value', () => {
    expect(withVaryValue('Origin', ACCEPT_LANGUAGE_HEADER)).toBe('Origin, Accept-Language');
  });

  it('does not duplicate a header that is already listed', () => {
    expect(withVaryValue('Origin, Accept-Language', ACCEPT_LANGUAGE_HEADER)).toBe(
      'Origin, Accept-Language',
    );
  });

  it('trims surrounding whitespace and drops empty entries', () => {
    expect(withVaryValue('  Origin ,, Accept-Encoding  ', ACCEPT_LANGUAGE_HEADER)).toBe(
      'Origin, Accept-Encoding, Accept-Language',
    );
  });

  it('handles the array form getHeader can return', () => {
    expect(withVaryValue(['Origin', 'Accept-Encoding'], ACCEPT_LANGUAGE_HEADER)).toBe(
      'Origin, Accept-Encoding, Accept-Language',
    );
  });

  it('handles the numeric form getHeader can return', () => {
    expect(withVaryValue(0, ACCEPT_LANGUAGE_HEADER)).toBe('0, Accept-Language');
  });
});
