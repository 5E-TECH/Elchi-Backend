import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for outbound requests whose destination URL comes from operator
 * config (external integrations: base_url, endpoint, auth_url).
 *
 * Strategy: reject non-http(s) schemes, then resolve the hostname with the same
 * DNS resolver the runtime uses for fetch and reject if ANY resolved address is
 * loopback / private / link-local / cloud-metadata / reserved. Resolving (rather
 * than only string-matching the host) also defeats decimal/hex/octal IP
 * obfuscation and DNS names that point at internal hosts. Fail-closed: anything
 * we cannot parse or resolve is treated as blocked.
 *
 * Residual: a TOCTOU DNS-rebind between this check and the actual connect is
 * still theoretically possible (the attacker would need to control both DNS and
 * the admin-only integration config). Acceptable for this threat model; a
 * connect-time pinned lookup can be layered on later if needed.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

function ipv4Octets(addr: string): number[] | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isBlockedIpv4(addr: string): boolean {
  const o = ipv4Octets(addr);
  if (!o) return true; // unparseable → fail closed
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 (test)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a === 198 && b === 51) return true; // test-net-2
  if (a === 203 && b === 0) return true; // test-net-3
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null if unparseable. */
function expandIpv6(addr: string): number[] | null {
  let a = addr.toLowerCase();
  // Drop a zone id (e.g. fe80::1%eth0)
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);

  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → convert to two hextets
  const v4 = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    a =
      a.slice(0, a.length - v4[1].length) +
      ((o[0] << 8) | o[1]).toString(16) +
      ':' +
      ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = a.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    const zeros: number[] = Array.from({ length: missing }, () => 0);
    return [...head, ...zeros, ...tail];
  }
  const groups = parseGroups(a);
  if (!groups || groups.length !== 8) return null;
  return groups;
}

function isBlockedIpv6(addr: string): boolean {
  const g = expandIpv6(addr);
  if (!g) return true; // fail closed
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback

  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d): the embedded
  // IPv4 is what gets routed, so apply the IPv4 blocklist to it.
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isBlockedAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return isBlockedIpv4(addr);
  if (fam === 6) return isBlockedIpv6(addr);
  return true; // not a valid IP literal → fail closed
}

export interface AssertPublicUrlOptions {
  /** When true, bypass the guard entirely (dev/testing against local providers). */
  allowPrivate?: boolean;
}

/**
 * Throw SsrfBlockedError unless `rawUrl` is an http(s) URL whose hostname
 * resolves exclusively to public, routable addresses.
 */
export async function assertPublicUrl(
  rawUrl: string,
  options: AssertPublicUrlOptions = {},
): Promise<void> {
  if (options.allowPrivate) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked URL scheme: ${url.protocol}`);
  }

  // Strip IPv6 brackets from the hostname for literal checks.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfBlockedError('Missing host');

  // Literal IP → check directly, no DNS.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Blocked (non-public) address: ${host}`);
    }
    return;
  }

  // Hostname → resolve with the runtime resolver and check every answer. This
  // also catches integer/hex/octal IP forms (glibc resolves them) and internal
  // DNS names.
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  if (!resolved.length) {
    throw new SsrfBlockedError(`Host did not resolve: ${host}`);
  }
  for (const r of resolved) {
    if (isBlockedAddress(r.address)) {
      throw new SsrfBlockedError(
        `Host ${host} resolves to a non-public address (${r.address})`,
      );
    }
  }
}
