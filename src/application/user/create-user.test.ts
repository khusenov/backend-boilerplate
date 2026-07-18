import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateUser } from './create-user';
import { InvalidEmailError } from '@/domain/user/email-vo';
import { EmailAlreadyTakenError } from '@/domain/user/user-errors';
import { Email } from '@/domain/user/email-vo';
import { User } from '@/domain/user/user-entity';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import type { DomainEvent } from '@/domain/shared/domain-event';
import type { TransactionContext, UnitOfWork } from '@/application/shared/ports/unit-of-work';
import type { UserRepository } from '@/domain/user/user-repository';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import type { IdGenerator } from '@/application/shared/ports/id-generator';

function makeExistingUser(): User {
  return User.create({
    id: 'user-existing',
    firstName: 'Jane',
    lastName: 'Doe',
    email: Email.create('jane@example.com'),
    passwordHash: 'hashed-pw',
  });
}

// A fake UnitOfWork whose `run` invokes the callback with a stub transaction
// context, capturing the tx-scoped save and the outbox staging as plain mocks.
// `work` is typed (not `any`) and `run` returns the callback's promise directly
// (no needless `async`), so the fake stays clean under the strict lint preset.
function makeDeps() {
  const stage = vi.fn<(events: readonly DomainEvent[]) => void>();
  const txSave = vi.fn<UserRepository['save']>().mockResolvedValue(undefined);

  const run = vi.fn((work: (context: TransactionContext) => Promise<unknown>) =>
    work({ userRepository: { save: txSave }, outbox: { stage } } as unknown as TransactionContext),
  );
  const unitOfWork = { run } as unknown as UnitOfWork;

  const findByEmail = vi.fn<UserRepository['findByEmail']>().mockResolvedValue(null);
  const hash = vi.fn<PasswordHasher['hash']>().mockResolvedValue('hashed-secret');
  const generate = vi.fn<IdGenerator['generate']>().mockReturnValue('new-user-id');

  const deps = {
    unitOfWork,
    userRepository: { findByEmail } as unknown as UserRepository,
    passwordHasher: { hash } as unknown as PasswordHasher,
    idGenerator: { generate } as unknown as IdGenerator,
  };

  return { deps, run, findByEmail, hash, generate, stage, txSave };
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
        new CreateUser(ctx.deps).execute({ ...input, email: 'not-an-email' }),
      ).rejects.toThrow(InvalidEmailError);

      expect(ctx.findByEmail).not.toHaveBeenCalled(); // Email.create throws first
    });

    it('rejects a duplicate email before hashing the password', async () => {
      ctx.findByEmail.mockResolvedValue(makeExistingUser());

      await expect(new CreateUser(ctx.deps).execute(input)).rejects.toBeInstanceOf(
        EmailAlreadyTakenError,
      );

      expect(ctx.hash).not.toHaveBeenCalled(); // no argon2 for duplicates
      expect(ctx.run).not.toHaveBeenCalled(); // never opens a transaction
    });

    it('hashes the password before persisting', async () => {
      await new CreateUser(ctx.deps).execute(input);

      expect(ctx.hash).toHaveBeenCalledOnce();
      expect(ctx.hash).toHaveBeenCalledWith(input.password);
    });

    it('generates an id for the new user', async () => {
      await new CreateUser(ctx.deps).execute(input);

      expect(ctx.generate).toHaveBeenCalledOnce();
    });

    it('saves the user through the unit of work exactly once', async () => {
      await new CreateUser(ctx.deps).execute(input);

      expect(ctx.run).toHaveBeenCalledOnce();
      expect(ctx.txSave).toHaveBeenCalledOnce();
      const [savedUser] = ctx.txSave.mock.calls[0]!;
      expect(savedUser.id).toBe('new-user-id');
    });

    it('stages the UserCreatedEvent inside the transaction', async () => {
      await new CreateUser(ctx.deps).execute(input);

      expect(ctx.stage).toHaveBeenCalledOnce();
      const [stagedEvents] = ctx.stage.mock.calls[0]!;
      expect(stagedEvents).toHaveLength(1);
      const event = stagedEvents[0];
      expect(event).toBeInstanceOf(UserCreatedEvent);
      expect((event as UserCreatedEvent).aggregateId).toBe('new-user-id');
      expect((event as UserCreatedEvent).email).toBe(input.email);
    });

    it('saves before it stages (save precedes stage within the transaction)', async () => {
      await new CreateUser(ctx.deps).execute(input);

      const saveOrder = ctx.txSave.mock.invocationCallOrder[0]!;
      const stageOrder = ctx.stage.mock.invocationCallOrder[0]!;
      expect(saveOrder).toBeLessThan(stageOrder);
    });

    it('returns a mapped UserDto on success', async () => {
      const result = await new CreateUser(ctx.deps).execute(input);

      expect(result.id).toBe('new-user-id');
      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Doe');
      expect(result.fullName).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
      expect(result.status).toBe('active');
    });
  });
});
