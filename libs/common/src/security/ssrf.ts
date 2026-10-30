import { lookup as lookupWithCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import type { Dispatcher } from 'undici';

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
 * DNS rebinding (TTL 0: the check sees a public IP, the connect sees an internal
 * one): `assertPublicUrl` alone cannot stop it, so outbound calls go through
 * `fetchPinned` — the lookup the socket actually uses validates every answer and
 * connects only to those addresses (`createPinnedLookup`, dgvwZasd B). The URL is
 * not rewritten, so Host, TLS SNI and the certificate check stay on the hostname.
 *
 * Redirects: this guard only vets the FIRST URL. `fetch()` follows 3xx by
 * default, so a public host could bounce the request to `rabbitmq:15672` or
 * `minio:9000`. `fetchPinned` therefore never follows them
 * (`fetchWithoutRedirect`, `redirect: 'error'`, dgvwZasd A).
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

/** Two hextets holding an embedded IPv4 address → its blocklist verdict. */
function isBlockedEmbeddedIpv4(high: number, low: number): boolean {
  return isBlockedIpv4(
    `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
  );
}

function isBlockedIpv6(addr: string): boolean {
  const g = expandIpv6(addr);
  if (!g) return true; // fail closed
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback

  // The embedded IPv4 is what gets routed, so apply the IPv4 blocklist to it:
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), IPv4-translated
  // (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d), 6to4 (2002:aabb:ccdd::).
  const leadingZeros = g.findIndex((x) => x !== 0);
  if (leadingZeros === 5 && g[5] === 0xffff) {
    return isBlockedEmbeddedIpv4(g[6], g[7]);
  }
  if (leadingZeros >= 6) return isBlockedEmbeddedIpv4(g[6], g[7]);
  if (leadingZeros === 4 && g[4] === 0xffff && g[5] === 0) {
    return isBlockedEmbeddedIpv4(g[6], g[7]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // 64:ff9b:1::/48 is the local-use NAT64 prefix (RFC 8215).
    if (g[2] !== 0) return true;
    return isBlockedEmbeddedIpv4(g[6], g[7]);
  }
  if (g[0] === 0x2002) return isBlockedEmbeddedIpv4(g[1], g[2]);

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo
  if (first === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
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
 * The checks that need no DNS: http(s) scheme, and a literal IP in the URL must
 * be public. Returns the hostname left to resolve, or null for a literal IP.
 */
function assertOutboundTarget(rawUrl: string): string | null {
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
    return null;
  }
  return host;
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

  const host = assertOutboundTarget(rawUrl);
  if (!host) return;

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

/**
 * (dgvwZasd) Redirect'li manzil rad etildi. `SsrfBlockedError` avlodi — uni
 * ushlaydigan joylar (masalan `assertOutboundUrlSafe`) shu xatoni ham SSRF
 * rad etishi deb ko'radi.
 */
export class SsrfRedirectBlockedError extends SsrfBlockedError {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRedirectBlockedError';
  }
}

/**
 * undici (Node `fetch`) `redirect: 'error'` da 3xx javobni
 * `TypeError('fetch failed', { cause: Error('unexpected redirect') })` qilib
 * tashlaydi. Boshqa tarmoq xatolari (ECONNREFUSED, timeout) bu emas.
 */
function isRedirectRejection(error: unknown): boolean {
  // `instanceof Error` ISHLATILMAYDI: undici xatosi boshqa realm'da
  // yaratilishi mumkin (Jest VM sandbox'ida `instanceof` doim false) —
  // shakl bo'yicha tekshiriladi.
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return false;
  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' && /unexpected redirect/i.test(message);
}

/** Xato matni uchun faqat origin — so'rov qatoridagi token/kalitlar logga tushmasin. */
function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '<invalid url>';
  }
}

/**
 * (dgvwZasd A) Operator sozlagan manzilga chiquvchi so'rov — redirect'ga
 * ERGASHMAYDI.
 *
 * `assertPublicUrl` faqat birinchi manzilni tekshiradi; sukut bo'yicha
 * `fetch()` 3xx `Location` ga o'zi ergashadi va so'rov ichki xizmatga
 * (`rabbitmq:15672`, `minio:9000`, metadata) yetib boradi — himoya aylanib
 * o'tiladi. Bu yerda `redirect: 'error'` HAR DOIM qo'yiladi (chaqiruvchi
 * `init` da boshqa qiymat bersa ham ustidan yoziladi) va 3xx javob
 * `SsrfRedirectBlockedError` bilan rad etiladi — redirect manzili umuman
 * chaqirilmaydi. Boshqa xatolar (tarmoq, timeout) o'zgarishsiz qaytadi.
 *
 * `fetch` chaqiruv paytida global'dan olinadi — testlardagi
 * `global.fetch = jest.fn()` mock'lari avvalgidek ishlaydi.
 */
export async function fetchWithoutRedirect(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error' });
  } catch (error) {
    if (isRedirectRejection(error)) {
      throw new SsrfRedirectBlockedError(
        `Redirect blocked: ${safeOrigin(url)} replied with a 3xx redirect; ` +
          'outbound integration calls do not follow redirects',
      );
    }
    throw error;
  }
}

/** `fetch` xatosining `cause` dagi belgisi (qarang: `fetchPinned`). */
const PINNED_LOOKUP_REJECTED = 'ERR_SSRF_LOOKUP_REJECTED';

/**
 * Oddiy `Error` + `code`, `SsrfBlockedError` emas: undici xato bo'lmagan deb
 * bilgan klassni (boshqa realm, Jest VM) `cause` ga matn qilib o'rab yuboradi.
 */
const pinnedLookupRejection = (message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code: PINNED_LOOKUP_REJECTED });

/**
 * (dgvwZasd B) `net.connect` uchun nom yechish: `dns.lookup` javobidagi HAR BIR
 * manzil tekshiriladi va socket FAQAT shu tekshirilgan manzillarga ulanadi —
 * tekshiruv va ulanish orasida ikkinchi DNS so'rovi yo'q, ya'ni rebinding uchun
 * oyna qolmaydi. Bitta manzil ham ichki bo'lsa, yoki DNS xato/bo'sh javob bersa —
 * rad etiladi, ulanish boshlanmaydi. `options.all` (Node happy eyeballs)
 * bo'lsa butun ro'yxat, aks holda birinchi manzil qaytadi.
 *
 * `isBlocked` — faqat testlar uchun (lokal serverga haqiqiy ulanishni kuzatish).
 */
export function createPinnedLookup(
  isBlocked: (address: string) => boolean = isBlockedAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    lookupWithCallback(
      hostname,
      { ...options, all: true },
      (error, addresses) => {
        if (error || !addresses.length) {
          callback(
            pinnedLookupRejection(`Could not resolve host: ${hostname}`),
            [],
          );
          return;
        }
        const blocked = addresses.find(({ address }) => isBlocked(address));
        if (blocked) {
          callback(
            pinnedLookupRejection(
              `Host ${hostname} resolves to a non-public address (${blocked.address})`,
            ),
            [],
          );
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      },
    );
  };
}

let pinnedDispatcher: Dispatcher | undefined;

/**
 * Umumiy `Agent` — origin bo'yicha keep-alive pool saqlanadi, har yangi socket
 * `createPinnedLookup` dan o'tadi. Kechiktirilgan `require`: `@app/common` hamma
 * servisga yuklanadi (har biriga ~16 MB), `undici` esa faqat integratsiyaga kerak.
 *
 * ⚠️ `undici` MAJOR versiyasi Node ichidagi bilan bir xil saqlanadi (Node 22 →
 * 6.x): `Agent` global `fetch` ga `dispatcher` bo'lib beriladi, ikkalasi
 * `dispatch()` shartnomasi orqali ishlaydi. Node yangilansa `ssrf-pinning`
 * spec'ini yangi versiyada yurgizing.
 */
function getPinnedDispatcher(): Dispatcher {
  if (!pinnedDispatcher) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Agent } = require('undici') as typeof import('undici');
    pinnedDispatcher = new Agent({ connect: { lookup: createPinnedLookup() } });
  }
  return pinnedDispatcher;
}

/**
 * (dgvwZasd B) Operator sozlagan manzilga chiquvchi so'rovning YAGONA yo'li:
 * URL literal tekshiruvi + tekshirilgan IP'ga ulanish + redirect'ga ergashmaslik.
 * `assertPublicUrl` bilan oldindan tekshirish (aniq 400 xato) o'rnini bosmaydi,
 * lekin undan mustaqil himoya qiladi. `allowPrivate` — dev/test, himoyasiz.
 *
 * `fetch` chaqiruv paytida global'dan olinadi — testlardagi
 * `global.fetch = jest.fn()` mock'lari avvalgidek ishlaydi.
 */
export async function fetchPinned(
  url: string,
  init: RequestInit = {},
  options: AssertPublicUrlOptions = {},
): Promise<Response> {
  if (options.allowPrivate) {
    return fetchWithoutRedirect(url, init);
  }
  assertOutboundTarget(url);
  try {
    return await fetchWithoutRedirect(url, {
      ...init,
      dispatcher: getPinnedDispatcher(),
    } as RequestInit);
  } catch (error) {
    // Ulanishdagi rad etish fetch ichida `TypeError('fetch failed', { cause })`
    // bo'lib keladi — chaqiruvchi SSRF xatosini tanisin.
    const cause = (error as { cause?: { code?: unknown; message?: string } })
      ?.cause;
    if (cause?.code === PINNED_LOOKUP_REJECTED) {
      throw new SsrfBlockedError(String(cause.message));
    }
    throw error;
  }
}
