/**
 * Tuman LLM fallback JSON sxemasi (5Z1ZvvzE): faqat `{picks:[{item_index,
 * choice}]}` — `district_id` sxemada YO'Q, model ID to'qiy olmaydi. Diapazon
 * tekshiruvi order-service'da (`k<1 || k>pool.length` rad). Sxema
 * `prompt-hash.spec.ts` bilan qulflangan.
 */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const DISTRICT_PICK_SCHEMA: Record<string, unknown> = deepFreeze({
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
