import {
  escapeTelegramHtml,
  normalizeUzPhone,
  ORDER_CREATE_ERROR_CODES,
  Roles,
} from '@app/common';
import type { TelegramAiDraftMeta } from '../../entities/telegram-ai-draft.entity';

/**
 * Bot AI: «🎧 Operator» tanlovi va operator raqami (ai-confirm
 * `orders[].operator_id` / `orders[].operator_phone`, #715/#716).
 *
 *  - Tanlov FAQAT market egasiga (market operatori operator_id yubormaydi —
 *    FE shartnomasi; server ham market operatoriga faqat o'zini tanlatadi).
 *    Ro'yxat — `GET /market-operators/selectable` (aktor JWT), tanlov
 *    qoralama bo'yicha BITTA (hamma buyurtmaga), `meta.operator_id`.
 *  - `operator_id` faqat ODAM tanlaganda yuboriladi: model chiqishi
 *    (preview) uni hech qachon bera olmaydi — `toConfirmOrder` uni faqat
 *    `extra` dan oladi.
 *  - Operator raqami: market — profil (`GET /auth/my-profile`) bo'yicha
 *    raqam majburiy va doimiy raqam yo'q bo'lsa marketning o'z raqami;
 *    server «majburiy» desa (har ikki rol) — bir marta qayta urinish, o'z
 *    profil raqami bilan. Raqam bo'sh — yuborilmaydi.
 */

/** Tanlash oynasida ko'pi bilan shuncha operator (ortig'i — kabinetda). */
export const AI_OPERATOR_MAX_OPTIONS = 20;

/** ZAXIRA (eski gateway, `reason_code` yo'q): ai-confirm 400 matni (`OPERATOR_PHONE_REQUIRED_MESSAGE`). */
export const OPERATOR_PHONE_REQUIRED_RE = /operator telefon raqami majburiy/i;
/**
 * ZAXIRA (`reason_code` yo'q): ai-confirm 400 matni — tanlangan operator rad etildi (gateway
 * `CHOSEN_OPERATOR_NOT_SELECTABLE_MESSAGE` / `…_ID_FORMAT_MESSAGE`).
 */
export const OPERATOR_REJECTED_RE =
  /tanlangan operator|operator_id operator id/i;
/**
 * Kalitdan (order-service) OLDIN yuz beradigan, buyurtma ANIQ yaratilmagan
 * kodlar — qayta yuborish xavfsiz.
 */
const RETRYABLE_CODES = new Set(['validation_unavailable', 'not_started']);

export const AI_OPERATOR_NONE_TEXT = '🚫 Tanlamaslik';
export const AI_RETRY_HINT_TEXT =
  '🔁 Ba’zi buyurtmalar yaratilmadi — «✅ Yaratish» ni qayta bosing (yaratilganlari takrorlanmaydi).';
export const AI_RETRY_ALL_HINT_TEXT =
  '🔁 Buyurtmalar yaratilmadi — «✅ Yaratish» ni qayta bosing.';
export const AI_OPERATOR_PHONE_RETRY_TEXT =
  '📞 Marketda operator raqami majburiy — qayta bosilganda profilingizdagi raqam yuboriladi.';
export const AI_OPERATOR_REJECTED_TEXT =
  '🎧 Tanlangan operator qabul qilinmadi — tanlov olib tashlandi, «🎧 Operator» dan boshqasini tanlang yoki shundayicha yarating.';
/** Natijasi noma'lum buyurtma bor — «🎧 Operator» yopiq. */
export const AI_OPERATOR_REJECTED_LOCKED_TEXT =
  '🎧 Tanlangan operator qabul qilinmadi — tanlov olib tashlandi; «✅ Yaratish» operatorsiz yuboradi, boshqa operator — kabinetda.';

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const INT8_MAX = 9223372036854775807n;

/**
 * Operator id'si — ai-confirm shartnomasi: `^[1-9]\d{0,18}$` va ≤ INT8_MAX
 * ('0', '007' kabi qiymat butun so'rovni 400 qilardi).
 */
export function validOperatorId(value: unknown): string | null {
  const id = clip(value, 20);
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= INT8_MAX ? id : null;
}

