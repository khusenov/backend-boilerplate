export const VARY_HEADER = 'vary' as const;
export const ACCEPT_LANGUAGE_HEADER = 'Accept-Language' as const;

type HeaderValue = string | number | readonly string[] | undefined;

export function withVaryValue(currentVary: HeaderValue, headerName: string): string {
  const values = new Set(
    String(currentVary ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  values.add(headerName);
  return [...values].join(', ');
}
