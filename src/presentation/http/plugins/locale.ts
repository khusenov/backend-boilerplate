import fp from 'fastify-plugin';
import fastifyAccepts from '@fastify/accepts';
import { SUPPORTED_LOCALES, type Locale } from '@/config/locales';
import { candidateOrder, pickLocale } from '@/presentation/http/locale-negotiation';
import { ACCEPT_LANGUAGE_HEADER, VARY_HEADER, withVaryValue } from '@/presentation/http/vary';

export const CONTENT_LANGUAGE_HEADER = 'content-language' as const;

declare module 'fastify' {
  interface FastifyRequest {
    locale?: Locale;
  }
}

export interface LocalePluginOptions {
  defaultLocale: Locale;
}

export const localePlugin = fp<LocalePluginOptions>(async (app, options) => {
  await app.register(fastifyAccepts);

  const candidates = candidateOrder(options.defaultLocale, SUPPORTED_LOCALES);

  app.decorateRequest('locale', options.defaultLocale);

  app.addHook('onRequest', (request, reply, done) => {
    const locale = pickLocale(request.language([...candidates]), candidates, options.defaultLocale);
    request.locale = locale;
    reply.header(CONTENT_LANGUAGE_HEADER, locale);
    done();
  });

  app.addHook('onSend', (_request, reply, _payload, done) => {
    reply.header(VARY_HEADER, withVaryValue(reply.getHeader(VARY_HEADER), ACCEPT_LANGUAGE_HEADER));
    done();
  });
});
