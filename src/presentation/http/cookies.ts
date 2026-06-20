import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Env } from '@/config/env';

export const REFRESH_COOKIE = 'refreshToken';

function baseOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/auth',
    signed: env.COOKIE_SECRET.length > 0,
  };
}

export function setRefreshCookie(reply: FastifyReply, token: string, env: Env): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    ...baseOptions(env),
    maxAge: env.REFRESH_TOKEN_TTL,
  });
}

export function clearRefreshCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(REFRESH_COOKIE, baseOptions(env));
}

export function readRefreshCookie(request: FastifyRequest, env: Env): string | undefined {
  const raw = request.cookies[REFRESH_COOKIE];
  if (!raw) return undefined;
  if (!env.COOKIE_SECRET) return raw;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}
