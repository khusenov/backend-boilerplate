import type { User } from './user-entity';
import type { Email } from './email-vo';
import type { PageQuery, PageSlice } from '@/shared/pagination';

export interface UserRepository {
  // excludes soft deleted users
  list(query: PageQuery): Promise<PageSlice<User>>;

  // returns null for soft deleted users
  findById(id: string): Promise<User | null>;

  findByEmail(email: Email): Promise<User | null>;

  save(user: User): Promise<void>;
}
