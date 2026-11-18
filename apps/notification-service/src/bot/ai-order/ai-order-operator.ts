import { escapeTelegramHtml, normalizeUzPhone, Roles } from '@app/common';
import type { TelegramAiDraftMeta } from '../../entities/telegram-ai-draft.entity';

/**
 * Bot AI: «👤 Operator» tanlovi va operator raqami (ai-confirm
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
 *    market operatori — server «majburiy» degandan keyin o'z profil raqami
 *    (market sozlamasi operatorga ko'rinmaydi). Raqam bo'sh — yuborilmaydi.
 */

/** Tanlash oynasida ko'pi bilan shuncha operator (ortig'i — kabinetda). */
export const AI_OPERATOR_MAX_OPTIONS = 20;

/** ai-confirm 400 matni (gateway `OPERATOR_PHONE_REQUIRED_MESSAGE`). */
export const OPERATOR_PHONE_REQUIRED_RE = /operator telefon raqami majburiy/i;

export const AI_OPERATOR_NONE_TEXT = '🚫 Tanlamaslik';
export const AI_RETRY_HINT_TEXT =
  '🔁 Ba’zi buyurtmalar yaratilmadi — «✅ Yaratish» ni qayta bosing (yaratilganlari takrorlanmaydi).';
export const AI_OPERATOR_PHONE_RETRY_TEXT =
  '📞 Marketda operator raqami majburiy — qayta bosilganda profilingizdagi raqam yuboriladi.';

const clip = (value: unknown, max: number): string => {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const operatorId = (value: unknown): string | null => {
  const id = clip(value, 20);
  return /^\d{1,19}$/.test(id) ? id : null;
};

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
    const id = operatorId(entry?.id);
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

/** Kartadagi tugma: «👤 Operator: <ism|tanlanmagan>». */
export const operatorButtonLabel = (meta: TelegramAiDraftMeta): string =>
  `👤 Operator: ${clip(meta.operator_name, 30) || 'tanlanmagan'}`;

/** Tanlash oynasi matni (HTML). */
export function operatorPickerText(meta: TelegramAiDraftMeta): string {
  const shown = storedOperators(meta).length;
  const hidden = Math.trunc(Number(meta.operators_total) || 0) - shown;
  return [
    '👤 <b>Buyurtma operatori</b> — ro‘yxatdagi hamma buyurtmaga qo‘yiladi.',
    `Hozir: ${escapeTelegramHtml(clip(meta.operator_name, 60)) || 'tanlanmagan'}`,
    ...(hidden > 0
      ? [`… yana ${hidden} ta — kerakli operator bo‘lmasa kabinetda yarating.`]
      : []),
  ].join('\n');
}

/** Odam tanlagan operator id'si — faqat market va to'g'ri shakl bo'lsa. */
export const chosenOperatorId = (meta: TelegramAiDraftMeta): string | null =>
  canChooseOperator(meta) ? operatorId(meta.operator_id) : null;

/**
 * Profil (`GET /auth/my-profile` `data`) → yuboriladigan operator raqami.
 *  - market: `require_operator_phone` va doimiy raqam yo'q bo'lsa — o'z
 *    (market) raqami; aks holda yuborilmaydi (talab qilmaydigan market
 *    chekida 2-raqam paydo bo'lmasin);
 *  - market operatori: `needed` (server «majburiy» degan) bo'lsa — o'z
 *    raqami.
 * Raqam normallashmasa — null (yuborilmaydi).
 */
export function profileOperatorPhone(
  meta: TelegramAiDraftMeta,
  profile: unknown,
): string | null {
  const p = (profile ?? {}) as {
    phone_number?: unknown;
    require_operator_phone?: unknown;
    default_operator_phone?: unknown;
  };
  const own = normalizeUzPhone(p.phone_number);
  if (meta.role === Roles.MARKET) {
    return p.require_operator_phone === true &&
      !normalizeUzPhone(p.default_operator_phone)
      ? own
      : null;
  }
  return meta.operator_phone_needed === true ? own : null;
}

/** Profil so'rash kerakmi (har «✅» da emas — faqat raqam kerak bo'lishi mumkin bo'lsa). */
export const needsProfilePhone = (meta: TelegramAiDraftMeta): boolean =>
  meta.role === Roles.MARKET || meta.operator_phone_needed === true;

/**
 * Qayta «✅» bilan hal bo'ladigan natija: `validation_unavailable` (server
 * tekshira olmadi, buyurtma ANIQ yaratilmagan) yoki market operatorida
 * birinchi marta «operator raqami majburiy» (keyingi bosish raqam bilan).
 */
export function isRetryableResult(
  meta: TelegramAiDraftMeta,
  result: { ok?: boolean; code?: unknown; reason?: unknown },
): boolean {
  if (result.ok) return false;
  if (result.code === 'validation_unavailable') return true;
  return (
    meta.role === Roles.MARKET_OPERATOR &&
    meta.operator_phone_needed !== true &&
    typeof result.reason === 'string' &&
    OPERATOR_PHONE_REQUIRED_RE.test(result.reason)
  );
}
