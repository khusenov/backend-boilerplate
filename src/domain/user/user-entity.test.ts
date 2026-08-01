import { User, UserStatus } from './user-entity';
import { Email } from './email-vo';
import { UserInvalidNameError, UserDeletedError } from './user-errors';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';
import { describe, expect, it } from 'vitest';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:00:01.000Z');

function makeUser(overrides: Partial<Parameters<typeof User.create>[0]> = {}): User {
  return User.create(
    {
      id: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: Email.create('ada@example.com'),
      passwordHash: 'hashed-password',
      ...overrides,
    },
    BASE_TIME,
  );
}

describe('User', () => {
  describe('create', () => {
    it('creates an active user with normalized names', () => {
      const user = makeUser({ firstName: '  Ada  ', lastName: '  Lovelace  ' });

      expect(user.firstName).toBe('Ada');
      expect(user.lastName).toBe('Lovelace');
      expect(user.fullName).toBe('Ada Lovelace');
      expect(user.status).toBe(UserStatus.Active);
      expect(user.isActive).toBe(true);
      expect(user.isDeleted).toBe(false);
      expect(user.deletedAt).toBeNull();
      expect(user.createdAt).toEqual(BASE_TIME);
      expect(user.createdAt).toEqual(user.updatedAt);
    });

    it.each(['', '   '])('throws when firstName is %j', (firstName) => {
      expect(() => makeUser({ firstName })).toThrow(UserInvalidNameError);
    });

    it.each(['', '   '])('throws when lastName is %j', (lastName) => {
      expect(() => makeUser({ lastName })).toThrow(UserInvalidNameError);
    });
  });

  describe('domain events', () => {
    it('records exactly one UserCreatedEvent on create', () => {
      const user = makeUser({ id: 'user-42', email: Email.create('ada@example.com') });

      const [event, ...rest] = user.pullDomainEvents();

      expect(rest).toHaveLength(0);
      expect(event).toBeInstanceOf(UserCreatedEvent);
      const created = event as UserCreatedEvent;
      expect(created.aggregateId).toBe('user-42');
      expect(created.eventName).toBe(UserCreatedEvent.EVENT_NAME);
      expect(created.email).toBe('ada@example.com');
    });

    it('stamps the event with the same instant as createdAt and updatedAt', () => {
      const user = makeUser();

      const [event] = user.pullDomainEvents();

      expect(event?.occurredAt).toEqual(user.createdAt);
      expect(event?.occurredAt).toEqual(user.updatedAt);
    });

    it('clears the buffer after pullDomainEvents (pull semantics)', () => {
      const user = makeUser();

      expect(user.pullDomainEvents()).toHaveLength(1);
      expect(user.pullDomainEvents()).toEqual([]);
    });

    it('records no events when hydrating from persistence', () => {
      const user = User.hydrate({
        id: 'user-2',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: Email.create('grace@example.com'),
        passwordHash: 'stored-hash',
        status: UserStatus.Inactive,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        deletedAt: null,
      });

      expect(user.pullDomainEvents()).toEqual([]);
    });
  });

  describe('hydrate', () => {
    it('reconstructs a user from stored props without normalizing', () => {
      const createdAt = new Date('2025-01-01T00:00:00.000Z');
      const deletedAt = new Date('2025-07-01T00:00:00.000Z');

      const user = User.hydrate({
        id: 'user-2',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: Email.create('grace@example.com'),
        passwordHash: 'stored-hash',
        status: UserStatus.Inactive,
        createdAt,
        updatedAt: createdAt,
        deletedAt,
      });

      expect(user.isActive).toBe(false);
      expect(user.isDeleted).toBe(true);
      expect(user.createdAt).toBe(createdAt);
      expect(user.deletedAt).toBe(deletedAt);
    });
  });

  describe('activate', () => {
    it('activates an inactive user and sets updatedAt to the supplied instant', () => {
      const user = makeUser();
      user.deactivate(BASE_TIME);

      user.activate(LATER);

      expect(user.isActive).toBe(true);
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the user is already active', () => {
      const user = makeUser();
      const before = user.updatedAt;

      user.activate(LATER);

      expect(user.updatedAt).toBe(before);
    });

    it('throws when the user is deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      expect(() => user.activate(LATER)).toThrow(UserDeletedError);
    });
  });

  describe('deactivate', () => {
    it('deactivates an active user and sets updatedAt to the supplied instant', () => {
      const user = makeUser();

      user.deactivate(LATER);

      expect(user.isActive).toBe(false);
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the user is already inactive', () => {
      const user = makeUser();
      user.deactivate(BASE_TIME);
      const before = user.updatedAt;

      user.deactivate(LATER);

      expect(user.updatedAt).toBe(before);
    });

    it('throws when the user is deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      expect(() => user.deactivate(LATER)).toThrow(UserDeletedError);
    });
  });

  describe('changeFirstName', () => {
    it('updates the name and sets updatedAt to the supplied instant', () => {
      const user = makeUser();

      user.changeFirstName('  Augusta  ', LATER);

      expect(user.firstName).toBe('Augusta');
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the normalized name is unchanged', () => {
      const user = makeUser({ firstName: 'Ada' });
      const before = user.updatedAt;

      user.changeFirstName('  Ada  ', LATER);

      expect(user.updatedAt).toBe(before);
    });

    it('throws for a blank name', () => {
      expect(() => makeUser().changeFirstName('   ', LATER)).toThrow(UserInvalidNameError);
    });

    it('throws when the user is deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      expect(() => user.changeFirstName('Augusta', LATER)).toThrow(UserDeletedError);
    });
  });

  describe('changeLastName', () => {
    it('updates the name and sets updatedAt to the supplied instant', () => {
      const user = makeUser();

      user.changeLastName('  Byron  ', LATER);

      expect(user.lastName).toBe('Byron');
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the normalized name is unchanged', () => {
      const user = makeUser({ lastName: 'Lovelace' });
      const before = user.updatedAt;

      user.changeLastName('  Lovelace  ', LATER);

      expect(user.updatedAt).toBe(before);
    });

    it('throws for a blank name', () => {
      expect(() => makeUser().changeLastName('   ', LATER)).toThrow(UserInvalidNameError);
    });

    it('throws when the user is deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      expect(() => user.changeLastName('Byron', LATER)).toThrow(UserDeletedError);
    });
  });

  describe('changeEmail', () => {
    it('updates the email and sets updatedAt to the supplied instant', () => {
      const user = makeUser();

      user.changeEmail(Email.create('new@example.com'), LATER);

      expect(user.email.value).toBe('new@example.com');
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the email resolves to the same value', () => {
      const user = makeUser({ email: Email.create('ada@example.com') });
      const before = user.updatedAt;

      user.changeEmail(Email.create('ADA@example.com'), LATER);

      expect(user.updatedAt).toBe(before);
    });

    it('throws when the user is deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      expect(() => user.changeEmail(Email.create('new@example.com'), LATER)).toThrow(
        UserDeletedError,
      );
    });
  });

  describe('softDelete', () => {
    it('marks the user deleted and deactivates it with one shared instant', () => {
      const user = makeUser();

      user.softDelete(LATER);

      expect(user.isDeleted).toBe(true);
      expect(user.isActive).toBe(false);
      expect(user.deletedAt).toEqual(LATER);
      expect(user.updatedAt).toEqual(LATER);
    });

    it('is a no-op when the user is already deleted', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);
      const deletedAt = user.deletedAt;

      user.softDelete(LATER);

      expect(user.deletedAt).toBe(deletedAt);
    });
  });

  describe('restore', () => {
    it('clears deletedAt but leaves the user inactive', () => {
      const user = makeUser();
      user.softDelete(BASE_TIME);

      user.restore(LATER);

      expect(user.isDeleted).toBe(false);
      expect(user.deletedAt).toBeNull();
      expect(user.isActive).toBe(false); // restore does not re-activate
    });
  });

  describe('equals', () => {
    it('is true for two users with the same id', () => {
      const a = makeUser({ id: 'same-id' });
      const b = makeUser({ id: 'same-id', firstName: 'Different' });

      expect(a.equals(b)).toBe(true);
    });

    it('is false for different ids and for undefined', () => {
      expect(makeUser({ id: 'a' }).equals(makeUser({ id: 'b' }))).toBe(false);
      expect(makeUser().equals(undefined)).toBe(false);
    });
  });
});
