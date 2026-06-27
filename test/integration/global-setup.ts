import { MariaDbContainer, StartedMariaDbContainer } from '@testcontainers/mariadb';
import type { TestProject } from 'vitest/node';
import { execSync } from 'node:child_process';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedMariaDbContainer;

export async function setup({ provide }: TestProject) {
  container = await new MariaDbContainer('mariadb:11.4').withDatabase('finflow_test').start();

  const username = container.getUsername();
  const password = container.getUserPassword();
  const host = container.getHost();
  const port = container.getPort();
  const database = container.getDatabase();

  const url = `mysql://${username}:${password}@${host}:${port}/${database}`;

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  provide('databaseUrl', url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
