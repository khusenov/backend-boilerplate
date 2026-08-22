export type TrustProxySetting = boolean | number;

const TRUST_NOTHING = 'false';
const TRUST_EVERY_HOP = 'true';
const MAX_HOP_COUNT = 32;
const HOP_COUNT_PATTERN = /^[1-9]\d*$/;

export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim().toLowerCase();

  if (value === '' || value === TRUST_NOTHING) {
    return false;
  }
  if (value === TRUST_EVERY_HOP) {
    return true;
  }
  if (HOP_COUNT_PATTERN.test(value)) {
    const hopCount = Number.parseInt(value, 10);
    if (hopCount <= MAX_HOP_COUNT) {
      return hopCount;
    }
  }

  throw new Error(
    `Invalid TRUST_PROXY value "${raw}": expected "${TRUST_NOTHING}" (or empty), ` +
      `"${TRUST_EVERY_HOP}", or a hop count from 1 to ${MAX_HOP_COUNT}.`,
  );
}
