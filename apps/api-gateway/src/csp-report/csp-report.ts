/**
 * (KwodkKWY) CSP buzilish hisobotlari — `POST /csp-report` uchun sof
 * yordamchilar (Nest'siz, alohida test qilinadi).
 *
 * Frontend `public/_headers` da `Content-Security-Policy-Report-Only` turibdi;
 * 1 hafta kuzatuvdan keyin majburiy rejimga o'tadi. Kuzatuv uchun brauzer
 * buzilishlarni shu yerga yuboradi (`report-uri https://api.elchipochta.uz/csp-report`,
 * keyinroq `report-to` ham), gateway ularni bitta tuzilmali log qatori qilib
 * yozadi (`event: "csp_violation"`).
 *
 * Ikki format:
 *  - eski `report-uri` — `Content-Type: application/csp-report`, tana
 *    `{ "csp-report": { "document-uri", "blocked-uri", "effective-directive", … } }`;
 *  - Reporting API (`report-to`) — `Content-Type: application/reports+json`,
 *    tana `[{ "type": "csp-violation", "url", "body": { "documentURL",
 *    "blockedURL", "effectiveDirective", … } }, …]`; boshqa turlar
 *    (`deprecation`, `intervention`, …) e'tiborsiz.
 *
 * ⚠️ Tana — ishonchsiz (istalgan kishi yubora oladi). Logga faqat TOZALANGAN
 * maydonlar chiqadi: URL'lardan query/fragment olib tashlanadi (token, telefon
 * va h.k. sizmasin), yo'ldagi token ko'rinishidagi bo'laklar `:id` bilan
 * almashtiriladi, matnlar qisqartiriladi, `original-policy` yozilmaydi
 * (o'zimizniki). Javobga tanadan HECH NARSA qaytmaydi.
 */

/** Qabul qilinadigan turlar (boshqasi — 415). */
export const CSP_REPORT_CONTENT_TYPES = [
  'application/csp-report',
  'application/reports+json',
] as const;

/**
 * Tana chegarasi. Bitta `report-uri` hisoboti ~1–2 KB (siyosat ~600 belgi);
 * Reporting API bir nechta hisobotni bitta so'rovda yuboradi — 32 KB ~15–20
 * tasiga yetadi. Katta tana — 413.
 */
export const CSP_REPORT_BODY_LIMIT_BYTES = 32 * 1024;

/** Bitta so'rovdan logga yoziladigan (takrorlanmas) buzilishlar soni. */
export const CSP_REPORT_MAX_PER_REQUEST = 10;

/**
 * Per-IP (`CF-Connecting-IP`) chegara — log to'lib ketmasin. Brauzer bitta
 * buzilish uchun hujjat boshiga bir marta yuboradi; kuzatuvga 30/daqiqa
 * yetarli, ortig'i (429) — takrorlar, yo'qolsa zarar yo'q.
 */
export const CSP_REPORT_THROTTLE = {
  default: { limit: 30, ttl: 60_000 },
} as const;

export type CspReportFormat = 'report-uri' | 'report-to';

export interface CspViolation {
  format: CspReportFormat;
  /** Buzilish bo'lgan sahifa: origin + yo'l (query'siz). */
  document_uri: string | null;
  referrer: string | null;
  /** Bloklangan manba: origin + yo'l, yoki kalit so'z (`inline`, `eval`, `data` …). */
  blocked_uri: string | null;
  effective_directive: string | null;
  violated_directive: string | null;
  disposition: 'enforce' | 'report' | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  status_code: number | null;
  /** Inline skript/stil boshidan namuna (brauzer ≤40 belgi beradi). */
  sample: string | null;
}

export interface CspReportBatch {
  /** Takrorlanmas buzilishlar; `count` — shu so'rovda necha marta kelgani. */
  violations: Array<CspViolation & { count: number }>;
  /** CSP bo'lmagan (`deprecation` …) yoki yaroqsiz yozuvlar. */
  ignored: number;
  /** `CSP_REPORT_MAX_PER_REQUEST` dan ortig'i (logga yozilmadi). */
  dropped: number;
}

