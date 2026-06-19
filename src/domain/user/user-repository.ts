import type { User } from './user-entity';
import type { Email } from './email-vo';

export interface UserRepository {
  findById(id: string): Promise<User | null>;

  findByEmail(email: Email): Promise<User | null>;

  create(user: User): Promise<void>;

  update(user: User): Promise<void>;
}
