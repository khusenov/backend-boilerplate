export interface PermissionRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PermissionRepository {
  findAll(): Promise<PermissionRecord[]>;

  upsertByKey(record: PermissionRecord): Promise<void>;

  deleteByKeys(keys: string[]): Promise<void>;
}
