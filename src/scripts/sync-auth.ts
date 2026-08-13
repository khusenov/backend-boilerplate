import { createContainer, InjectionMode } from 'awilix';
import { registerDependencies } from '@/container';
import { createBaseLogger } from '@/infrastructure/logging/create-base-logger';
import { env } from '@/config/env';
import type { SyncAuthorization } from '@/application/authorization/sync-authorization';
import { toServiceIdentity } from '@/config/service-identity';
import { createSystemActor } from '@/domain/authorization/system-actor';

const SYNC_AUTH_ACTOR_NAME = 'sync-auth';

async function main(): Promise<void> {
  const container = createContainer({ injectionMode: InjectionMode.PROXY, strict: true });
  registerDependencies(container, createBaseLogger(env.LOG_LEVEL, toServiceIdentity(env)));

  try {
    const sync = container.resolve<SyncAuthorization>('syncAuthorization');
    const actor = createSystemActor(SYNC_AUTH_ACTOR_NAME);
    const result = await sync.execute(actor);

    console.info('[sync-auth] done', { actor: actor.name, ...result });
    if (result.permissionsRemoved.length) {
      console.warn('[sync-auth] pruned permissions no longer in the catalogue', {
        keys: result.permissionsRemoved,
      });
    }
  } finally {
    await container.dispose();
  }
}

void main().catch((error: unknown) => {
  console.error('[sync-auth] failed', error);
  process.exit(1);
});
