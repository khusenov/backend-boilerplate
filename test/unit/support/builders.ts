import { User } from '@/domain/user/user-entity';
import { Email } from '@/domain/user/email-vo';

export const FIXTURE_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

type CreateParams = Parameters<typeof User.create>[0];

const DEFAULT_USER = {
  id: 'user-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  passwordHash: 'hashed-pw',
} as const;

export type UserOverrides = Partial<
  Omit<CreateParams, 'email'> & { email: string; createdAt: Date }
>;

function toCreateParams(overrides: UserOverrides): CreateParams {
  return {
    id: overrides.id ?? DEFAULT_USER.id,
    firstName: overrides.firstName ?? DEFAULT_USER.firstName,
    lastName: overrides.lastName ?? DEFAULT_USER.lastName,
    email: Email.create(overrides.email ?? DEFAULT_USER.email),
    passwordHash: overrides.passwordHash ?? DEFAULT_USER.passwordHash,
  };
}

export function makeUser(overrides: UserOverrides = {}): User {
  return User.create(toCreateParams(overrides), overrides.createdAt ?? FIXTURE_CREATED_AT);
}

export function makeRegisteredUser(overrides: UserOverrides = {}): User {
  return User.register(toCreateParams(overrides), overrides.createdAt ?? FIXTURE_CREATED_AT);
}
