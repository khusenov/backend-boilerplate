import { User, type UserStatusType } from '@/domain/user/user-entity';

export interface UserDto {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  status: UserStatusType;
  createdAt: Date;
  updatedAt: Date;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName,
    email: user.email.toString(),
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
