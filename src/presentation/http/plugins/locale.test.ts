import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { CONTENT_LANGUAGE_HEADER, localePlugin } from '@/presentation/http/plugins/locale';
import { VARY_HEADER } from '@/presentation/http/vary';

const DEFAULT_LOCALE = 'ru';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  await app.register(localePlugin, { defaultLocale: DEFAULT_LOCALE });

  app.get('/locale', (request) => ({ locale: request.locale }));
  app.get('/pre-varied', (_request, reply) => {
    reply.header(VARY_HEADER, 'Origin');
    return { ok: true };
  });

  await app.ready();

  return app;
}

async function localeFor(app: FastifyInstance, acceptLanguage?: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/locale',
    ...(acceptLanguage !== undefined && { headers: { 'accept-language': acceptLanguage } }),
  });

  return res.json<{ locale: string }>().locale;
}

describe('localePlugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('negotiation', () => {
    it('matches a regional tag against its base language', async () => {
      expect(await localeFor(app, 'ru-RU,ru;q=0.9')).toBe('ru');
    });

    it('matches a supported locale that is not the default', async () => {
      expect(await localeFor(app, 'en-GB')).toBe('en');
    });

    it('lets q-values outrank candidate order', async () => {
      expect(await localeFor(app, 'en;q=0.9,ru;q=0.1')).toBe('en');
    });

    it('falls back to the default for an unsupported language', async () => {
      expect(await localeFor(app, 'fr')).toBe(DEFAULT_LOCALE);
    });

    it('falls back to the default when no header is sent', async () => {
      expect(await localeFor(app)).toBe(DEFAULT_LOCALE);
    });

    it('falls back to the default for a wildcard header', async () => {
      expect(await localeFor(app, '*')).toBe(DEFAULT_LOCALE);
    });

    it('falls back to the default for a malformed header', async () => {
      expect(await localeFor(app, ';;;q=')).toBe(DEFAULT_LOCALE);
    });
  });

  describe('response headers', () => {
    it('stamps Content-Language with the negotiated locale', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/locale',
        headers: { 'accept-language': 'en' },
      });

      expect(res.headers[CONTENT_LANGUAGE_HEADER]).toBe('en');
    });

    it('stamps Content-Language on a route that does not exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/nope' });

      expect(res.statusCode).toBe(404);
      expect(res.headers[CONTENT_LANGUAGE_HEADER]).toBe(DEFAULT_LOCALE);
    });

    it('adds Accept-Language to Vary', async () => {
      const res = await app.inject({ method: 'GET', url: '/locale' });

      expect(res.headers[VARY_HEADER]).toBe('Accept-Language');
    });

    it('preserves a Vary value the route already set', async () => {
      const res = await app.inject({ method: 'GET', url: '/pre-varied' });

      expect(res.headers[VARY_HEADER]).toBe('Origin, Accept-Language');
    });
  });
});
