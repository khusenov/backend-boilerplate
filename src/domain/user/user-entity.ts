import { Entity, type EntityProps } from '@/domain/shared/entity';
import type { Email } from './email-vo';
import { UserInvalidNameError, UserDeletedError } from './user-errors';

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

  private static normalizeName(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new UserInvalidNameError(field);
    return trimmed;
  }

  static create(params: UserCreateParams): User {
    const now = new Date();
    const firstName = this.normalizeName(params.firstName, 'firstName');
    const lastName = this.normalizeName(params.lastName, 'lastName');

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

  changeFirstName(val: string): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    const firstName = User.normalizeName(val, 'firstName');
    if (this.props.firstName === firstName) return;
    this.props.firstName = firstName;
    this.touch();
  }

  changeLastName(val: string): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    const lastName = User.normalizeName(val, 'lastName');
    if (this.props.lastName === lastName) return;
    this.props.lastName = lastName;
    this.touch();
  }

  changeEmail(email: Email): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (this.props.email.equals(email)) return;
    this.props.email = email;
    this.touch();
  }

  override softDelete(): void {
    if (this.isDeleted) return;
    this.deactivate();
    super.softDelete();
  }
}
