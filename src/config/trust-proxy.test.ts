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

  it('ignores casing and surrounding whitespace on the keywords', () => {
    expect(parseTrustProxy(' FALSE ')).toBe(false);
    expect(parseTrustProxy(' True ')).toBe(true);
  });

  it('passes a single address through for Fastify to compile', () => {
    expect(parseTrustProxy('10.0.0.1')).toBe('10.0.0.1');
  });

  it('passes a CIDR block through', () => {
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('passes a named range through', () => {
    expect(parseTrustProxy('uniquelocal')).toBe('uniquelocal');
  });

  it('passes a comma-separated list through', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });

  it('preserves address casing, which IPv6 notation depends on', () => {
    expect(parseTrustProxy('FD00::/8')).toBe('FD00::/8');
  });

  it('rejects a hop count, which cannot verify the immediate peer', () => {
    expect(() => parseTrustProxy('1')).toThrow(/hop count cannot verify the immediate peer/);
  });

  it('rejects zero, padded, negative and fractional hop counts alike', () => {
    for (const value of ['0', '01', '-1', '1.5', '33']) {
      expect(() => parseTrustProxy(value)).toThrow(/hop count cannot verify the immediate peer/);
    }
  });

  it('names the offending variable and its value', () => {
    expect(() => parseTrustProxy('2')).toThrow(/TRUST_PROXY value "2"/);
  });

  it('lists the accepted forms so the message is actionable', () => {
    expect(() => parseTrustProxy('1')).toThrow(/loopback.*linklocal.*uniquelocal/);
  });
});