/** Qoralama meta'si (bo'lmasa bo'sh). */
export const metaOf = (input: unknown): TelegramAiDraftMeta => {
  const meta = (input as { meta?: unknown } | null)?.meta;
  return meta && typeof meta === 'object' ? meta : {};
};

/** Tanlov shu aktor uchunmi: faqat market egasi. */
export const canChooseOperator = (meta: TelegramAiDraftMeta): boolean =>
  meta.role === Roles.MARKET;

/**
 * `GET /market-operators/selectable` javobi
 * (`{ data: { items: [{ id, name }] } }`) → ro'yxat (≤20) va jami soni.
 */
export function operatorsFromResponse(body: unknown): {
  options: Array<{ id: string; name: string }>;
  total: number;
} {
  const items = (body as { data?: { items?: unknown } } | null)?.data?.items;
  const all: Array<{ id: string; name: string }> = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const entry = raw as { id?: unknown; name?: unknown } | null;
    const id = validOperatorId(entry?.id);
    const name = clip(entry?.name, 60);
    if (!id || !name || all.some((o) => o.id === id)) continue;
    all.push({ id, name });
  }
  return { options: all.slice(0, AI_OPERATOR_MAX_OPTIONS), total: all.length };
}

/** Saqlangan operatorlar (faqat to'g'ri shakldagilar). */
export function storedOperators(
  meta: TelegramAiDraftMeta,
): Array<{ id: string; name: string }> {
  return operatorsFromResponse({ data: { items: meta.operators } }).options;
}

/** Kartadagi tugma: «🎧 Operator: <ism|tanlanmagan>». */
export const operatorButtonLabel = (meta: TelegramAiDraftMeta): string =>
  `🎧 Operator: ${clip(meta.operator_name, 30) || 'tanlanmagan'}`;

/** Tanlash oynasi matni (HTML). */
export function operatorPickerText(
  meta: TelegramAiDraftMeta,
  /** Ba'zi buyurtmalar allaqachon yaratilgan — tanlov ularga tegmaydi. */
  partial = false,
): string {
  const shown = storedOperators(meta).length;
  const hidden = Math.trunc(Number(meta.operators_total) || 0) - shown;
  return [
    partial
      ? '🎧 <b>Buyurtma operatori</b> — hali yaratilmagan buyurtmalarga qo‘yiladi (yaratilganlari o‘zgarmaydi).'
      : '🎧 <b>Buyurtma operatori</b> — ro‘yxatdagi hamma buyurtmaga qo‘yiladi.',
    `Hozir: ${escapeTelegramHtml(clip(meta.operator_name, 60)) || 'tanlanmagan'}`,
    ...(hidden > 0
      ? [`… yana ${hidden} ta — kerakli operator bo‘lmasa kabinetda yarating.`]
      : []),
  ].join('\n');
}

/** Odam tanlagan operator id'si — faqat market va to'g'ri shakl bo'lsa. */
export const chosenOperatorId = (meta: TelegramAiDraftMeta): string | null =>
  canChooseOperator(meta) ? validOperatorId(meta.operator_id) : null;

/** Profil (`GET /auth/my-profile` `data`) → kesh (`meta.profile`). */
export function profileOf(profile: unknown): {
  phone: string;
  required: boolean;
} | null {
  const p = (profile ?? {}) as {
    phone_number?: unknown;
    require_operator_phone?: unknown;
    default_operator_phone?: unknown;
  };
  // Raqam normallashmasa — keshlanmaydi (null): keyingi «✅» qayta so'raydi
  // (profil tuzatilgan bo'lishi mumkin).
  const phone = normalizeUzPhone(p.phone_number);
  if (!phone) return null;
  return {
    phone,
    required:
      p.require_operator_phone === true &&
      !normalizeUzPhone(p.default_operator_phone),
  };
}

/**
 * Yuboriladigan operator raqami (profil keshidan):
 *  - server «majburiy» degan (`operator_phone_needed`) — o'z raqami;
 *  - market: raqam majburiy va doimiy raqam yo'q — o'z (market) raqami;
 *  - aks holda yuborilmaydi (talab qilmaydigan market chekida 2-raqam
 *    paydo bo'lmasin). Raqam normallashmasa — null.
 */
