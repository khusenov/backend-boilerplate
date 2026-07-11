import { z } from 'zod';

import { userResponse } from './user-response-schema';

/**
 * Login returns the authenticated user plus a short-lived access token. The
 * `refreshToken` is intentionally absent from the body — it is delivered as an
 * HTTP-only cookie. Reusing `userResponse` means the nested user is stripped at
 * its own level too, so `passwordHash` cannot leak even when nested.
 */
export const loginResponse = z.object({
  user: userResponse,
  accessToken: z.string(),
});

/** Refresh only mints a new access token (the rotated refresh token is a cookie). */
export const refreshResponse = z.object({
  accessToken: z.string(),
});
