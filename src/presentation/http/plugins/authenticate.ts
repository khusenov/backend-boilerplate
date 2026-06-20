import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '@/shared/errors';
import type { AccessTokenPayload } from '@/application/shared/ports/access-token-service';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export const authPlugin = fp((app) => {
  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = extractBearer(request);
    if (!token) {
      throw new UnauthorizedError('Missing access token', { code: 'MISSING_ACCESS_TOKEN' });
    }
    const { accessTokenService } = request.diScope.cradle;
    request.user = await accessTokenService.verify(token);
  });
});
