import type { RawOrderExtraction } from '@app/common';

/**
 * Buyurtma ekstraksiyasi JSON sxemasi (yxwpN5h5, 32fNx0Ci; C2/C12).
 * `output_config.format = {type:'json_schema', schema}` bilan API darajasida
 * majburlanadi — model sxemadan tashqari kalit/qiymat qaytara olmaydi.
 *
 * ⚠️ QOIDALAR (buzilsa `order-extract.prompt.spec.ts` qizaradi):
 * - HECH QACHON `*_id` kaliti yo'q (district_id / product_id / region_id /
 *   market_id). Elchi ID'lari bigint satr ("1", "160") — model "ishonarli"
 *   soxta ID qaytarsa u BOSHQA haqiqiy tumanga/mahsulotga tushib ketadi va
 *   xato jimgina o'tadi. ID'ni faqat KOD (rezolver) qo'yadi.
 * - Har obyekt `additionalProperties:false`, hamma maydon `required`,
 *   ixtiyoriylik faqat `['string','null']` tip massivi bilan.
 * - minimum / maximum / minLength YO'Q: structured outputs ularni qo'llamaydi
 *   (so'rov 400 bilan qaytadi). Son chegaralari (quantity 1..1000, narx >0,
 *   30 buyurtma, 50 mahsulot) sanitize va ai-confirm DTO'sida tekshiriladi.
 * - Sxema BAYTMA-BAYT barqaror: har o'zgarish Anthropic prompt keshini
 *   yangidan yozdiradi (`prompt-hash.spec.ts` sha256 bilan qulflangan) —
 *   o'zgarish faqat ALOHIDA karta bilan.
 */

/** Rekursiv muzlatish — umumiy sxema obyektini hech bir modul o'zgartira olmasin. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Bitta mahsulot qatori: faqat NOM va SON (ID ham, narx ham emas). */
export const ORDER_EXTRACT_ITEM_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    quantity: { type: 'integer' },
  },
  required: ['name', 'quantity'],
});

/**
 * 13 ta maydon — `RawOrderExtraction` (libs/common/src/ai) bilan
 * KOMPILYATSIYA darajasida bog'langan: tipga maydon qo'shilsa yoki
 * o'chirilsa, bu obyekt tsc'dan o'tmaydi. Kalitlar tartibi = `required`
 * tartibi (sxema JSON'i deterministik).
 */
const ORDER_PROPERTIES: Record<
  keyof RawOrderExtraction,
  Record<string, unknown>
> = {
  customer_name: { type: ['string', 'null'] },
  phone_number: { type: ['string', 'null'] },
  extra_number: { type: ['string', 'null'] },
  region_name: { type: ['string', 'null'] },
  district_name: { type: ['string', 'null'] },
  address: { type: ['string', 'null'] },
  full_address: { type: ['string', 'null'] },
  items: { type: 'array', items: ORDER_EXTRACT_ITEM_SCHEMA },
  total_price: { type: ['number', 'null'] },
  comment: { type: ['string', 'null'] },
  // Elchi `Where_deliver` enum'i (libs/common/enums/index.ts: CENTER/ADDRESS) —
  // model boshqa qiymat qaytara olmaydi; null = matnda aytilmagan.
  where_deliver: {
    type: ['string', 'null'],
    enum: ['center', 'address', null],
  },
  is_replacement: { type: 'boolean' },
  operator: { type: ['string', 'null'] },
};

/** Sxemadagi 13 ta required maydon nomi (sxema bilan bir xil tartibda). */
export const ORDER_EXTRACT_FIELDS: ReadonlyArray<keyof RawOrderExtraction> =
  Object.freeze(Object.keys(ORDER_PROPERTIES) as (keyof RawOrderExtraction)[]);

/** Bitta buyurtma obyekti — 13 ta required, nullable maydon. */
export const ORDER_EXTRACT_ORDER_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: ORDER_PROPERTIES,
  required: [...ORDER_EXTRACT_FIELDS],
});

/**
 * YAGONA ekstraksiya sxemasi — doim ko'p-buyurtma shakli `{orders:[...]}`
 * (matn ham, rasm ham). Bitta buyurtma bo'lsa massivda bitta element.
 */
export const ORDER_EXTRACT_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    orders: { type: 'array', items: ORDER_EXTRACT_ORDER_SCHEMA },
  },
  required: ['orders'],
});
