import type { Role } from './role-entity';
import type { PageQuery, PageSlice } from '@/shared/pagination';

export interface RoleRepository {
  list(query: PageQuery): Promise<PageSlice<Role>>;

  findById(id: string): Promise<Role | null>;

  findByKey(key: string): Promise<Role | null>;

  findByName(name: string): Promise<Role | null>;

  save(role: Role): Promise<void>;
}