export function operatorPhoneOf(
  meta: TelegramAiDraftMeta,
  profile: { phone: string | null; required: boolean } | null,
): string | null {
  if (!profile) return null;
  if (meta.operator_phone_needed === true) return profile.phone;
  return meta.role === Roles.MARKET && profile.required ? profile.phone : null;
}

/** Profil so'rash kerakmi (har «✅» da emas — faqat raqam kerak bo'lishi mumkin bo'lsa). */
export const needsProfilePhone = (meta: TelegramAiDraftMeta): boolean =>
  meta.role === Roles.MARKET || meta.operator_phone_needed === true;

type ResultLike = {
  ok?: boolean;
  code?: unknown;
  reason?: unknown;
  /** #722: mashina o'qiydigan sabab (faqat `ok:false` da). */
  reason_code?: unknown;
};

/** Operator tanlovi rad etilganini bildiruvchi `reason_code` lar. */
const OPERATOR_REJECTED_CODES: ReadonlySet<string> = new Set([
  ORDER_CREATE_ERROR_CODES.CHOSEN_OPERATOR_NOT_SELECTABLE,
  // Market operatori operator_id yubormaydi — amalda kelmaydi; kelsa ham
  // NOT_SELECTABLE kabi (tanlov olib tashlanadi, ro'yxat yangilanadi).
  ORDER_CREATE_ERROR_CODES.CHOSEN_OPERATOR_SELF_ONLY,
]);

/**
 * Natija sababi: `reason_code` (#722) bo'lsa — FAQAT u (noma'lum kod →
 * `null`, umumiy xato); yo'q bo'lsa (eski gateway) — matn bo'yicha zaxira.
 */
function reasonKind(result: ResultLike): 'phone' | 'operator' | null {
  if (typeof result.reason_code === 'string' && result.reason_code) {
    if (result.reason_code === ORDER_CREATE_ERROR_CODES.OPERATOR_PHONE_REQUIRED)
      return 'phone';
    return OPERATOR_REJECTED_CODES.has(result.reason_code) ? 'operator' : null;
  }
  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (OPERATOR_PHONE_REQUIRED_RE.test(reason)) return 'phone';
  return OPERATOR_REJECTED_RE.test(reason) ? 'operator' : null;
}

/** «Operator raqami majburiy» — hali qayta urinilmagan bo'lsa (har ikki rol). */
export const isPhoneRetry = (
  meta: TelegramAiDraftMeta,
  result: ResultLike,
): boolean =>
  !result.ok &&
  meta.operator_phone_needed !== true &&
  reasonKind(result) === 'phone';

/**
 * Odam tanlagan operator rad etildi (kalitdan oldin — qayta xavfsiz).
 * Tanlov yuborilmagan bo'lsa qayta urinish ma'nosiz (ayni javob) — umumiy
 * xato.
 */
export const isOperatorRejected = (
  meta: TelegramAiDraftMeta,
  result: ResultLike,
): boolean =>
  !result.ok &&
  chosenOperatorId(meta) !== null &&
  reasonKind(result) === 'operator';

/**
 * Qayta «✅» bilan hal bo'ladigan natija (server kalitidan OLDIN, buyurtma
 * ANIQ yaratilmagan): `validation_unavailable`, `not_started`, birinchi
 * «operator raqami majburiy», rad etilgan operator tanlovi.
 */
export function isRetryableResult(
  meta: TelegramAiDraftMeta,
  result: ResultLike,
): boolean {
  if (result.ok) return false;
  if (typeof result.code === 'string' && RETRYABLE_CODES.has(result.code)) {
    return true;
  }
  return isPhoneRetry(meta, result) || isOperatorRejected(meta, result);
}

/**
 * Foydalanuvchiga ko'rinadigan server sababi: API maydon nomlari
 * («(operator_phone)») olib tashlanadi.
 */
export const userReason = (reason: unknown): string =>
  (typeof reason === 'string' ? reason : '')
    // Faqat API maydon nomlari (pastki chiziqli: «(operator_phone)»), oddiy
    // so'zlar («(raqam)», «(viloyat)») qoladi.
    .replace(/\s*\([a-z][a-z0-9]*(?:_[a-z0-9]+)+\)/g, '')
    .trim();
