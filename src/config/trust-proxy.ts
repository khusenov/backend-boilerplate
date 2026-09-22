export type TrustProxySetting = boolean | string;

const TRUST_NOTHING = 'false';
const TRUST_EVERY_HOP = 'true';
const NUMERIC_PATTERN = /^-?\d+(?:\.\d+)?$/;

export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim();
  const keyword = value.toLowerCase();

  if (keyword === '' || keyword === TRUST_NOTHING) {
    return false;
  }
  if (keyword === TRUST_EVERY_HOP) {
    return true;
  }
  if (NUMERIC_PATTERN.test(keyword)) {
    throw new Error(
      `Invalid TRUST_PROXY value "${raw}": a hop count cannot verify the immediate peer, so a ` +
        `client connecting directly can forge X-Forwarded-For by sending that many hops. ` +
        `Fastify ignores hop counts and resolves request.ip from the socket instead. Name the ` +
        `proxies you trust: "${TRUST_NOTHING}", "${TRUST_EVERY_HOP}", an address or CIDR ` +
        `("10.0.0.0/8"), a named range ("loopback", "linklocal", "uniquelocal"), or a ` +
        `comma-separated list of those.`,
    );
  }

  return value;
}
