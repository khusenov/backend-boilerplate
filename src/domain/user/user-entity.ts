import {
  AggregateRoot,
  UNSAVED_VERSION,
  type AggregateRootProps,
} from '@/domain/shared/aggregate-root';
import type { Email } from './email-vo';
import { UserInvalidNameError, UserDeletedError } from './user-errors';
import { UserCreatedEvent } from '@/domain/user/events/user-created-event';

export const UserStatus = {
  Active: 'active',
  Inactive: 'inactive',
  Pending: 'pending',
} as const;

export type UserStatusType = (typeof UserStatus)[keyof typeof UserStatus];

interface UserProps extends AggregateRootProps {
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

export class User extends AggregateRoot<UserProps> {
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

  get isPending(): boolean {
    return this.props.status === UserStatus.Pending;
  }

  private static normalizeName(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new UserInvalidNameError(field);
    return trimmed;
  }

  private static build(params: UserCreateParams, status: UserStatusType, now: Date): User {
    const firstName = this.normalizeName(params.firstName, 'firstName');
    const lastName = this.normalizeName(params.lastName, 'lastName');

    const user = new User({
      ...params,
      firstName,
      lastName,
      status,
      version: UNSAVED_VERSION,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    user.recordEvent(new UserCreatedEvent(user.id, user.email.toString(), now));
    return user;
  }

  static create(params: UserCreateParams, now: Date): User {
    return this.build(params, UserStatus.Active, now);
  }

  static register(params: UserCreateParams, now: Date): User {
    return this.build(params, UserStatus.Pending, now);
  }

  static hydrate(props: UserProps): User {
    return new User(props);
  }

  activate(now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (this.isActive) return;
    this.props.status = UserStatus.Active;
    this.touch(now);
  }

  deactivate(now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (!this.isActive) return;
    this.props.status = UserStatus.Inactive;
    this.touch(now);
  }

  changeFirstName(rawFirstName: string, now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    const firstName = User.normalizeName(rawFirstName, 'firstName');
    if (this.props.firstName === firstName) return;
    this.props.firstName = firstName;
    this.touch(now);
  }

  changeLastName(rawLastName: string, now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    const lastName = User.normalizeName(rawLastName, 'lastName');
    if (this.props.lastName === lastName) return;
    this.props.lastName = lastName;
    this.touch(now);
  }

  changeEmail(email: Email, now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    if (this.props.email.equals(email)) return;
    this.props.email = email;
    if (this.props.status === UserStatus.Active) {
      this.props.status = UserStatus.Pending;
    }
    this.touch(now);
  }

  changePassword(newPasswordHash: string, now: Date): void {
    if (this.isDeleted) throw new UserDeletedError(this.id);
    this.props.passwordHash = newPasswordHash;
    this.touch(now);
  }

  override softDelete(now: Date): void {
    if (this.isDeleted) return;
    this.deactivate(now);
    super.softDelete(now);
  }
}
