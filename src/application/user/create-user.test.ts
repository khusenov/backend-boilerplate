import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { CreateUser } from './create-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import { makeUser } from '@test/unit/support/builders';
import { makeFixedClock, makeUnitOfWork } from '@test/unit/support/fakes';
import { createUserActor } from '@/domain/authorization/actor';
import { PermissionDeniedError } from '@/domain/authorization/access-policy-errors';
import { PERMISSIONS } from '@/domain/authorization/permission-catalogue';

const ACTOR = createUserActor({
  userId: 'actor-1',
  systemRoleKeys: [],
  permissions: [PERMISSIONS.UsersCreate.key],
});

const UNPRIVILEGED_ACTOR = createUserActor({
  userId: 'actor-2',
  systemRoleKeys: [],
  permissions: [],
});

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeDeps() {
  const { unitOfWork, context } = makeUnitOfWork();
  context.userRepository.save.mockResolvedValue(undefined);

  const userRepository = mock<UserRepository>();
  userRepository.findByEmail.mockResolvedValue(null);

  const passwordHasher = mock<PasswordHasher>();
  passwordHasher.hash.mockResolvedValue('hashed-secret');

  const idGenerator = mock<IdGenerator>();
  idGenerator.generate.mockReturnValue('new-user-id');

  const clock = makeFixedClock(NOW);

  const deps = { unitOfWork, userRepository, passwordHasher, idGenerator, clock };

  return { deps, tx: context };
}

const input = {
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  password: 'Str0ng!Pass',
};

describe('CreateUser', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  describe('execute', () => {
    it('throws InvalidEmailError for a malformed email before touching any collaborator', async () => {
      await expect(
        new CreateUser(ctx.deps).execute({ ...input, email: 'not-an-email' }, ACTOR),
      ).rejects.toThrow(InvalidEmailError);

      expect(ctx.deps.userRepository.findByEmail).not.toHaveBeenCalled(); // Email.create throws first
    });

    it('rejects a duplicate email before hashing the password', async () => {
      ctx.deps.userRepository.findByEmail.mockResolvedValue(makeUser({ id: 'user-existing' }));

      await expect(new CreateUser(ctx.deps).execute(input, ACTOR)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.deps.passwordHasher.hash).not.toHaveBeenCalled(); // no argon2 for duplicates
      expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled(); // never opens a transaction
    });

    it('hashes the password before persisting', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      expect(ctx.deps.passwordHasher.hash).toHaveBeenCalledOnce();
      expect(ctx.deps.passwordHasher.hash).toHaveBeenCalledWith(input.password);
    });

    it('generates an id for the new user', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      expect(ctx.deps.idGenerator.generate).toHaveBeenCalledOnce();
    });

    it('saves the user through the unit of work exactly once', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      expect(ctx.deps.unitOfWork.run).toHaveBeenCalledOnce();
      expect(ctx.tx.userRepository.save).toHaveBeenCalledOnce();
      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.id).toBe('new-user-id');
    });

    it('stamps the user from a single clock reading', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      expect(savedUser.createdAt).toEqual(NOW);
      expect(savedUser.updatedAt).toEqual(NOW);
      expect(ctx.deps.clock.now).toHaveBeenCalledOnce();
    });

    it('stages the UserCreatedEvent inside the transaction', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      expect(ctx.tx.outbox.stage).toHaveBeenCalledOnce();
      const [stagedEvents] = ctx.tx.outbox.stage.mock.calls[0]!;
      expect(stagedEvents).toHaveLength(1);
      const event = stagedEvents[0];
      expect(event).toBeInstanceOf(UserCreatedEvent);
      expect((event as UserCreatedEvent).aggregateId).toBe('new-user-id');
      expect((event as UserCreatedEvent).email).toBe(input.email);
    });

    it('stages an event whose occurredAt matches the saved user createdAt', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      const [savedUser] = ctx.tx.userRepository.save.mock.calls[0]!;
      const [stagedEvents] = ctx.tx.outbox.stage.mock.calls[0]!;
      expect(stagedEvents[0]!.occurredAt).toEqual(savedUser.createdAt);
    });

    it('saves before it stages (save precedes stage within the transaction)', async () => {
      await new CreateUser(ctx.deps).execute(input, ACTOR);

      const saveOrder = ctx.tx.userRepository.save.mock.invocationCallOrder[0]!;
      const stageOrder = ctx.tx.outbox.stage.mock.invocationCallOrder[0]!;
      expect(saveOrder).toBeLessThan(stageOrder);
    });

    it('returns a mapped UserDto on success', async () => {
      const result = await new CreateUser(ctx.deps).execute(input, ACTOR);

      expect(result.id).toBe('new-user-id');
      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Doe');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe('active');
    });
  });
});

describe('CreateUser authorization', () => {
  it('denies a caller without users.create before touching any collaborator', async () => {
    const ctx = makeDeps();

    await expect(new CreateUser(ctx.deps).execute(input, UNPRIVILEGED_ACTOR)).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(ctx.deps.userRepository.findByEmail).not.toHaveBeenCalled();
    expect(ctx.deps.unitOfWork.run).not.toHaveBeenCalled();
  });
});
