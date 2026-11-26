/**
 * «Tashqi saytlar» importi: narx MINGLIK BO'SHLIG'I bilan yozilgan bo'lsa.
 *
 * Ega qarori 2026-11-25: «150 000» — 150000. FAQAT shu yozuv qabul qilinadi.
 * Vergul, nuqta, valyuta («99,000», «150.000,50», «150 000 so'm») bu yerda
 * O'QILMAYDI: 99 ming yoki 99 ekanini taxmin qilish moliyani buzardi — kengaytirish
 * uchun egadan qayta so'raladi.
 *
 * ⚠️ Faqat import narxi uchun. Onlayn to'lov summasi (`safeExternalAmount` ni
 * to'g'ridan-to'g'ri chaqiradi) avvalgidek qat'iy.
 *
 * Elchi-Frontend `src/pages/new_orders/sites/model/siteOrder.ts` (`readAmount`)
 * shu qoidaning nusxasi — qoida o'zgarsa ikkalasi birga o'zgaradi.
 */

/**
 * 1–3 raqam, so'ng bittadan bo'shliq bilan 3 tadan 1–3 guruh (12 xonagacha —
 * `numeric(14,2)` ga sig'adi). Bo'shliq: oddiy, NBSP, tor NBSP, ingichka.
 */
const GROUPED_THOUSANDS = /^[1-9]\d{0,2}(?:[ \u00a0\u202f\u2009]\d{3}){1,3}$/;

/** «150 000» → «150000»; boshqa har qanday qiymat O'ZGARMAYDI. */
export function ungroupThousands(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return GROUPED_THOUSANDS.test(text) ? text.replace(/\D/g, '') : value;
}

/** `orders.total_price` — numeric(14,2): yaxlitlangani 10^12 dan kichik. */
const PRICE_LIMIT = 1e12;

/** Sig'masa INSERT yiqilib, import partiyasi yarim yo'lda uzilardi. */
export const fitsOrderPrice = (amount: number): boolean =>
  Math.abs(Number(amount.toFixed(2))) < PRICE_LIMIT;
