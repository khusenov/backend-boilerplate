import type { ContextData } from '@/application/shared/ports/context-provider';

declare module '@fastify/request-context' {
  interface RequestContextData {
    contextData: Partial<ContextData>;
  }
}
