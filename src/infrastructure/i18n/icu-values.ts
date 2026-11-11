export type IcuValue = string | number | boolean | Date;

export function toIcuValues(params: Readonly<Record<string, unknown>>): Record<string, IcuValue> {
  const values: Record<string, IcuValue> = {};

  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values[name] = value;
    } else if (typeof value === 'bigint') {
      values[name] = Number(value);
    } else if (value instanceof Date) {
      values[name] = value;
    }
  }

  return values;
}
