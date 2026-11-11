import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { authHeader, makeSuperadmin, seedUser } from './support/factories';
import { API_V1_PREFIX } from '@/presentation/http/api-version';

interface ValidationField {
  field: string;
  rule: string;
  message: string;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { fields?: ValidationField[]; required?: string[] };
    requestId: string;
  };
}

const INVALID_REGISTRATION = {
  firstName: 'A',
  lastName: 'B',
  email: 'not-an-email',
  password: 'short',
};

function fieldNamed(body: ErrorBody, field: string): ValidationField {
  const match = body.error.details?.fields?.find((candidate) => candidate.field === field);
  if (match === undefined) throw new Error(`no field error for ${field}`);

  return match;
}

describe('localized error responses', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await resetDb(harness.prisma);
    await harness.app.close();
  });

  async function registerWith(acceptLanguage?: string) {
    return harness.app.inject({
      method: 'POST',
      url: `${API_V1_PREFIX}/auth/register`,
      payload: INVALID_REGISTRATION,
      ...(acceptLanguage !== undefined && { headers: { 'accept-language': acceptLanguage } }),
    });
  }

  it('answers a schema failure in Russian when the client asks for it', async () => {
    const res = await registerWith('ru-RU,ru;q=0.9,en;q=0.8');

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-language']).toBe('ru');
    expect(res.headers.vary).toContain('Accept-Language');

    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe('Запрос содержит некорректные данные.');
    expect(fieldNamed(body, 'email')).toEqual({
      field: 'email',
      rule: 'invalid_format',
      message: 'Значение не соответствует ожидаемому формату.',
    });
    expect(fieldNamed(body, 'password')).toEqual({
      field: 'password',
      rule: 'too_small',
      message: 'Минимальная длина — 8 символов.',
    });
  });

  it('answers the same request in the default language when no preference is sent', async () => {
    const res = await registerWith();

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-language']).toBe('en');

    const body = res.json<ErrorBody>();
    expect(body.error.message).toBe('The request contains invalid data.');
    expect(fieldNamed(body, 'email').message).toBe('This value is not in the expected format.');
    expect(fieldNamed(body, 'password').message).toBe('Must be at least 8 characters long.');
  });

  it('keeps an arbitrary details payload on a 403 through the widened response schema', async () => {
    const user = await seedUser(harness.app);
    const headers = await authHeader(harness.app, user);

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `${API_V1_PREFIX}/roles/${randomUUID()}`,
      headers,
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.details?.required).toBeDefined();
  });

  it('localizes a domain 404 that is serialized through the response schema', async () => {
    const user = await seedUser(harness.app);
    await makeSuperadmin(harness.app, user.id);
    const headers = await authHeader(harness.app, user);

    const res = await harness.app.inject({
      method: 'PATCH',
      url: `${API_V1_PREFIX}/roles/${randomUUID()}`,
      headers: { ...headers, 'accept-language': 'ru' },
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('ROLE_NOT_FOUND');
    expect(body.error.message).toMatch(/^Роль с идентификатором /);
  });
});
