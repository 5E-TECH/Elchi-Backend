import 'reflect-metadata';
import { of } from 'rxjs';
import { getMetadataArgsStorage } from 'typeorm';
import {
  CUSTOMER_VIEW_FIELDS,
  projectOrderPayloadForRoles,
} from './auth/order-role-projection';
import { FinanceGatewayController } from './finance-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { Order } from '../../order-service/src/entities/order.entity';
import { OrderItem } from '../../order-service/src/entities/order-item.entity';
import { OrderServiceService } from '../../order-service/src/order-service.service';
import { User } from '../../identity-service/src/entities/user.entity';
import { Region } from '../../logistics-service/src/entities/region.entity';
import { District } from '../../logistics-service/src/entities/district.entity';

/**
 * vf4513Zn (prod tester, 2026-10-26 00:00, BE 7bff045): kuryer 26
 * `GET /finance/history/114` ning buyurtmaga bog'liq qatorlarida (sell,
 * extra_cost, correction — 33 tasining hammasida) `data.order.customer` —
 * identity'ning TO'LIQ foydalanuvchi yozuvi (`salary`, `payment_day`,
 * `tariff_home/center`, `compensation_mode`, `default_tariff`,
 * `commission_*`, `ai_price_per_order`, `username`, `telegram_username`,
 * `settings`...). Xuddi shu yozuv kuryerning `GET /orders/67` ida ham bor —
 * manba buyurtma proyeksiyasi.
 *
 * Bu spec HAQIQIY order-service `enrichOrders` (identity User entity'ning
 * BARCHA ustunlari bilan mijoz/market) javobini gateway'dan o'tkazadi va xom
 * JSON'ni aylanib chiqadi: kuryer / market / market operatori / logist /
 * fail-closed rollarda HECH QAYSI `customer` obyektida xodim/pul profili
 * kaliti yo'q — faqat `CUSTOMER_VIEW_FIELDS`. Kassa tarixidagi buyurtma
 * `GET /orders/:id` bilan AYNI proyeksiyadan o'tadi; `order.market` qoidalari
 * (kuryerga market tarifi yo'q, market/menejer — mavjud qoida) o'zgarmagan.
 */

type ColumnArgs = ReturnType<typeof getMetadataArgsStorage>['columns'][number];
type Row = Record<string, any>;

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
    return 0;
  }
  if (/^(timestamptz|timestamp|date)$/.test(type)) return ISO;
  if (/^jsonb?$/.test(type)) return {};
  return `${name}-qiymat`;
}

function fullRecord(target: object, overrides: Row = {}): Row {
  const row: Row = {};
  for (const column of columnsOf(target)) {
    row[column.propertyName] = sampleOf(column);
  }
  return { ...row, ...overrides };
}

/** identity `sanitize` — maxfiy kalitlar yuborilmaydi, qolgani TO'LIQ. */
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
  return { ...user, telegram_linked: false };
};

const MARKET = sanitizedUser({
  id: '37',
  name: 'TEST Claude Market',
  phone_number: '+998900000037',
  role: 'market',
  tariff_center: 20_000,
  tariff_home: 20_000,
  salary: 0,
  commission_type: 'percent',
  commission_value: 5,
});
/** Prod #114 dagi kabi: mijozda xodim maydonlari null/0, lekin KALIT bor. */
const CUSTOMER = sanitizedUser({
  id: '49',
  name: 'TEST Claude Mijoz',
  phone_number: '+998900000049',
  extra_number: '+998900000050',
  address: 'Asaka, 1-uy',
  role: 'customer',
  status: 'active',
  district_id: '173',
  region_id: '3',
  salary: 0,
  payment_day: null,
  tariff_home: null,
  tariff_center: null,
  commission_type: null,
  commission_value: null,
  ai_price_per_order: null,
  username: null,
  telegram_username: null,
});
const COURIER = sanitizedUser({
  id: '26',
  name: 'TEST Claude Kuryer',
  phone_number: '+998900000026',
  role: 'courier',
});

const ORDER_ROW: Row = {
  ...fullRecord(Order, {
    market_id: '37',
    customer_id: '49',
    courier_id: '26',
    region_id: '3',
    district_id: '173',
    post_id: '5',
    branch_id: '3',
    status: 'sold',
    where_deliver: 'center',
    total_price: 50_000,
    paid_online_amount: 0,
    paid_amount: 30_000,
    to_be_paid: 30_000,
    market_tariff: 20_000,
    courier_tariff: 15_000,
    warehouse_id: null,
    fulfillment_source: 'HQ',
    replacement_of_order_id: null,
    parent_order_id: null,
    deleted_at: null,
    isDeleted: false,
  }),
  id: '67',
  items: [
    fullRecord(OrderItem, {
      id: '901',
      order_id: '67',
      product_id: null,
      product_name: 'TEST mahsulot',
      quantity: 1,
    }),
  ],
};

