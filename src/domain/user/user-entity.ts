import { Entity, type EntityProps } from '@/domain/shared/entity';
import type { Email } from './email-vo';
import { ConflictError, ValidationError } from '@/shared/errors';

export class UserDeletedError extends ConflictError {
  constructor(id: string) {
    super(`User with id ${id} is deleted`, { code: 'USER_DELETED' });
  }
}

export class UserInvalidNameError extends ValidationError {
  constructor(field: string) {
    super(`${field} is invalid`, { code: 'USER_NAME_INVALID' });
  }
}

export const UserStatus = {
  Active: 'active',
  Inactive: 'inactive',
} as const;

export type UserStatusType = (typeof UserStatus)[keyof typeof UserStatus];

interface UserProps extends EntityProps {
  firstName: string;
  lastName: string;
  email: Email;
  passwordHash: string;
  status: UserStatusType;
}

interface UserCreateParams {
  id: string;
  firstName: string;
  lastName: string;
  email: Email;
  passwordHash: string;
}

export class User extends Entity<UserProps> {
  private constructor(props: UserProps) {
    super(props);
  }

  get firstName(): string {
    return this.props.firstName;
  }

  get lastName(): string {
    return this.props.lastName;
  }

  get email(): Email {
    return this.props.email;
  }

  get passwordHash(): string {
    return this.props.passwordHash;
  }

  get status(): UserStatusType {
    return this.props.status;
  }

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  get isActive(): boolean {
    return this.props.status === UserStatus.Active;
  }

  static create(params: UserCreateParams): User {
    const now = new Date();
    const firstName = params.firstName.trim();
    const lastName = params.lastName.trim();

    if (!firstName) throw new UserInvalidNameError('firstName');
    if (!lastName) throw new UserInvalidNameError('lastName');

    return new User({
      ...params,
      firstName,
      lastName,
      status: UserStatus.Active,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static hydrate(props: UserProps): User {
    return new User(props);
  }

  activate(): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (this.isActive) return;
    this.props.status = UserStatus.Active;
    this.touch();
  }

  deactivate(): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (!this.isActive) return;
    this.props.status = UserStatus.Inactive;
    this.touch();
  }

  override softDelete(): void {
    if (this.isDeleted) return;
    this.deactivate();
    super.softDelete();
  }
}
