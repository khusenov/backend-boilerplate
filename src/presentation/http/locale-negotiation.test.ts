import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@/config/locales';
import { candidateOrder, pickLocale } from '@/presentation/http/locale-negotiation';

describe('candidateOrder', () => {
  it('puts the configured default first', () => {
    expect(candidateOrder('ru', SUPPORTED_LOCALES)).toEqual(['ru', 'en']);
  });

  it('does not duplicate a default that is already first', () => {
    expect(candidateOrder('en', SUPPORTED_LOCALES)).toEqual(['en', 'ru']);
  });
});

describe('pickLocale', () => {
  it('returns the negotiated locale when it is a candidate', () => {
    expect(pickLocale('ru', ['en', 'ru'], 'en')).toBe('ru');
  });

  it('returns the fallback when negotiation found nothing', () => {
    expect(pickLocale(false, ['en', 'ru'], 'en')).toBe('en');
  });

  it('returns the fallback for a value outside the candidate list', () => {
    expect(pickLocale('fr', ['en', 'ru'], 'ru')).toBe('ru');
  });
});
