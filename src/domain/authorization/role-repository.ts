import type { Role } from './role-entity';
import type { PageQuery, PageSlice } from '@/shared/pagination';

export interface RoleReader {
  list(query: PageQuery): Promise<PageSlice<Role>>;

  findById(id: string): Promise<Role | null>;

  findByKey(key: string): Promise<Role | null>;

  findByName(name: string): Promise<Role | null>;
}

export interface RoleRepository extends RoleReader {
  // throws StaleAggregateError when the stored version has moved on
  save(role: Role): Promise<void>;
}
