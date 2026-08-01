export interface EntityProps {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export abstract class Entity<T extends EntityProps> {
  protected readonly props: T;

  protected constructor(props: T) {
    this.props = props;
  }

  get id(): string {
    return this.props.id;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }

  get isDeleted(): boolean {
    return this.props.deletedAt !== null;
  }

  public equals(other?: Entity<T>): boolean {
    if (other === null || other === undefined) return false;
    if (this === other) return true;
    if (!(other instanceof Entity)) return false;
    if (this.constructor !== other.constructor) return false;
    return this.id === other.id;
  }

  protected touch(now: Date): void {
    this.props.updatedAt = now;
  }

  public softDelete(now: Date): void {
    if (this.isDeleted) return;
    this.props.deletedAt = now;
    this.touch(now);
  }

  public restore(now: Date): void {
    if (!this.isDeleted) return;
    this.props.deletedAt = null;
    this.touch(now);
  }
}
