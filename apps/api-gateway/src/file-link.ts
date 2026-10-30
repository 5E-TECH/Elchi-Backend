import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

/**
 * (kiZgTybn, prod 2026-10-26) Gateway imzolagan QISQA MUDDATLI fayl havolasi.
 *
 * MUAMMO: smena karta qoldig'i rasmi (`photo_url`) va hisobot fayli
 * (`file_url`) `file.get_url` bilan olinardi — file-service S3 havolasini
 * ICHKI `MINIO_ENDPOINT` bilan imzolaydi (`http://minio:9000/elchi-files/…
 * ?X-Amz-…`). MinIO tashqariga chiqarilmagan (faqat `api.elchipochta.uz →
 * api-gateway` tunnel; public MinIO URL env yo'q), shuning uchun brauzer
 * «Ochish» / «Rasmni ochish» havolasini ocha olmasdi.
 *
 * YECHIM: boshqa maxfiy fayllar (buyurtma dalillari) qanday ochilsa — xuddi
 * shunday: baytlar gateway orqali `file.read` bilan beriladi
 * (`GET files/:key/content` bilan bir xil sarlavhalar). Farqi — smena
 * oynasi havolani oddiy `<a href target="_blank">` bilan ochadi (Bearer
 * sarlavhasi yo'q), shuning uchun ruxsat havolaning o'zida: shifrlangan va
 * autentifikatsiyalangan token (AES-256-GCM: kalit + muddat) — avvalgi S3
 * imzosi semantikasi (300 s, bearer havola) aynan saqlanadi, fayl kaliti esa
 * javobga chiqmaydi. Havola faqat doirasi tekshirilgan endpoint'larda
 * yaratiladi (menejer — o'z filiali, registrator — asosiy kassa,
 * superadmin/admin — hammasi).
 *
 * Shifr kaliti — `ACCESS_TOKEN_KEY` dan alohida domen bilan olingan sub-kalit
 * (yangi env shart emas; JWT imzosi bilan aralashmaydi). Token yo'lda —
 * `sanitizeLogUrl` uni logda `***` qiladi.
 */

/**
 * Gateway havola bera oladigan kalit prefikslari (smena rasmi, smena
 * hisoboti, T3 kassa cheki). Umumiy `GET files/:key` bu prefikslarni faqat
 * superadmin/admin'ga ochadi; qolganlar doirasi tekshirilgan endpoint bergan
 * imzolangan havola (300 s) orqali.
 */
export const FILE_LINK_PREFIXES: readonly string[] = [
  'shift-check-',
  'shift-report-',
  'cashbox-receipt-',
];

/** Havolaning muddati (s) — smena rasmi qisqa muddatli (PII). */
export const FILE_LINK_TTL_SECONDS = 300;

/** Havola yo'li: `GET files/signed/:token` (file-gateway). */
export const FILE_LINK_PATH = '/files/signed/';

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Kalit (file-service: `<papka>-<vaqt>-<uuid>-<nom>`) uchun yetarli chegara. */
const MAX_TOKEN_CHARS = 1024;

export const isFileLinkKey = (key: unknown): boolean =>
  typeof key === 'string' &&
  FILE_LINK_PREFIXES.some((prefix) => key.startsWith(prefix));

const linkKey = (): Buffer | null => {
  const base = String(process.env.ACCESS_TOKEN_KEY ?? '').trim();
  if (!base) return null;
  return createHmac('sha256', base).update('elchi:file-link:v1').digest();
};

/** Kalit uchun opaq token; kalit ruxsat etilmagan yoki sir yo'q — null. */
export function createFileLinkToken(
  key: string,
  nowMs = Date.now(),
): string | null {
  const secret = linkKey();
  if (!secret || !isFileLinkKey(key)) return null;
  const exp = Math.floor(nowMs / 1000) + FILE_LINK_TTL_SECONDS;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const body = Buffer.concat([
    cipher.update(`${exp}.${key}`, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/**
 * Token → fayl kaliti. Soxta / o'zgartirilgan / muddati o'tgan / smena fayli
 * bo'lmagan kalit — null (hech qachon throw qilmaydi).
 */
export function readFileLinkToken(
  token: unknown,
  nowMs = Date.now(),
): string | null {
  const secret = linkKey();
  if (!secret || typeof token !== 'string') return null;
  if (token.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }
  const raw = Buffer.from(token, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  let plain: string;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      secret,
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    plain = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d{1,12})\.(.+)$/.exec(plain);
  if (!match) return null;
  const exp = Number(match[1]);
  const key = match[2];
  const nowSec = Math.floor(nowMs / 1000);
  // Muddati o'tgan yoki 300 s dan uzoq kelajakdagi muddat — rad.
  if (exp <= nowSec || exp > nowSec + FILE_LINK_TTL_SECONDS) return null;
  return isFileLinkKey(key) ? key : null;
}

/** Express so'rovining origin uchun kerakli qismi. */
export interface OriginRequest {
  headers?: Record<string, string | string[] | undefined>;
  protocol?: string;
  get?: (name: string) => string | undefined;
}

/**
 * Brauzer ko'rgan API origin'i (`https://api.elchipochta.uz`) — katalog
 * rasmlari (`files/view/:key`) bilan bir xil manba: `X-Forwarded-Proto`
 * (Cloudflare tunnel) va `Host`. Topilmasa — bo'sh (nisbiy yo'l qaytadi).
 */
export function publicOrigin(req: OriginRequest | undefined): string {
  const forwarded = req?.headers?.['x-forwarded-proto'];
  const proto = String(
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0] ||
      req?.protocol ||
      'https',
  )
    .trim()
    .toLowerCase();
  const hostHeader = req?.headers?.host;
  const rawHost =
    req?.get?.('host') ??
    (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);
  const host = String(rawHost ?? '').trim();
  if (!host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

/**
 * Smena fayli uchun brauzer ochadigan havola (300 s):
 * `<origin>/files/signed/<token>`. Kalit yo'q / ruxsat etilmagan — null.
 */
export function buildFileLinkUrl(
  req: OriginRequest | undefined,
  key: unknown,
  nowMs = Date.now(),
): string | null {
  const text = typeof key === 'string' ? key.trim() : '';
  if (!text) return null;
  const token = createFileLinkToken(text, nowMs);
  if (!token) return null;
  return `${publicOrigin(req)}${FILE_LINK_PATH}${token}`;
}
