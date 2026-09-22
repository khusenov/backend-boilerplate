import type { Locale } from '@/config/locales';
import type { MessageKey } from '@/shared/i18n/message-key';

export type TranslationParams = Readonly<Record<string, unknown>>;

export interface Translator {
  translate(key: MessageKey, locale: Locale, params?: TranslationParams): string | undefined;
}