const MAX_URL = 256;
const MAX_SAMPLE = 80;
const MAX_ITEMS_SCANNED = 100;
/** `inline`, `eval`, `wasm-eval`, `trusted-types-sink`, `self`, `data` … */
const KEYWORD_RE = /^[a-z][a-z0-9-]{0,63}$/;
const DIRECTIVE_RE = /^[a-z][a-z-]{0,63}$/;
/** Token/UUID ko'rinishidagi yo'l bo'lagi: harf + raqam aralash, ≥16 belgi. */
const OPAQUE_SEGMENT_RE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9._~%+=-]{16,}$/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/**
 * URL'ni logga xavfsiz ko'rinishga keltiradi: http(s)/ws(s) — origin + yo'l
 * (query va fragment YO'Q, token ko'rinishidagi bo'laklar `:id`); boshqa sxema
 * (`data:`, `blob:`, `chrome-extension:`) — faqat sxema nomi; CSP kalit so'zi
 * (`inline`, `eval` …) — o'zi. Yaroqsiz — `null`.
 */
export function safeReportUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (KEYWORD_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw.slice(0, 4096));
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) {
    return KEYWORD_RE.test(scheme) ? scheme : null;
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (OPAQUE_SEGMENT_RE.test(segment) ? ':id' : segment))
    .join('/');
  return clip(`${url.origin}${path}`, MAX_URL);
}

/** `"img-src 'self' data:"` (eski brauzerlar) → `img-src`. */
function directive(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return DIRECTIVE_RE.test(name) ? name : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) {
    return Number(value);
  }
  return null;
}

function sampleText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\p{Cc}/gu, ' ').trim();
  return text ? clip(text, MAX_SAMPLE) : null;
}

function disposition(value: unknown): CspViolation['disposition'] {
  return value === 'enforce' || value === 'report' ? value : null;
}

function fromReportUri(report: Record<string, unknown>): CspViolation {
  return {
    format: 'report-uri',
    document_uri: safeReportUrl(report['document-uri']),
    referrer: safeReportUrl(report.referrer),
    blocked_uri: safeReportUrl(report['blocked-uri']),
    effective_directive: directive(report['effective-directive']),
    violated_directive: directive(report['violated-directive']),
    disposition: disposition(report.disposition),
    source_file: safeReportUrl(report['source-file']),
    line_number: nonNegativeInt(report['line-number']),
    column_number: nonNegativeInt(report['column-number']),
    status_code: nonNegativeInt(report['status-code']),
    sample: sampleText(report['script-sample']),
  };
}

function fromReportTo(
  body: Record<string, unknown>,
  reportUrl: unknown,
): CspViolation {
  return {
    format: 'report-to',
    document_uri: safeReportUrl(body.documentURL ?? reportUrl),
    referrer: safeReportUrl(body.referrer),
    blocked_uri: safeReportUrl(body.blockedURL),
    effective_directive: directive(body.effectiveDirective),
    violated_directive: directive(body.violatedDirective),
    disposition: disposition(body.disposition),
    source_file: safeReportUrl(body.sourceFile),
    line_number: nonNegativeInt(body.lineNumber),
    column_number: nonNegativeInt(body.columnNumber),
    status_code: nonNegativeInt(body.statusCode),
    sample: sampleText(body.sample),
  };
}

function toViolation(item: unknown): CspViolation | null {
  const record = asRecord(item);
  if (!record) return null;
  let violation: CspViolation | null = null;
  const legacy = asRecord(record['csp-report']);
  if (legacy) {
    violation = fromReportUri(legacy);
  } else if (record.type === 'csp-violation') {
    const body = asRecord(record.body);
    if (body) violation = fromReportTo(body, record.url);
  }
  // Direktiva ham, bloklangan manba ham yo'q — tahlilga yaramaydi.
  if (
    !violation ||
    (!violation.effective_directive &&
      !violation.violated_directive &&
      !violation.blocked_uri)
  ) {
    return null;
  }
  return violation;
}

/**
 * Parse qilingan tanadan (obyekt yoki massiv) tozalangan buzilishlar.
 * Bir xil buzilishlar birlashtiriladi (`count`), ko'pi bilan
 * `CSP_REPORT_MAX_PER_REQUEST` ta.
 */
export function extractCspViolations(body: unknown): CspReportBatch {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  const unique = new Map<string, CspViolation & { count: number }>();
  let ignored = 0;
  let dropped = 0;
  items.forEach((item, index) => {
    if (index >= MAX_ITEMS_SCANNED) {
      dropped += 1;
      return;
    }
    const violation = toViolation(item);
    if (!violation) {
      ignored += 1;
      return;
    }
    const key = JSON.stringify(violation);
    const seen = unique.get(key);
    if (seen) {
      seen.count += 1;
    } else if (unique.size >= CSP_REPORT_MAX_PER_REQUEST) {
      dropped += 1;
    } else {
      unique.set(key, { ...violation, count: 1 });
    }
  });
  return { violations: [...unique.values()], ignored, dropped };
}
