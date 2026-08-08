import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoVerificationCodeService } from './crypto-verification-code-service';

// Only randomInt is faked; createHmac stays real so the hashing assertions
// exercise the actual algorithm.
const randomInt = vi.hoisted(() => vi.fn<(min: number, max: number) => number>());

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomInt,
}));

const SECRET = 'pepper-a';

function makeService(verificationCodeSecret = SECRET): CryptoVerificationCodeService {
  return new CryptoVerificationCodeService({ verificationCodeSecret });
}

describe('CryptoVerificationCodeService', () => {
  beforeEach(() => {
    randomInt.mockReset();
    randomInt.mockReturnValue(123_456);
  });

  describe('generate', () => {
    // randomInt rejection-samples over the exact range, so the code space stays
    // uniform; a modulo of a wider draw would bias the low digits.
    it('draws uniformly across the whole six-digit space', () => {
      makeService().generate();

      expect(randomInt).toHaveBeenCalledOnce();
      expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    });

    it.each([
      [0, '000000'],
      [7, '000007'],
      [420, '000420'],
      [123_456, '123456'],
      [999_999, '999999'],
    ])('renders the draw %d as %s', (draw, expected) => {
      randomInt.mockReturnValue(draw);

      expect(makeService().generate()).toBe(expected);
    });

    it('always produces exactly six digits', () => {
      const service = makeService();

      for (const draw of [0, 1, 99, 1_000, 99_999, 999_999]) {
        randomInt.mockReturnValue(draw);
        expect(service.generate()).toMatch(/^\d{6}$/);
      }
    });
  });

  describe('hash', () => {
    it('is deterministic for the same code and secret', () => {
      const service = makeService();

      expect(service.hash('123456')).toBe(service.hash('123456'));
    });

    it('produces 64 lowercase hex characters, fitting code_hash VarChar(64)', () => {
      expect(makeService().hash('123456')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs for different codes', () => {
      const service = makeService();

      expect(service.hash('123456')).not.toBe(service.hash('123457'));
    });

    // The pepper is what makes a leaked table useless: without it, all 10^6
    // digests are precomputable.
    it('differs for the same code under a different secret', () => {
      expect(makeService('pepper-a').hash('123456')).not.toBe(
        makeService('pepper-b').hash('123456'),
      );
    });

    it('never returns the plaintext code', () => {
      expect(makeService().hash('123456')).not.toBe('123456');
    });

    it('matches a known HMAC-SHA256 digest, pinning the algorithm', () => {
      expect(makeService('pepper-a').hash('123456')).toBe(
        '567d568085b75e7e1e8016b90f21f6439889f81afe3214a0926957e97b4b0aa8',
      );
    });
  });
});
