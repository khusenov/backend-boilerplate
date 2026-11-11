import { asClass, asValue } from 'awilix';
import { env } from '@/config/env';
import type { Locale } from '@/config/locales';
import type { Translator } from '@/application/shared/ports/translator';
import { IcuTranslator } from '@/infrastructure/i18n/icu-translator';
import type { MessageCatalogue } from '@/infrastructure/i18n/message-catalogue';
import { messageCatalogue } from '@/infrastructure/i18n/messages/catalogue';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    messageCatalogue: MessageCatalogue;
    translator: Translator;
    defaultLocale: Locale;
  }
}

export const i18nRegistrations = {
  messageCatalogue: asValue(messageCatalogue),
  translator: asClass(IcuTranslator).singleton(),
  defaultLocale: asValue(env.DEFAULT_LOCALE),
} satisfies RegistrationMap;
