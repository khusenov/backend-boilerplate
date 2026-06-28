import { Entity, type EntityProps } from '@/domain/shared/entity';
import { RoleDeletedError, RoleNameRequiredError, SystemRoleProtectedError } from './role-errors';

interface RoleProps extends EntityProps {
  key: string | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Set<string>;
}

interface RoleCreateParams {
  id: string;
  name: string;
  description?: string | null;
  permissions?: string[];
}

export class Role extends Entity<RoleProps> {
  private constructor(props: RoleProps) {
    super(props);
  }

  get key(): string | null {
    return this.props.key;
  }

  get name(): string {
    return this.props.name;
  }

  get description(): string | null {
    return this.props.description;
  }

  get isSystem(): boolean {
    return this.props.isSystem;
  }

  get permissions(): string[] {
    return [...this.props.permissions];
  }

  private static normalizeName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new RoleNameRequiredError();
    return trimmed;
  }

  private static normalizeDescription(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  }

  private static build(
    params: RoleCreateParams,
    opts: { key: string | null; isSystem: boolean },
  ): Role {
    const now = new Date();
    return new Role({
      id: params.id,
      key: opts.key,
      name: Role.normalizeName(params.name),
      description: Role.normalizeDescription(params.description),
      isSystem: opts.isSystem,
      permissions: new Set(params.permissions ?? []),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static create(params: RoleCreateParams): Role {
    return Role.build(params, { key: null, isSystem: false });
  }

  static createSystem(params: RoleCreateParams & { key: string }): Role {
    return Role.build(params, { key: params.key, isSystem: true });
  }

  static hydrate(props: RoleProps): Role {
    return new Role(props);
  }

  rename(name: string): void {
    this.guardMutable();
    const next = Role.normalizeName(name);
    if (this.props.name === next) return;
    this.props.name = next;
    this.touch();
  }

  changeDescription(description: string | null): void {
    this.guardMutable();
    const next = Role.normalizeDescription(description);
    if (this.props.description === next) return;
    this.props.description = next;
    this.touch();
  }

  grant(permission: string): void {
    this.guardMutable();
    if (this.props.permissions.has(permission)) return;
    this.props.permissions.add(permission);
    this.touch();
  }

  revoke(permission: string): void {
    this.guardMutable();
    if (!this.props.permissions.delete(permission)) return;
    this.touch();
  }

  setPermissions(permissions: string[]): void {
    this.guardMutable();
    this.props.permissions = new Set(permissions);
    this.touch();
  }

  hasPermission(permission: string): boolean {
    return this.props.permissions.has(permission);
  }

  override softDelete(): void {
    if (this.props.isSystem) throw new SystemRoleProtectedError(this.id);
    super.softDelete();
  }

  private guardMutable(): void {
    if (this.props.isSystem) throw new SystemRoleProtectedError(this.id);
    if (this.isDeleted) throw new RoleDeletedError(this.id);
  }
}
