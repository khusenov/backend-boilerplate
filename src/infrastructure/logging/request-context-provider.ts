import { requestContext } from '@fastify/request-context';
import type { ContextData, ContextProvider } from '@/application/shared/ports/context-provider';

export class RequestContextProvider implements ContextProvider {
  getAll(): Partial<ContextData> {
    return requestContext.get('contextData') ?? {};
  }
}
