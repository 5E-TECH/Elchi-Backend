export const OUTBOX_TARGETS = Symbol('OUTBOX_TARGETS');
export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

/**
 * Doimiy BO'LMAGAN hodisa shuncha urinishdan keyin `failed` (poison) bo'ladi
 * (sukut, avvalgidek 10).
 */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 10;

/**
 * PUL hodisalari — hech qachon `failed` (poison) ga o'tkazilmaydi (audit M8).
 *
 * ⚠️ NEGA. Bu hodisalarning qayta yuborish yo'li YO'Q: `failed` bo'lgan
 * hodisani hech kim qayta o'ynamaydi. Ilgari 10 urinish (backoff 1+2+…+60 s,
 * ~4-5 daqiqa) dan keyin hodisa abadiy tashlab yuborilardi — ya'ni maqsad
 * servis (finance / order) ~5 daqiqa ishlamay tursa, kassa bir tomonda
 * ko'chgan, daftar esa hech qachon yetib olmagan bo'lardi. Endi bunday
 * hodisa 60 s lik chegarada CHEKSIZ qayta uriniladi; uzoq qotib qolgani
 * "stuck" ogohlantirishi bilan ko'rsatiladi.
 *
 * Yozuv: aniq pattern yoki `*` bilan tugaydigan prefiks.
 *   • `finance.*` — finance'ga outbox orqali boradigan HAR BIR yozuv pul:
 *     `finance.cashbox.update_balance` (sotuv oyoqlari),
 *     `finance.financial_balance.record`, `finance.operator.earning.*`;
 *   • `order.settlement.advance` — kassa ko'chgandan keyin per-order FIFO
 *     daftarini yetkazadi (finance → order).
 *
 * Qabul qiluvchilar takroriy yetkazishga chidamli: finance yozuvlari dedup
 * kaliti bilan, advance esa `request_id` idempotentligi bilan.
 */
export const DEFAULT_PERSISTENT_OUTBOX_PATTERNS: readonly string[] =
  Object.freeze(['finance.*', 'order.settlement.advance']);

/** `pattern` doimiy (poison qilinmaydigan) ro'yxatga tushadimi. */
export function isPersistentOutboxPattern(
  pattern: string,
  patterns: readonly string[] = DEFAULT_PERSISTENT_OUTBOX_PATTERNS,
): boolean {
  const value = String(pattern ?? '');
  if (!value) {
    return false;
  }
  return patterns.some((entry) => {
    const rule = String(entry ?? '');
    if (!rule) {
      return false;
    }
    return rule.endsWith('*')
      ? value.startsWith(rule.slice(0, -1))
      : value === rule;
  });
}

export interface OutboxOptions {
  /** How often the publisher polls for due events (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Max events processed per tick. Default 50. */
  batchSize?: number;
  /** Per-event publish timeout (ms). Default 5000. */
  publishTimeoutMs?: number;
  /**
   * How often to check for FAILED (poison) events and raise an alert (ms).
   * Default 60000. A 'failed' event is terminal — never retried and invisible
   * to getDuePending — so without this check a stuck money/state event would
   * sit silently forever.
   */
  failedAlertIntervalMs?: number;
  /**
   * Doimiy BO'LMAGAN hodisa shuncha urinishdan keyin `failed` bo'ladi.
   * Sukut 10 (avvalgidek).
   */
  maxAttempts?: number;
  /**
   * Hech qachon `failed` ga o'tmaydigan patternlar (aniq yoki `prefix*`).
   * Sukut `DEFAULT_PERSISTENT_OUTBOX_PATTERNS` (pul hodisalari). `[]` —
   * eski xatti-harakat: hamma narsa `maxAttempts` dan keyin poison.
   */
  persistentPatterns?: readonly string[];
  /**
   * Kamida shuncha urinishda hamon `pending` turgan hodisa "qotib qolgan"
   * hisoblanadi: har tekshiruvda error log, soni o'zgarganda Sentry.
   * Sukut 10 — eski poison chegarasi bilan bir xil vaqtda ogohlantiradi.
   */
  stuckAlertAttempts?: number;
}
