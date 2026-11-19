import { toConfirmOrder, type AiPreviewOrder } from './ai-preview';

/**
 * Telegram bot AI — `toConfirmOrder` kalitlar OQ RO'YXATI.
 *
 * Bot model chiqishini (ai-parse preview) ai-confirm payloadiga o'zi
 * aylantiradi. Model chiqishi (preview) `operator_id`, `customer_id`,
 * `operator_phone`, `verified_operator_id` (va boshqa formaga xos
 * maydonlar) ni HECH QACHON bera olmaydi — preview'da (injection,
 * kelajakdagi maydon) bo'lsa ham. `operator_id` / `operator_phone` faqat
 * ODAM yo'lidan — `toConfirmOrder` ning `extra` argumenti («🎧 Operator»
 * tanlovi, aktor profil raqami); `customer_id` bot hech qachon yubormaydi.
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

  it('odam tanlovi (extra) — operator_id / operator_phone FAQAT shundan; preview qiymati e’tiborsiz', () => {
    const body = toConfirmOrder(hostilePreview(), null, {
      operator_id: '31',
      operator_phone: '+998900000077',
    }) as Record<string, unknown>;
    expect(body.operator_id).toBe('31');
    expect(body.operator_phone).toBe('+998900000077');
    const serialized = JSON.stringify(body);
    for (const key of FORBIDDEN_KEYS.filter(
      (k) => k !== 'operator_id' && k !== 'operator_phone',
    )) {
      expect(serialized).not.toContain(`"${key}"`);
    }
    // Preview'dagi `operator_id: '26'` hech qayerda yo'q.
    expect(serialized).not.toContain('"26"');
  });

  it('odam tanlovi noto‘g‘ri shaklda — yuborilmaydi', () => {
    const body = toConfirmOrder(hostilePreview(), null, {
      operator_id: 'abc',
      operator_phone: '901234567',
    }) as Record<string, unknown>;
    expect(body).not.toHaveProperty('operator_id');
    expect(body).not.toHaveProperty('operator_phone');
  });

  it('operator — faqat matn sifatida o‘tadi', () => {
    const body = toConfirmOrder(hostilePreview(), null) as Record<
      string,
      unknown
    >;
    expect(body.operator).toBe('operator matni');
  });
});
