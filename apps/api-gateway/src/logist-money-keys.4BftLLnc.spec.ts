import 'reflect-metadata';
import { of } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import {
  COURIER_HIDDEN_ORDER_FIELDS,
  LOGIST_HIDDEN_ORDER_FIELDS,
  LOGIST_MONEY_KEY_PATTERN,
  RESTRICTED_HIDDEN_ORDER_FIELDS,
  projectOrderPayloadForRoles,
} from './auth/order-role-projection';
import { OrderGatewayController } from './order-gateway.controller';
import { Order } from '../../order-service/src/entities/order.entity';
import { OrderItem } from '../../order-service/src/entities/order-item.entity';
import { OrderServiceService } from '../../order-service/src/order-service.service';
import { User } from '../../identity-service/src/entities/user.entity';
import { Product } from '../../catalog-service/src/entities/product.entity';
import { Region } from '../../logistics-service/src/entities/region.entity';
import { District } from '../../logistics-service/src/entities/district.entity';

/**
 * 4BftLLnc (prod tester, 2026-10-25): logist GET /orders va /orders/67 da
 * WAITING buyurtmalarda `sale_market_paid_max: 30000` (= summa 50 000 −
 * market tarifi 20 000) oldi — order-service enrich qo'shadigan kalit
 * LOGIST_HIDDEN_ORDER_FIELDS da yo'q edi va LOGIST_MONEY_KEY_PATTERN unga mos
 * kelmasdi. Bundan tashqari `order.market` profili ichida naqsh umuman
 * ishlamasdi (`default_tariff`, `extra_cost_*` qolardi).
 *
 * Bu spec order-service yuborishi mumkin bo'lgan TO'LIQ buyurtmani quradi:
 * Order/OrderItem/User/Product/Region/District entity'larining BARCHA
 * ustunlari (TypeORM metama'lumotidan — yangi ustun ham avtomatik kiradi),
 * HAQIQIY `enrichOrders` (market, mijoz, tuman, viloyat, kuryer, mahsulot,
 * ombor, `sale_market_paid_max`, `cancel_return`) va kuzatuv (tracking)
 * hodisalari (order-service `old_value`/`new_value`/`metadata` ga yozadigan
 * pul kalitlari bilan). Logist javobida pulga o'xshash BIRORTA kalit qolmasligi
 * tekshiriladi.
 */

type ColumnArgs = ReturnType<typeof getMetadataArgsStorage>['columns'][number];
type Row = Record<string, unknown>;

/** Entity (va BaseEntity ajdodlari) ustunlari. */
function columnsOf(target: object): ColumnArgs[] {
  const chain: unknown[] = [];
  let proto: unknown = target;
  while (typeof proto === 'function' && proto !== Function.prototype) {
    chain.push(proto);
    proto = Object.getPrototypeOf(proto);
  }
  return getMetadataArgsStorage().columns.filter((column) =>
    chain.includes(column.target),
  );
}

const ISO = '2026-10-25T10:00:00.000Z';

/** Ustun turiga mos namunaviy qiymat (null emas — kalit ham, qiymat ham bor). */
function sampleOf(column: ColumnArgs): unknown {
  const name = column.propertyName;
  if (['createDate', 'updateDate', 'deleteDate'].includes(column.mode)) {
    return ISO;
  }
  if (name === 'id' || /_id$/.test(name)) return '1';
  const enumValues = column.options.enum;
  if (enumValues) {
    const values = Array.isArray(enumValues)
      ? enumValues
      : Object.values(enumValues as object);
    return values[0];
  }
  const type =
    typeof column.options.type === 'string' ? column.options.type : '';
  if (type === 'boolean') return false;
  if (
    /^(int|integer|bigint|smallint|numeric|decimal|float|double precision|real)$/.test(
      type,
    )
  ) {
    return 12_345;
  }
  if (/^(timestamptz|timestamp|date)$/.test(type)) return ISO;
  if (/^jsonb?$/.test(type)) return null;
  return `${name}-qiymat`;
}

