import { isIP } from 'node:net';

/**
 * IP ALLOWLIST QOIDASINI YOZISHDA TEKSHIRISH (Carrier API, ultracode review).
 *
 * MUAMMO. Ro'yxat faqat `trim` qilinib saqlanardi. Gateway'dagi moslovchi
 * (`apps/api-gateway/src/auth/ip-allowlist.util.ts`) esa faqat aniq IP va
 * IPv4 CIDR (/0–/32) ni tushunadi: IPv6 CIDR, `1.2.3.4,5.6.7.8` kabi
 * vergulli yozuv, xato manzil yoki kanonik bo'lmagan IPv6 (`2001:0db8::0001`)
 * bazaga tushardi va HECH QACHON mos kelmasdi — operator hech qanday xato
 * ko'rmasdi, kompaniya esa jimgina 403 olardi.
 *
 * Endi har bir qoida yozishda tekshiriladi va kanonik shaklga keltiriladi;
 * tushunilmaydigan qoida 400 bilan rad etiladi (yolg'on cheklov saqlanmaydi).
 */

export const IP_ALLOWLIST_MAX_ENTRIES = 50;
const MAX_RULE_LENGTH = 64;

const stripMappedV4 = (value: string): string =>
  value.startsWith('::ffff:') && isIP(value.slice(7)) === 4
    ? value.slice(7)
    : value;

const ipv4ToInt = (value: string): number =>
  value.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

/** `::ffff:cb00:710a` (hex yozilgan IPv4-mapped) → `203.0.113.10`. */
const mappedHexToV4 = (canonical: string): string | null => {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
};

/**
 * Bitta qoidani kanonik shaklga keltiradi yoki `null` (tushunilmaydi).
 *
 * - IPv4: `203.0.113.10`
 * - IPv4 CIDR: `203.0.113.0/24` (0–32)
 * - IPv6: kanonik qisqa shakl (`2001:0DB8::0001` → `2001:db8::1`) — gateway
 *   uni Cloudflare yuboradigan `CF-Connecting-IP` bilan satr sifatida solishtiradi.
 * - IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4.
 * - IPv6 CIDR — RAD: moslovchi uni qo'llab-quvvatlamaydi.
 */
export function canonicalIpAllowlistRule(raw: unknown): string | null {
  const value = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
  if (!value || value.length > MAX_RULE_LENGTH) return null;

  if (value.includes('/')) {
    const parts = value.split('/');
    if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) return null;
    const bits = Number(parts[1]);
    const network = stripMappedV4(parts[0]);
    if (isIP(network) !== 4 || bits < 0 || bits > 32) return null;
    /**
     * Host bitlari bo'lgan CIDR — RAD (`203.0.113.10/3` moslovchida
     * `192.0.0.0/3`, ya'ni IPv4'ning 1/8 qismi bo'lib ketardi, ro'yxatda esa
     * zararsiz ko'rinardi). Faqat haqiqiy tarmoq manzili qabul qilinadi.
     */
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipv4ToInt(network) & mask) >>> 0 !== ipv4ToInt(network)) return null;
    return `${network}/${bits}`;
  }

  const ip = stripMappedV4(value);
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family === 6) {
    let canonical: string;
    try {
      canonical = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return null;
    }
    // Gateway mijoz IP'sidagi `::ffff:` ni IPv4 ga aylantiradi — qoida ham.
    if (canonical.startsWith('::ffff:')) return mappedHexToV4(canonical);
    // Eskirgan IPv4-compatible (`::203.0.113.10`) — hech qachon mos kelmaydi.
    if (/^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(canonical)) return null;
    return canonical;
  }
  return null;
}

/** Butun ro'yxat: kanonik qoidalar (takrorsiz) va tushunilmagan yozuvlar. */
export function normalizeIpAllowlistRules(list: readonly unknown[]): {
  rules: string[];
  invalid: string[];
} {
  const rules: string[] = [];
  const invalid: string[] = [];
  for (const item of list) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text) continue;
    const rule = canonicalIpAllowlistRule(text);
    if (rule === null) {
      invalid.push(text.slice(0, MAX_RULE_LENGTH));
    } else if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }
  return { rules, invalid };
}