/** HAQIQIY order-service `enrichOrders` — `order.find_by_id_enriched` qatori. */
async function enrichedOrder(): Promise<Row> {
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
          data: [fullRecord(Region, { id: '3', name: 'Andijon' })],
        });
      case 'logistics.district.find_by_ids':
        return of({
          data: [
            fullRecord(District, { id: '173', name: 'Asaka', region_id: '3' }),
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
    data: [ORDER_ROW],
    total: 1,
    page: 1,
    limit: 10,
    total_pages: 1,
    totalPages: 1,
  } as never);
  const list = (await service.findAllEnriched({})) as unknown as {
    data: Row[];
  };
  return list.data[0];
}

/**
 * Testning O'Z ta'rifi (implementatsiya ro'yxatidan mustaqil): mijoz
 * obyektida bo'lmasligi kerak bo'lgan xodim / pul / login profili kalitlari.
 */
const STAFF_PROFILE_KEY =
  /salary|payment_day|tariff|commission|compensation|price|amount|username|telegram|settings|password|token|session|super_courier|serves_all|add_order|can_|extra_cost|expense_proof|cancelled_handover|warehouse|operator_phone|tg_group|language|created_by|avatar|market_id|role|is_deleted|isDeleted/i;

/** Javob daraxtidagi barcha `customer` obyektlari (yo'li bilan). */
function customerObjects(
  value: unknown,
  path = '',
  out: Array<[string, Row]> = [],
): Array<[string, Row]> {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      customerObjects(item, `${path}[${index}]`, out),
    );
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (
        key === 'customer' &&
        nested &&
        typeof nested === 'object' &&
        !Array.isArray(nested)
      ) {
        out.push([next, nested as Row]);
      }
      customerObjects(nested, next, out);
    }
  }
  return out;
}

function expectCustomerViewOnly(payload: unknown, minCount = 1) {
  const found = customerObjects(payload);
  expect(found.length).toBeGreaterThanOrEqual(minCount);
  for (const [path, customer] of found) {
    const keys = Object.keys(customer);
    expect({
      path,
      extra: keys.filter((key) => !CUSTOMER_VIEW_FIELDS.includes(key)),
      staff: keys.filter((key) => STAFF_PROFILE_KEY.test(key)),
    }).toEqual({ path, extra: [], staff: [] });
    // FE o'qiydigan maydonlar saqlanadi.
    expect(customer).toMatchObject({
      id: '49',
      name: 'TEST Claude Mijoz',
      phone_number: '+998900000049',
      extra_number: '+998900000050',
      address: 'Asaka, 1-uy',
      district: { name: 'Asaka' },
      region: { name: 'Andijon' },
    });
  }
}

const user = (sub: string, roles: string[]) =>
  ({ user: { sub, roles, username: `u${sub}` } }) as never;

function orderGateway(row: Row) {
  const reply = (cmd: string) => {
    switch (cmd) {
      case 'order.find_by_id_enriched':
        return { statusCode: 200, data: row };
      case 'logistics.region.find_by_logist':
        return {
          statusCode: 200,
          data: { logist_id: '94', region_ids: ['3'], regions: [] },
        };
      case 'branch.find_hq':
        return { statusCode: 200, data: { id: '1' } };
      case 'identity.user.find_by_id':
        // Market operatori 53 — market 37 ga biriktirilgan.
        return { statusCode: 200, data: { id: '53', market_id: '37' } };
      default:
        return { statusCode: 200, data: null };
    }
  };
  const client = () => ({
    send: jest.fn((pattern: { cmd: string }) => of(reply(pattern.cmd))),
  });
  return new OrderGatewayController(
    client() as never,
    client() as never,
    client() as never,
    client() as never,
  );
}

/** finance-service `findHistoryById` shakli: tarix qatori + `order`. */
function historyDetail(
  row: Row,
  cashbox: { user_id: string; cashbox_type: string },
) {
  return {
    statusCode: 200,
    data: {
      id: '114',
      cashbox_id: '21',
      operation_type: 'income',
      source_type: 'sell',
      source_id: '67',
      amount: 50_000,
      cashbox: { id: '21', ...cashbox, user: null },
      source_user: null,
      created_by_user: null,
      order: row,
    },
  };
}

function financeGateway(response: unknown) {
  const finance = { send: jest.fn(() => of(response)) };
  const identity = {
    send: jest.fn((_pattern: unknown, payload: { id?: string }) =>
      of({
        statusCode: 200,
        data:
          [MARKET, CUSTOMER, COURIER].find(
            (u) => String(u.id) === String(payload?.id),
          ) ?? null,
      }),
    ),
  };
  return new FinanceGatewayController(
    finance as never,
    identity as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
  );
}

