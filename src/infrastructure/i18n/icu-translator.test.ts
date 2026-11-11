import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Logger } from '@/application/shared/ports/logger';
import { IcuTranslator } from '@/infrastructure/i18n/icu-translator';
import type { LocaleMessages, MessageCatalogue } from '@/infrastructure/i18n/message-catalogue';
import { messageCatalogue } from '@/infrastructure/i18n/messages/catalogue';

function buildTranslator(catalogue: MessageCatalogue = messageCatalogue): {
  translator: IcuTranslator;
  logger: Logger;
} {
  const logger = mock<Logger>();

  return { translator: new IcuTranslator({ messageCatalogue: catalogue, logger }), logger };
}

function catalogueOf(en: LocaleMessages): MessageCatalogue {
  return { en, ru: {} };
}

describe('IcuTranslator', () => {
  it('returns undefined for a key the catalogue does not hold', () => {
    const { translator } = buildTranslator(catalogueOf({}));

    expect(translator.translate('error.USER_NOT_FOUND', 'en')).toBeUndefined();
  });

  it('interpolates a parameter', () => {
    const { translator } = buildTranslator();

    expect(translator.translate('error.USER_NOT_FOUND', 'en', { id: 'u-1' })).toBe(
      'No user was found for the identifier u-1.',
    );
  });

  it('applies the English one/other plural rules', () => {
    const { translator } = buildTranslator();

    expect(
      translator.translate('validation.too_small', 'en', { origin: 'string', minimum: 1 }),
    ).toBe('Must be at least 1 character long.');
    expect(
      translator.translate('validation.too_small', 'en', { origin: 'string', minimum: 8 }),
    ).toBe('Must be at least 8 characters long.');
  });

  it('applies the Russian one/few/many plural rules', () => {
    const { translator } = buildTranslator();

    expect(
      translator.translate('validation.too_small', 'ru', { origin: 'string', minimum: 1 }),
    ).toBe('Минимальная длина — 1 символ.');
    expect(
      translator.translate('validation.too_small', 'ru', { origin: 'string', minimum: 3 }),
    ).toBe('Минимальная длина — 3 символа.');
    expect(
      translator.translate('validation.too_small', 'ru', { origin: 'string', minimum: 8 }),
    ).toBe('Минимальная длина — 8 символов.');
  });

  it('degrades to undefined and warns when a required parameter is absent', () => {
    const { translator, logger } = buildTranslator();

    expect(translator.translate('error.USER_NOT_FOUND', 'en')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('message could not be formatted', {
      key: 'error.USER_NOT_FOUND',
      locale: 'en',
    });
  });

  it('compiles and reports a malformed template only once', () => {
    const { translator, logger } = buildTranslator(
      catalogueOf({ 'error.INTERNAL': 'Broken {unclosed' }),
    );

    expect(translator.translate('error.INTERNAL', 'en')).toBeUndefined();
    expect(translator.translate('error.INTERNAL', 'en')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('message template could not be compiled', {
      key: 'error.INTERNAL',
      locale: 'en',
    });
  });

  it('reads a template from the catalogue only once and reuses the formatter', () => {
    const readTemplate = vi.fn(() => 'Hello {name}.');
    const templates: Record<string, string> = {};
    const en = new Proxy(templates, {
      get: (_target, key: string | symbol) =>
        typeof key === 'string' ? readTemplate() : undefined,
    });
    const { translator } = buildTranslator(catalogueOf(en));

    expect(translator.translate('error.INTERNAL', 'en', { name: 'Ada' })).toBe('Hello Ada.');
    expect(translator.translate('error.INTERNAL', 'en', { name: 'Grace' })).toBe('Hello Grace.');
    expect(readTemplate).toHaveBeenCalledOnce();
  });

  it('keeps separate formatters per locale', () => {
    const { translator } = buildTranslator();

    expect(translator.translate('error.NOT_FOUND', 'en')).toBe(
      'The requested resource was not found.',
    );
    expect(translator.translate('error.NOT_FOUND', 'ru')).toBe('Запрашиваемый ресурс не найден.');
  });
});