/** Entity'ning BARCHA ustunlari bilan yozuv + aniq qiymatlar. */
function fullRecord(target: object, overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of columnsOf(target)) {
    row[column.propertyName] = sampleOf(column);
  }
  return { ...row, ...overrides };
}

/** identity `sanitize` — maxfiy kalitlar yuborilmaydi. */
const sanitizedUser = (overrides: Row): Row => {
  const user = fullRecord(User, overrides);
  for (const key of [
    'password',
    'refresh_token',
    'session_epoch',
    'market_tg_token',
    'telegram_id',
  ]) {
    delete user[key];
  }
  return user;
};

const MARKET = sanitizedUser({
  id: '37',
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  role: 'market',
  tariff_center: 20_000,
  tariff_home: 25_000,
});
const CUSTOMER = sanitizedUser({
  id: '29',
  name: 'TEST Claude Mijoz',
  phone_number: '+998900000029',
  role: 'customer',
});
const COURIER = sanitizedUser({
  id: '26',
  name: 'TEST Claude Kuryer',
  phone_number: '+998900000026',
  role: 'courier',
  tariff_home: 15_000,
});

const orderOf = (id: string, overrides: Row): Row => ({
  ...fullRecord(Order, {
    market_id: '37',
    customer_id: '29',
    courier_id: '26',
    region_id: '3',
    district_id: '301',
    post_id: '5',
    branch_id: '3',
    where_deliver: 'center',
    total_price: 50_000,
    paid_online_amount: 0,
    paid_amount: 0,
    to_be_paid: 0,
    market_tariff: null,
    warehouse_id: null,
    fulfillment_source: 'HQ',
    replacement_of_order_id: null,
    parent_order_id: null,
    deleted_at: null,
    isDeleted: false,
  }),
  items: [
    fullRecord(OrderItem, {
      id: '901',
      order_id: id,
      product_id: '501',
      product_name: 'TEST mahsulot',
      quantity: 2,
    }),
  ],
  id,
  ...overrides,
});

/** Prod #67 kabi WAITING (sotish oynasi chegarasi bor) va kuryerdagi bekor. */
const RAW_ROWS: Row[] = [
  orderOf('67', { status: 'waiting' }),
  orderOf('68', {
    status: 'cancelled',
    holder_type: 'COURIER',
    holder_courier_id: '26',
  }),
];

