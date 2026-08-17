import { MariaDbContainer, StartedMariaDbContainer } from '@testcontainers/mariadb';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { execSync } from 'node:child_process';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

let container: StartedMariaDbContainer;
let redisContainer: StartedRedisContainer;

export async function setup({ provide }: TestProject) {
  container = await new MariaDbContainer('mariadb:12.3').withDatabase('app_test').start();
  redisContainer = await new RedisContainer('redis:8.10-alpine').start();

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
  provide('redisUrl', redisContainer.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await container?.stop();
  await redisContainer?.stop();
}
