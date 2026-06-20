import type { UserDto } from '@/application/user/user-dto';

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResultDto {
  user: UserDto;
  tokens: AuthTokensDto;
}