/** HAQIQIY order-service `findAllEnriched` / `enrichOrders` javobi. */
async function enrichedList(): Promise<{ data: Row[] } & Row> {
  const respond = (pattern: { cmd: string }, payload: { ids?: string[] }) => {
    const ids = (payload?.ids ?? []).map(String);
    const pick = (record: Row) =>
      ids.includes(String(record.id)) ? [record] : [];
    switch (pattern.cmd) {
      case 'identity.market.find_by_ids':
        return of({ data: pick(MARKET) });
      case 'identity.customer.find_by_ids':
        return of({ data: pick(CUSTOMER) });
      case 'identity.user.find_by_ids':
        return of({ data: pick(COURIER) });
      case 'logistics.region.find_by_ids':
        return of({
          data: [
            fullRecord(Region, {
              id: '3',
              name: 'Andijon',
              logist_id: '94',
              districts: [fullRecord(District, { id: '301' })],
            }),
          ],
        });
      case 'logistics.district.find_by_ids':
        return of({
          data: [
            fullRecord(District, { id: '301', name: 'Asaka', region_id: '3' }),
          ],
        });
      case 'catalog.product.find_by_ids':
        return of({
          data: [
            fullRecord(Product, {
              id: '501',
              name: 'TEST mahsulot',
              user_id: '37',
              price: 99_000,
            }),
          ],
        });
      default:
        return of({ data: [] });
    }
  };
  const client = () => ({ send: jest.fn(respond) });
  const service = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  Object.assign(service, {
    identityClient: client(),
    logisticsClient: client(),
    catalogClient: client(),
    dataSource: { query: jest.fn().mockResolvedValue([]) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  jest.spyOn(service, 'findAll').mockResolvedValue({
    data: RAW_ROWS,
    total: RAW_ROWS.length,
    page: 1,
    limit: 10,
    total_pages: 1,
    totalPages: 1,
  } as never);
  return (await service.findAllEnriched({})) as never;
}

/**
 * Kuzatuv hodisalari — `getTrackingByOrderId` shakli; `old_value` /
 * `new_value` / `metadata` da order-service yozadigan pul kalitlari.
 */
const TRACKING = {
  data: [
    {
      id: 't1',
      event_type: 'status',
      order_id: '67',
      action: 'sold',
      from_status: 'waiting',
      to_status: 'paid',
      old_value: { status: 'waiting', total_price: 40_000 },
      new_value: {
        status: 'paid',
        total_price: 50_000,
        to_be_paid: 30_000,
        paid_amount: 30_000,
        sale_market_paid_amount: 30_000,
        paid_online_amount: 0,
        already_paid_online: 0,
        paid_online_note: 'onlayn',
        payment_status: 'paid',
        extra_cost: 5_000,
        extra_cost_party: 'market',
        extra_cost_refunded: false,
        amount: 30_000,
        post_total_price: 150_000,
        leftover: 0,
      },
      description: 'Sotildi',
      changed_by: '26',
      changed_by_role: 'courier',
      actor: {
        id: '26',
        name: 'TEST Claude Kuryer',
        username: null,
        phone_number: '+998900000026',
        role: 'courier',
        status: 'active',
      },
      metadata: { extra_cost: 5_000, courier_share: 15_000 },
      note: null,
      created_at: ISO,
      created_at_ms: 1,
    },
    {
      id: 'c1',
      event_type: 'custody',
      order_id: '67',
      action: 'custody_changed',
      old_value: { holder_type: 'BRANCH', holder_branch: 'Andijon filiali' },
      new_value: {
        holder_type: 'COURIER',
        holder_courier: 'TEST Claude Kuryer',
      },
      metadata: {
        from_label: 'Andijon filiali',
        to_label: 'TEST Claude Kuryer',
      },
      created_at: ISO,
      created_at_ms: 0,
    },
  ],
  meta: { page: 1, limit: 20, total: 2 },
};

/**
 * Testning O'Z (mustaqil) pul ta'rifi: kalit nomida shu bo'laklardan biri
 * bo'lsa — pul. Implementatsiya naqshidan alohida yozilgan.
 */
const MONEY_LIKE =
  /price|amount|tariff|paid|payment|cost|share|salary|commission|compensation|revenue|balance|cashbox|profit|earning|income|debt|cashback|fee(?!d)|payout|payable|receivable|leftover|money|wage|bonus|penalty/i;

/** Order-service / identity / catalog yuboradigan MA'LUM pul kalitlari. */
const KNOWN_MONEY_KEYS = [
  'total_price',
  'market_tariff',
  'courier_tariff',
  'courier_share',
  'branch_share',
  'branch_cashbox_amount',
  'sale_collectible_amount',
  'sale_market_paid_amount',
  'sale_market_paid_max',
  'extra_cost',
  'paid_online_amount',
  'payment_status',
  'to_be_paid',
  'paid_amount',
  'price',
  'tariff_home',
  'tariff_center',
  'default_tariff',
  'salary',
  'payment_day',
  'compensation_mode',
  'commission_type',
  'commission_value',
  'ai_price_per_order',
  'extra_cost_enabled',
  'extra_cost_requires_approval',
  'can_add_extra_cost',
];

/** Javob daraxtidagi barcha kalitlar yo'li bilan (`data[0].market.name`). */
function keyPaths(value: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => keyPaths(item, `${path}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      out.push(next);
      keyPaths(nested, next, out);
    }
  }
  return out;
}

const lastKey = (path: string) =>
  path
    .split('.')
    .pop()!
    .replace(/\[\d+\]$/, '');

function expectNoMoneyLikeKeys(payload: unknown) {
  const paths = keyPaths(payload);
  expect(paths.filter((path) => MONEY_LIKE.test(lastKey(path)))).toEqual([]);
  const keys = new Set(paths.map(lastKey));
  expect(KNOWN_MONEY_KEYS.filter((key) => keys.has(key))).toEqual([]);
}

const LOGIST = {
  user: { sub: '94', username: 'logist', roles: ['logist'] },
} as never;

function gateway(list: Row, row: Row) {
  const reply = (cmd: string, payload: unknown) => {
    switch (cmd) {
      case 'order.find_all_enriched':
        return list;
      case 'order.find_by_id_enriched':
        return row;
      case 'order.tracking':
        return TRACKING;
      case 'logistics.region.find_by_logist':
        return {
          statusCode: 200,
          data: {
            logist_id: '94',
            region_ids: ['3'],
            regions: [{ id: '3', name: 'Andijon' }],
          },
        };
      case 'branch.find_hq':
        return { statusCode: 200, data: { id: '1' } };
      default:
        return { statusCode: 200, data: null, payload };
    }
  };
  const client = () => ({
    send: jest.fn((pattern: { cmd: string }, payload: unknown) =>
      of(reply(pattern.cmd, payload)),
    ),
  });
  return new OrderGatewayController(
    client() as never,
    client() as never,
    client() as never,
    client() as never,
  );
}

const findAll = (controller: OrderGatewayController) =>
  controller.findAll(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    '1',
    '10',
    LOGIST,
  );

describe('4BftLLnc — logist: to`liq buyurtma javobida pulga o`xshash kalit YO`Q', () => {
  let list: { data: Row[] } & Row;

  beforeAll(async () => {
    list = await enrichedList();
  });

  it('shart: proyeksiyadan OLDIN pul kalitlari haqiqatan bor (spec bo`sh emas)', () => {
    const [waiting, cancelled] = list.data;
    // Prod #67: 50 000 − markaz tarifi 20 000 = 30 000.
    expect(waiting.sale_market_paid_max).toBe(30_000);
    expect(waiting.total_price).toBe(50_000);
    expect(waiting.market).toMatchObject({
      tariff_center: 20_000,
      default_tariff: expect.anything(),
      ai_price_per_order: expect.anything(),
      extra_cost_enabled: false,
    });
    expect((waiting.items as Row[])[0].product).toMatchObject({
      price: 99_000,
    });
    expect(cancelled.cancel_return).toMatchObject({ stage: 'courier' });
    const keys = new Set(keyPaths(list).map(lastKey));
    expect(KNOWN_MONEY_KEYS.filter((key) => !keys.has(key))).toEqual([]);
  });

  it('kalitlar ro`yxati va naqsh: sale_market_paid_max yashirin', () => {
    expect(LOGIST_HIDDEN_ORDER_FIELDS).toContain('sale_market_paid_max');
    for (const key of KNOWN_MONEY_KEYS) {
      expect(
        LOGIST_HIDDEN_ORDER_FIELDS.includes(key) ||
          LOGIST_MONEY_KEY_PATTERN.test(key),
      ).toBe(true);
    }
    // Logist ko'radigan operatsion kalitlar naqshga tushmaydi.
    for (const key of [
      'status',
      'order_number',
      'region_id',
      'orders_total',
      'totalOrders',
      'deliveredOrders',
      'activeCouriers',
      'phone_number',
      'name',
      'quantity',
      'product_quantity',
      'where_deliver',
      'holder_type',
      'return_stage',
      'cancel_return',
      'feedback',
      'createdAt',
    ]) {
      expect(LOGIST_MONEY_KEY_PATTERN.test(key)).toBe(false);
    }
  });

  it('⭐ GET /orders (logist): ro`yxatda pul yo`q, operatsion maydonlar qoladi', async () => {
    const res = (await findAll(gateway(list, list.data[0]))) as {
      data: Row[];
    };
    expect(res.data.map((row) => row.id)).toEqual(['67', '68']);
    expectNoMoneyLikeKeys(res);
    expect(res.data[0]).toMatchObject({
      id: '67',
      status: 'waiting',
      region_id: '3',
      order_number: expect.any(String),
      market: { id: '37', name: 'TEST Claude Market' },
      customer: { name: 'TEST Claude Mijoz', region: { name: 'Andijon' } },
      district: { name: 'Asaka' },
      courier: { id: '26', name: 'TEST Claude Kuryer' },
      items: [
        {
          product_name: 'TEST mahsulot',
          quantity: 2,
          product: { name: 'TEST mahsulot' },
        },
      ],
    });
    expect(res.data[1]).toMatchObject({
      status: 'cancelled',
      return_stage: 'courier',
      cancel_return: { stage: 'courier' },
    });
  });

  it('⭐ GET /orders/67 (logist): tafsilotda pul yo`q', async () => {
    const res = (await gateway(list, list.data[0]).findById(
      '67',
      LOGIST,
    )) as Row;
    expect(res).toMatchObject({ id: '67', status: 'waiting' });
    expectNoMoneyLikeKeys(res);
  });

  it('GET /orders/67/tracking (logist): hodisalarda pul yo`q, holat/aktyor qoladi', async () => {
    const res = (await gateway(list, list.data[0]).getTracking(
      '67',
      '1',
      '20',
      LOGIST,
    )) as { data: Row[] };
    expectNoMoneyLikeKeys(res);
    expect(res.data[0]).toMatchObject({
      action: 'sold',
      to_status: 'paid',
      new_value: { status: 'paid' },
      actor: { name: 'TEST Claude Kuryer' },
    });
    expect(res.data[1]).toMatchObject({
      new_value: {
        holder_type: 'COURIER',
        holder_courier: 'TEST Claude Kuryer',
      },
    });
  });
});

describe('4BftLLnc — sale_market_paid_max boshqa rollarda (mavjud qoidalar bo`yicha)', () => {
  let list: { data: Row[] } & Row;

  beforeAll(async () => {
    list = await enrichedList();
  });

  it('kuryer: QOLADI (SellModal «Marketga to`langan summa» chegarasi — readMarketPaidBase), market tarifi yo`q', () => {
    expect(COURIER_HIDDEN_ORDER_FIELDS).not.toContain('sale_market_paid_max');
    const out = projectOrderPayloadForRoles(['courier'], list) as {
      data: Row[];
    };
    expect(out.data[0].sale_market_paid_max).toBe(30_000);
    expect(out.data[0]).not.toHaveProperty('market_tariff');
    expect(out.data[0].market).not.toHaveProperty('tariff_center');
    expect(out.data[0].market).not.toHaveProperty('tariff_home');
  });

  it('market: QOLADI (o`z puli)', () => {
    const out = projectOrderPayloadForRoles(['market'], list) as {
      data: Row[];
    };
    expect(out.data[0].sale_market_paid_max).toBe(30_000);
  });

  it.each([['customer'], ['operator'], ['investor'], ['']])(
    'cheklangan rol (%p): YO`Q — market tarifini ochadi (to_be_paid kabi)',
    (role) => {
      expect(RESTRICTED_HIDDEN_ORDER_FIELDS).toContain('sale_market_paid_max');
      const out = projectOrderPayloadForRoles(role ? [role] : [], list) as {
        data: Row[];
      };
      expect(out.data[0]).not.toHaveProperty('sale_market_paid_max');
      expect(out.data[0]).not.toHaveProperty('to_be_paid');
    },
  );

  it('menejer/superadmin: to`liq ko`rinish (o`zgarmagan)', () => {
    // T7 (QPq2C1co, B3): menejerda faqat market telefoni yo'q, pul — to'liq.
    expect(
      JSON.stringify(projectOrderPayloadForRoles(['manager'], list)),
    ).toContain('sale_market_paid_max');
    expect(projectOrderPayloadForRoles(['superadmin'], list)).toBe(list);
  });
});
