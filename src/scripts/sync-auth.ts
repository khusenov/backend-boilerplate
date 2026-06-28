import { createContainer, InjectionMode } from 'awilix';
import { registerDependencies } from '@/container';
import type { SyncAuthorization } from '@/application/authorization/sync-authorization';

async function main(): Promise<void> {
  const container = createContainer({ injectionMode: InjectionMode.PROXY, strict: true });
  registerDependencies(container);

  try {
    const sync = container.resolve<SyncAuthorization>('syncAuthorization');
    const result = await sync.execute();

    console.info('[sync-auth] done', result);
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
