import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it('trusts nothing for the literal "false"', () => {
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('trusts nothing for an empty value', () => {
    expect(parseTrustProxy('')).toBe(false);
  });

  it('trusts nothing for a whitespace-only value', () => {
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('trusts every hop for the literal "true"', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('ignores casing and surrounding whitespace', () => {
    expect(parseTrustProxy(' FALSE ')).toBe(false);
    expect(parseTrustProxy(' True ')).toBe(true);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('reads a positive integer as a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('32')).toBe(32);
  });

  it('rejects zero, which Fastify would collapse to no trust at all', () => {
    expect(() => parseTrustProxy('0')).toThrow(/hop count from 1 to 32/);
  });

  it('rejects a hop count above the supported maximum', () => {
    expect(() => parseTrustProxy('33')).toThrow(/hop count from 1 to 32/);
  });

  it('rejects a negative hop count', () => {
    expect(() => parseTrustProxy('-1')).toThrow(/hop count from 1 to 32/);
  });

  it('rejects a fractional hop count', () => {
    expect(() => parseTrustProxy('1.5')).toThrow(/hop count from 1 to 32/);
  });

  it('rejects a zero-padded hop count', () => {
    expect(() => parseTrustProxy('01')).toThrow(/hop count from 1 to 32/);
  });

  it('rejects an address list, which this grammar does not support', () => {
    expect(() => parseTrustProxy('10.0.0.0/8')).toThrow(/hop count from 1 to 32/);
  });

  it('names the offending variable and its value', () => {
    expect(() => parseTrustProxy('ture')).toThrow(/TRUST_PROXY value "ture"/);
  });
});
