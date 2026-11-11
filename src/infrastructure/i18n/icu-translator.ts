import { IntlMessageFormat } from 'intl-messageformat';
import type { Locale } from '@/config/locales';
import type { Logger } from '@/application/shared/ports/logger';
import type { TranslationParams, Translator } from '@/application/shared/ports/translator';
import type { MessageKey } from '@/shared/i18n/message-key';
import type { MessageCatalogue } from '@/infrastructure/i18n/message-catalogue';
import { toIcuValues } from '@/infrastructure/i18n/icu-values';

interface IcuTranslatorDependencies {
  messageCatalogue: MessageCatalogue;
  logger: Logger;
}

export class IcuTranslator implements Translator {
  private readonly messageCatalogue: MessageCatalogue;
  private readonly logger: Logger;
  private readonly formatters = new Map<string, IntlMessageFormat | null>();

  constructor({ messageCatalogue, logger }: IcuTranslatorDependencies) {
    this.messageCatalogue = messageCatalogue;
    this.logger = logger;
  }

  translate(key: MessageKey, locale: Locale, params: TranslationParams = {}): string | undefined {
    const formatter = this.formatterFor(key, locale);
    if (formatter === null) return undefined;

    try {
      const formatted = formatter.format<string>(toIcuValues(params));
      return Array.isArray(formatted) ? formatted.join('') : String(formatted);
    } catch {
      this.logger.warn('message could not be formatted', { key, locale });
      return undefined;
    }
  }

  private formatterFor(key: MessageKey, locale: Locale): IntlMessageFormat | null {
    const cacheKey = `${locale}:${key}`;
    const cached = this.formatters.get(cacheKey);
    if (cached !== undefined) return cached;

    const formatter = this.compile(key, locale);
    this.formatters.set(cacheKey, formatter);
    return formatter;
  }

  private compile(key: MessageKey, locale: Locale): IntlMessageFormat | null {
    const template = this.messageCatalogue[locale][key];
    if (template === undefined) return null;

    try {
      return new IntlMessageFormat(template, locale);
    } catch {
      this.logger.warn('message template could not be compiled', { key, locale });
      return null;
    }
  }
}
