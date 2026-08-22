import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, resetDb, type TestHarness } from './support/harness';
import { authHeader, seedUser } from './support/factories';
import { StaleAggregateError } from '@/domain/shared/concurrency-errors';

const LATER = new Date('2026-09-01T00:00:00.000Z');

describe('optimistic concurrency on the user aggregate (integration)', () => {
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

  it('inserts a new user at version 1', async () => {
    const user = await seedUser(h.app);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(row.version).toBe(1);
  });

  it('increments the stored version on every accepted edit', async () => {
    const user = await seedUser(h.app);
    const auth = await authHeader(h.app, user);

    const first = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${user.id}`,
      headers: auth,
      payload: { firstName: 'First' },
    });
    const second = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${user.id}`,
      headers: auth,
      payload: { firstName: 'Second' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(row.version).toBe(3);
  });

  it('rejects the second of two writers that loaded the same version', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const first = await users.findById(seeded.id);
    const second = await users.findById(seeded.id);
    if (!first || !second) throw new Error('seeded user was not readable');

    first.changeFirstName('Winner', LATER);
    second.changeFirstName('Loser', LATER);

    await users.save(first);

    await expect(users.save(second)).rejects.toThrow(StaleAggregateError);
  });

  it('keeps the winning write intact after the losing write is rejected', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const first = await users.findById(seeded.id);
    const second = await users.findById(seeded.id);
    if (!first || !second) throw new Error('seeded user was not readable');

    first.changeFirstName('Winner', LATER);
    second.changeFirstName('Loser', LATER);

    await users.save(first);
    await expect(users.save(second)).rejects.toThrow(StaleAggregateError);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Winner');
    expect(row.version).toBe(2);
  });

  it('accepts a writer that reloads after losing', async () => {
    const seeded = await seedUser(h.app);
    const users = h.app.diContainer.cradle.userRepository;

    const winner = await users.findById(seeded.id);
    const stale = await users.findById(seeded.id);
    if (!winner || !stale) throw new Error('seeded user was not readable');

    winner.changeFirstName('Winner', LATER);
    await users.save(winner);

    stale.changeFirstName('Retrier', LATER);
    await expect(users.save(stale)).rejects.toThrow(StaleAggregateError);

    const reloaded = await users.findById(seeded.id);
    if (!reloaded) throw new Error('user vanished');
    reloaded.changeFirstName('Retrier', LATER);
    await users.save(reloaded);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Retrier');
    expect(row.version).toBe(3);
  });

  it('surfaces a real stale write over HTTP as 409 STALE_AGGREGATE', async () => {
    const seeded = await seedUser(h.app);
    const auth = await authHeader(h.app, seeded);
    const users = h.app.diContainer.cradle.userRepository;

    const stale = await users.findById(seeded.id);
    if (!stale) throw new Error('seeded user was not readable');

    const bump = await h.app.inject({
      method: 'PATCH',
      url: `/v1/users/${seeded.id}`,
      headers: auth,
      payload: { firstName: 'Winner' },
    });
    expect(bump.statusCode).toBe(200);

    const spy = vi.spyOn(users, 'findById').mockResolvedValueOnce(stale);
    try {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/v1/users/${seeded.id}`,
        headers: auth,
        payload: { firstName: 'Loser' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STALE_AGGREGATE');
    } finally {
      spy.mockRestore();
    }

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(row.firstName).toBe('Winner');
    expect(row.version).toBe(2);
  });
});
