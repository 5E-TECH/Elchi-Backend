/**
 * vf4513Zn — BOSHQA foydalanuvchining javobga qo'shiladigan MINIMAL ko'rinishi.
 *
 * Kassa tarixidagi `source_user` / `created_by_user` (`sourceUser` /
 * `createdByUser`) va kassa egasi `cashbox.user` ilgari identity'ning TO'LIQ
 * yozuvi edi: kuryer o'z kassasida market'ning `tariff_home` /
 * `tariff_center`, `salary`, `commission_*`, `ai_price_per_order` ini, market
 * esa kuryerning tarifi/maoshini ko'rardi (kH2zZsz3 qoidasini chetlab o'tib).
 *
 * Endi faqat ALLOWLIST: `id`, `name`, `role`, `phone_number`. Telefon — chunki
 * Elchi-Frontend tarix tafsiloti (FinanceHistoryDetailPopup: «Kimdan/Kimga»
 * ostidagi telefon) va kassa sahifasi (cashDetail: ism bo'lmasa telefon) uni
 * o'qiydi; kuryer market telefonini buyurtmada ham ko'radi. Yangi maydon
 * kerak bo'lsa — shu yerga ANIQ qo'shiladi (identity yozuvi hech qachon
 * yoyilmaydi).
 */
export interface PublicUserSummary {
  id: string;
  name: string | null;
  role: string | null;
  phone_number: string | null;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint'
    ? String(value).trim()
    : '';

/**
 * identity foydalanuvchi yozuvidan (`identity.user.find_by_id` ning `data`
 * qismi) `PublicUserSummary`. Obyekt bo'lmasa yoki id aniqlanmasa — `null`.
 * `fallbackId` — so'ralgan id (yozuvda `id` bo'lmasa).
 */
export function toPublicUserSummary(
  user: unknown,
  fallbackId?: string | number | null,
): PublicUserSummary | null {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    return null;
  }
  const raw = user as Record<string, unknown>;
  const id = asText(raw.id) || asText(fallbackId);
  if (!id) {
    return null;
  }
  return {
    id,
    name: asText(raw.name) || null,
    role: asText(raw.role) || null,
    phone_number: asText(raw.phone_number) || null,
  };
}
