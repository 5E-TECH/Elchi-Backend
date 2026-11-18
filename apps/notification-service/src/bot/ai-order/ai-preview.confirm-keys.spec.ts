import { toConfirmOrder, type AiPreviewOrder } from './ai-preview';

/**
 * Telegram bot AI — `toConfirmOrder` kalitlar OQ RO'YXATI.
 *
 * Bot model chiqishini (ai-parse preview) ai-confirm payloadiga SERVER
 * tomonda o'zi aylantiradi — operatorni ham, mijozni ham odam select'da
 * tanlamaydi. Shu sabab `operator_id`, `customer_id`, `operator_phone`,
 * `verified_operator_id` (va boshqa formaga xos maydonlar) bot payloadiga
 * HECH QACHON tushmasligi kerak — preview'da (injection, kelajakdagi
 * maydon) bo'lsa ham. Gateway bu maydonlarni ai-confirm'da qabul qiladi
 * (veb AI paneli uchun), shu bois kafolat — shu yerda.
 */
const ALLOWED_ORDER_KEYS = new Set([
  'customer',
  'district_id',
  'draft_id',
  'ai_item_index',
  'items',
  'total_price',
  'replaced_order_id',
  'ack_checks',
  'where_deliver',
  'address',
  'comment',
  'operator',
]);
const ALLOWED_CUSTOMER_KEYS = new Set([
  'name',
  'phone_number',
  'district_id',
  'extra_number',
  'address',
]);
const ALLOWED_ITEM_KEYS = new Set([
  'product_id',
  'product_name',
  'allow_unlisted_product',
  'quantity',
]);
const FORBIDDEN_KEYS = [
  'operator_id',
  'customer_id',
  'operator_phone',
  'secondary_operator_phone',
  'verified_operator_id',
  'market_id',
  'branch_id',
];

/** Sintetik preview + ataylab qo'shilgan begona (injection) maydonlar. */
const hostilePreview = (): AiPreviewOrder =>
  ({
    index: 0,
    ready: true,
    issues: [],
    customer_name: 'Mijoz Sintetik',
    phone_number: '+998901234567',
    extra_number: '+998901234568',
    district_id: '12',
    address: 'Sintetik manzil',
    items: [
      { name: 'Mahsulot', quantity: 1, product_id: '15', operator_id: '26' },
      { name: 'Katalogda yo‘q', quantity: 2, customer_id: '120' },
    ],
    total_price: 100000,
    where_deliver: 'address',
    comment: 'izoh',
    operator: 'operator matni',
    checks: [{ code: 'price_check' }],
    acked_checks: ['price_check'],
    operator_id: '26',
    customer_id: '120',
    operator_phone: '+998907654321',
    secondary_operator_phone: '+998907654322',
    verified_operator_id: '26',
    market_id: '77',
    branch_id: '3',
    customer: { customer_id: '120', operator_id: '26' },
  }) as unknown as AiPreviewOrder;

describe('toConfirmOrder — kalitlar oq ro‘yxati (bot ai-confirm payloadi)', () => {
  it('faqat ruxsat etilgan kalitlar; forma maydonlari (operator_id, customer_id, operator_phone, verified_operator_id) YO‘Q', () => {
    const body = toConfirmOrder(
      hostilePreview(),
      '11111111-2222-4333-8444-555555555555',
    ) as Record<string, unknown>;

    for (const key of Object.keys(body)) {
      expect(ALLOWED_ORDER_KEYS).toContain(key);
    }
    const customer = body.customer as Record<string, unknown>;
    for (const key of Object.keys(customer)) {
      expect(ALLOWED_CUSTOMER_KEYS).toContain(key);
    }
    for (const item of body.items as Array<Record<string, unknown>>) {
      for (const key of Object.keys(item)) {
        expect(ALLOWED_ITEM_KEYS).toContain(key);
      }
    }
    const serialized = JSON.stringify(body);
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it('operator — faqat matn sifatida o‘tadi', () => {
    const body = toConfirmOrder(hostilePreview(), null) as Record<
      string,
      unknown
    >;
    expect(body.operator).toBe('operator matni');
  });
});
