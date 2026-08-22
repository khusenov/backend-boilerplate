import { InjectionMode, createContainer, type AwilixContainer } from 'awilix';
import type { Cradle } from '@fastify/awilix';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { registerDependencies } from '@/container';
import { createPlatformRegistrations } from '@/composition/platform';
import { persistenceRegistrations } from '@/composition/persistence';
import { securityRegistrations } from '@/composition/security';
import { metricsRegistrations } from '@/composition/metrics';
import { healthRegistrations } from '@/composition/health';
import { idempotencyRegistrations } from '@/composition/idempotency';
import { emailRegistrations } from '@/composition/email';
import { jobsRegistrations } from '@/composition/jobs';
import { eventsRegistrations } from '@/composition/events';
import { userRegistrations } from '@/composition/user';
import { authRegistrations } from '@/composition/auth';
import { authorizationRegistrations } from '@/composition/authorization';
import { retentionRegistrations } from '@/composition/retention';

const DISPOSABLE_KEYS = [
  'dashboardQueue',
  'healthCheckRedisConnection',
  'idempotencyRedis',
  'jobQueue',
  'jobScheduler',
  'jobWorker',
  'prisma',
  'rateLimitRedis',
];

const CONFIG_BACKED_KEYS = [
  'verificationCodeService',
  'emailSender',
  'domainEventSerializer',
] as const;

function moduleKeys(): string[] {
  return [
    createPlatformRegistrations(mock<FastifyBaseLogger>()),
    persistenceRegistrations,
    securityRegistrations,
    metricsRegistrations,
    healthRegistrations,
    idempotencyRegistrations,
    emailRegistrations,
    jobsRegistrations,
    eventsRegistrations,
    userRegistrations,
    authRegistrations,
    authorizationRegistrations,
    retentionRegistrations,
  ].flatMap((registrations) => Object.keys(registrations));
}

function duplicatesIn(keys: string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) {
      duplicated.add(key);
    }
    seen.add(key);
  }

  return [...duplicated].sort();
}

function buildContainer(): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  registerDependencies(container, mock<FastifyBaseLogger>());
  return container;
}

describe('composition modules', () => {
  it('claims each cradle key exactly once', () => {
    expect(duplicatesIn(moduleKeys())).toEqual([]);
  });

  it('registers the same key set the container ends up with', () => {
    const container = buildContainer();

    expect(moduleKeys().sort()).toEqual(Object.keys(container.registrations).sort());
  });

  it('keeps a disposer on every registration that owns a connection', () => {
    const container = buildContainer();

    const disposable = Object.entries(container.registrations)
      .filter(([, resolver]) => 'dispose' in resolver)
      .map(([key]) => key)
      .sort();

    expect(disposable).toEqual(expect.arrayContaining(DISPOSABLE_KEYS));
  });

  it('builds the config-backed registrations that asClass would break', () => {
    const container = buildContainer();

    for (const key of CONFIG_BACKED_KEYS) {
      expect(() => container.resolve(key)).not.toThrow();
    }
  });

  it('resolves metricsExposition to the metricsRecorder instance', () => {
    const container = buildContainer();

    expect(container.resolve('metricsExposition')).toBe(container.resolve('metricsRecorder'));
  });
});
