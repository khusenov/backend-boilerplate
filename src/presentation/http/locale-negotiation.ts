import type { Locale } from '@/config/locales';

export function candidateOrder(
  defaultLocale: Locale,
  supportedLocales: readonly Locale[],
): Locale[] {
  return [defaultLocale, ...supportedLocales.filter((locale) => locale !== defaultLocale)];
}

export function pickLocale(
  negotiated: string | false,
  candidates: readonly Locale[],
  fallback: Locale,
): Locale {
  return candidates.find((candidate) => candidate === negotiated) ?? fallback;
}
