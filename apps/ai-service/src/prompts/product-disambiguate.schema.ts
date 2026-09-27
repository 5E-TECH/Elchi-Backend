/**
 * Mahsulot disambiguation JSON sxemasi (luv25zlI; C2 `ai.product.disambiguate`).
 *
 * ⚠️ Model faqat RAQAM qaytaradi: `item_index` (qaysi mahsulot qatori) va
 * `choice` (katalogdagi 1-asosli indeks, 0 = mos yo'q). `product_id` sxemada
 * YO'Q — ID'ni order-service KOD tomonda `catalog[choice-1]` dan, diapazon,
 * egalik va raqam-token tekshiruvidan keyin oladi. Model ID to'qiy olmaydi.
 *
 * minimum/maximum yo'q (structured outputs qo'llamaydi) — diapazon
 * tekshiruvi order-service'da. Sxema `prompt-hash.spec.ts` bilan qulflangan.
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const PRODUCT_DISAMBIG_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item_index: { type: 'integer' },
          choice: { type: 'integer' },
        },
        required: ['item_index', 'choice'],
      },
    },
  },
  required: ['picks'],
});
