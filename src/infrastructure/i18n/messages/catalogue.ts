import type { Locale } from '@/config/locales';
import type { LocaleMessages } from '@/infrastructure/i18n/message-catalogue';
import { enMessages } from '@/infrastructure/i18n/messages/en';
import { ruMessages } from '@/infrastructure/i18n/messages/ru';

export const messageCatalogue = {
  en: enMessages,
  ru: ruMessages,
} satisfies Record<Locale, LocaleMessages>;