describe('vf4513Zn — buyurtmadagi `customer` faqat mijoz ko`rinishi (cheklangan rollar)', () => {
  let row: Row;

  beforeAll(async () => {
    row = await enrichedOrder();
  });

  it('shart: proyeksiyadan OLDIN mijoz — to`liq identity yozuvi (spec bo`sh emas)', () => {
    expect(row.customer).toMatchObject({
      id: '49',
      salary: 0,
      payment_day: null,
      tariff_home: null,
      compensation_mode: expect.anything(),
      ai_price_per_order: null,
      username: null,
      telegram_username: null,
      settings: expect.anything(),
      district: { name: 'Asaka' },
      region: { name: 'Andijon' },
    });
  });

  it('⭐ kuryer 26 GET /orders/67: customer minimal; market tarifi yo`q (mavjud qoida)', async () => {
    const res = (await orderGateway(row).findById(
      '67',
      user('26', ['courier']),
    )) as Row;
    expectCustomerViewOnly(res);
    expect(res.data.market).not.toHaveProperty('tariff_home');
    expect(res.data.market).not.toHaveProperty('tariff_center');
    expect(res.data).not.toHaveProperty('market_tariff');
    expect(res.data.courier_tariff).toBe(15_000);
  });

  it('⭐ kuryer 26 GET /finance/history/114: data.order.customer minimal va data.order === GET /orders/67 proyeksiyasi', async () => {
    const res = (await financeGateway(
      historyDetail(row, { user_id: '26', cashbox_type: 'couriers' }),
    ).findHistoryById('114', user('26', ['courier']))) as Row;
    expectCustomerViewOnly(res);

    const orderRes = (await orderGateway(row).findById(
      '67',
      user('26', ['courier']),
    )) as Row;
    expect(res.data.order).toEqual(orderRes.data);
  });

  it('⭐ market 37 GET /finance/history/113: customer minimal; o`z market profili — mavjud qoida (o`zgarmagan)', async () => {
    const res = (await financeGateway(
      historyDetail(row, { user_id: '37', cashbox_type: 'markets' }),
    ).findHistoryById('113', user('37', ['market']))) as Row;
    expectCustomerViewOnly(res);
    expect(res.data.order.market).toMatchObject({ tariff_home: 20_000 });
    expect(res.data.order).not.toHaveProperty('courier_tariff');

    const orderRes = (await orderGateway(row).findById(
      '67',
      user('37', ['market']),
    )) as Row;
    expect(res.data.order).toEqual(orderRes.data);
  });

  it.each([
    ['market', '37'],
    ['market_operator', '53'],
    ['logist', '94'],
  ])('GET /orders/67 (%s): customer minimal', async (role, sub) => {
    const res = (await orderGateway(row).findById(
      '67',
      user(sub, [role]),
    )) as Row;
    expectCustomerViewOnly(res);
  });

  it.each([['customer'], ['operator'], ['investor'], ['']])(
    'fail-closed rol (%p): customer minimal',
    (role) => {
      const out = projectOrderPayloadForRoles(role ? [role] : [], {
        data: [row],
      });
      expectCustomerViewOnly(out);
    },
  );

  it('ro`yxat / paket / pochta shakllari (market_id siz buyurtma xulosasi ham): customer minimal', () => {
    const summary: Row = { ...row };
    delete summary.market_id;
    const out = projectOrderPayloadForRoles(['courier'], {
      data: {
        items: [{ order: summary }],
        allOrdersByPostId: [row],
      },
    });
    expectCustomerViewOnly(out, 2);
  });

  it('kuryer / market my-cashbox: hech qaysi `customer` da xodim kaliti yo`q (tarix — foydalanuvchilar minimal)', async () => {
    for (const [sub, role, type] of [
      ['26', 'courier', 'couriers'],
      ['37', 'market', 'markets'],
    ]) {
      const res = (await financeGateway({
        statusCode: 200,
        data: {
          cashbox: { id: '21', user_id: sub, cashbox_type: type },
          cashboxHistory: [
            {
              id: '114',
              source_type: 'sell',
              source_id: '67',
              created_by: '26',
              source_user: null,
            },
          ],
        },
      }).myCashbox(user(sub, [role]), {} as never)) as Row;
      for (const [path, customer] of customerObjects(res)) {
        expect({
          path,
          staff: Object.keys(customer).filter((k) => STAFF_PROFILE_KEY.test(k)),
        }).toEqual({ path, staff: [] });
      }
      expect(
        Object.keys(res.data.cashboxHistory[0].created_by_user).sort(),
      ).toEqual(['id', 'name', 'phone_number', 'role']);
    }
  });

  it('menejer / superadmin: to`liq ko`rinish (o`zgarmagan)', () => {
    const payload = { data: row };
    expect(projectOrderPayloadForRoles(['manager'], payload)).toBe(payload);
    expect(projectOrderPayloadForRoles(['superadmin'], payload)).toBe(payload);
  });

  it('allaqachon minimal customer — ASL havola (copy-on-write)', () => {
    const payload = {
      data: { market_id: '37', customer: { name: 'A', phone_number: '1' } },
    };
    expect(projectOrderPayloadForRoles(['market'], payload)).toBe(payload);
  });
});
