import { describe, expect, it } from 'vitest';
import { UuidIdGenerator } from './uuid-id-generator';

describe('UuidIdGenerator', () => {
  const sut = new UuidIdGenerator();

  describe('generate', () => {
    it('returns a non-empty string', () => {
      expect(sut.generate()).toBeTruthy();
    });

    it('returns a valid UUIDv7 string', () => {
      expect(sut.generate()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returns unique values on successive calls', () => {
      const ids = new Set(Array.from({ length: 20 }, () => sut.generate()));
      expect(ids.size).toBe(20);
    });
  });
});
