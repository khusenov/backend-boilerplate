import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import { OutboxRelay } from '@/infrastructure/events/outbox-relay';
import {
  DispatchDomainEventJobHandler,
  DISPATCH_DOMAIN_EVENT_JOB,
} from '@/infrastructure/events/dispatch-domain-event-job-handler';
import { DomainEventSerializer } from '@/infrastructure/events/domain-event-serializer';
import { DomainEventHandlerRegistry } from '@/infrastructure/events/domain-event-handler-registry';
import { domainEventFactories } from '@/infrastructure/events/domain-event-factories';
import { BullMqJobQueue } from '@/infrastructure/jobs/bullmq-job-queue';
import { JobWorker } from '@/infrastructure/jobs/job-worker';
import type { Logger } from '@/application/shared/ports/logger';

const noopLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('outbox (integration)', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
  });

  afterEach(async () => {
    await resetDb(h.prisma);
  });

  describe('transactional write', () => {
    it('writes exactly one unpublished outbox row when a user is created', async () => {
      await h.app.diContainer.cradle.createUser.execute({
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@finflow.test',
        password: 'password123',
      });

      const rows = await h.prisma.outboxMessage.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventName: UserCreatedEvent.EVENT_NAME,
        publishedAt: null,
      });
      expect(rows[0]!.aggregateId).toBeTruthy();
    });

    it('rolls back the outbox row when the transaction fails (atomic write)', async () => {
      const { unitOfWork, idGenerator, clock } = h.app.diContainer.cradle;
      const user = User.create(
        {
          id: idGenerator.generate(),
          firstName: 'Rollback',
          lastName: 'User',
          email: Email.create('rollback@finflow.test'),
          passwordHash: 'hashed',
        },
        clock.now(),
      );

      await expect(
        unitOfWork.run(async ({ userRepository, outbox }) => {
          await userRepository.save(user);
          outbox.stage(user.pullDomainEvents());
          throw new Error('forced failure inside the transaction');
        }),
      ).rejects.toThrow('forced failure');

      expect(await h.prisma.outboxMessage.count()).toBe(0);
      expect(await h.prisma.user.count()).toBe(0);
    });
  });

  describe('relay (BullMQ)', () => {
    let container: StartedRedisContainer;
    let redisUrl: string;

    beforeAll(async () => {
      container = await new RedisContainer('redis:7.4-alpine').start();
      redisUrl = container.getConnectionUrl();
    });

    afterAll(async () => {
      await container?.stop();
    });

    it('drains unpublished rows once: enqueues a dispatch job, marks them published, then no-ops', async () => {
      const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new BullMqJobQueue({ connection, queuePrefix: 'test-outbox-drain' });
      const enqueueSpy = vi.spyOn(queue, 'enqueue');
      const relay = new OutboxRelay({
        prisma: h.prisma,
        jobQueue: queue,
        clock: h.app.diContainer.cradle.clock,
        logger: noopLogger,
      });

      await h.app.diContainer.cradle.createUser.execute({
        firstName: 'Relay',
        lastName: 'Target',
        email: 'relay@finflow.test',
        password: 'password123',
      });

      await relay.handle();

      expect(enqueueSpy).toHaveBeenCalledOnce();
      expect(enqueueSpy).toHaveBeenCalledWith(
        DISPATCH_DOMAIN_EVENT_JOB,
        expect.objectContaining({ eventName: UserCreatedEvent.EVENT_NAME }),
      );
      const [relayed] = await h.prisma.outboxMessage.findMany();
      expect(relayed!.publishedAt).not.toBeNull();

      // Second drain finds nothing unpublished — idempotent, enqueues nothing more.
      enqueueSpy.mockClear();
      await relay.handle();
      expect(enqueueSpy).not.toHaveBeenCalled();

      await queue.close();
    });

    it('delivers a created user event end-to-end: create -> relay -> worker -> handler', async () => {
      const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new BullMqJobQueue({
        connection: queueConnection,
        queuePrefix: 'test-outbox-e2e',
      });

      let resolveHandled!: (event: UserCreatedEvent) => void;
      const handled = new Promise<UserCreatedEvent>((resolve) => {
        resolveHandled = resolve;
      });

      // Drive the real registered handler through the worker; observe it fire.
      const logHandler = h.app.diContainer.cradle.userCreatedLogHandler;
      const handleSpy = vi.spyOn(logHandler, 'handle').mockImplementation((event) => {
        resolveHandled(event as UserCreatedEvent);
        return Promise.resolve();
      });

      const registry = new DomainEventHandlerRegistry({ handlers: [logHandler] });
      const dispatchHandler = new DispatchDomainEventJobHandler({
        domainEventSerializer: new DomainEventSerializer({ factories: domainEventFactories }),
        domainEventHandlerRegistry: registry,
      });
      const worker = new JobWorker({
        connection: workerConnection,
        queuePrefix: 'test-outbox-e2e',
        concurrency: 1,
        handlers: [dispatchHandler],
        logger: noopLogger,
      });
      const relay = new OutboxRelay({
        prisma: h.prisma,
        jobQueue: queue,
        clock: h.app.diContainer.cradle.clock,
        logger: noopLogger,
      });

      try {
        await h.app.diContainer.cradle.createUser.execute({
          firstName: 'End',
          lastName: 'ToEnd',
          email: 'e2e@finflow.test',
          password: 'password123',
        });
        await relay.handle();

        const event = await handled;
        expect(event).toBeInstanceOf(UserCreatedEvent);
        expect(event.email).toBe('e2e@finflow.test');
      } finally {
        handleSpy.mockRestore();
        await worker.close();
        await queue.close();
      }
    });
  });
});
