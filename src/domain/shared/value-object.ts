export abstract class ValueObject<TProps extends object> {
  protected readonly props: Readonly<TProps>;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  public equals(other?: ValueObject<TProps>): boolean {
    if (other === null || other === undefined) return false;
    if (this === other) return true;
    if (this.constructor !== other.constructor) return false;

    const keys = Object.keys(this.props) as (keyof TProps)[];
    if (keys.length !== Object.keys(other.props).length) return false;
    return keys.every((key) => ValueObject.valuesEqual(this.props[key], other.props[key]));
  }

  private static valuesEqual(left: unknown, right: unknown): boolean {
    if (left instanceof ValueObject && right instanceof ValueObject) return left.equals(right);
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    return left === right;
  }
}
