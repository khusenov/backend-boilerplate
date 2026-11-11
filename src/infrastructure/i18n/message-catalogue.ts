import type { Locale } from '@/config/locales';

export type LocaleMessages = Readonly<Record<string, string | undefined>>;

export type MessageCatalogue = Readonly<Record<Locale, LocaleMessages>>;
