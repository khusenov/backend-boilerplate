import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { FALLBACK_LOCALE, SUPPORTED_LOCALES, type Locale } from '@/config/locales';
import type { MessageCatalogue } from '@/infrastructure/i18n/message-catalogue';
import { messageCatalogue } from '@/infrastructure/i18n/messages/catalogue';

interface AstNode {
  type: number;
  value?: unknown;
  options?: Record<string, { value: AstNode[] }>;
  children?: AstNode[];
}

const catalogue: MessageCatalogue = messageCatalogue;
const MESSAGE_KEYS = Object.keys(messageCatalogue[FALLBACK_LOCALE]).sort();
const LOCALES = [...SUPPORTED_LOCALES];

function astOf(template: string, locale: Locale): AstNode[] {
  return new IntlMessageFormat(template, locale).getAst();
}

const [literalNode] = astOf('literal', FALLBACK_LOCALE);
const LITERAL_TYPE = literalNode?.type;

function argumentNames(ast: readonly AstNode[]): string[] {
  const names = new Set<string>();

  for (const node of ast) {
    if (node.type !== LITERAL_TYPE && typeof node.value === 'string') names.add(node.value);
    for (const option of Object.values(node.options ?? {})) {
      for (const name of argumentNames(option.value)) names.add(name);
    }
    for (const name of argumentNames(node.children ?? [])) names.add(name);
  }

  return [...names].sort();
}

function templateOf(locale: Locale, key: string): string {
  const template = catalogue[locale][key];
  if (template === undefined) throw new Error(`${locale} has no message for ${key}`);

  return template;
}

describe('messageCatalogue', () => {
  it.each(LOCALES)('defines exactly the shared key set in %s', (locale) => {
    expect(Object.keys(catalogue[locale]).sort()).toEqual(MESSAGE_KEYS);
  });

  it.each(LOCALES)('compiles every %s template', (locale) => {
    for (const key of MESSAGE_KEYS) {
      expect(() => astOf(templateOf(locale, key), locale)).not.toThrow();
    }
  });

  it.each(LOCALES)('declares the same ICU arguments in %s as the fallback locale', (locale) => {
    for (const key of MESSAGE_KEYS) {
      expect(argumentNames(astOf(templateOf(locale, key), locale))).toEqual(
        argumentNames(astOf(templateOf(FALLBACK_LOCALE, key), FALLBACK_LOCALE)),
      );
    }
  });
});
