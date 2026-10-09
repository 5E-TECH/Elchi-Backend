import { firstValueFrom, of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import {
  projectOrderPayloadForRoles,
  resolveOrderProjection,
} from './auth/order-role-projection';

/**
 * kH2zZsz3 — buyurtma javobining ROL BO'YICHA moliyaviy proyeksiyasi.
 *
 * 2026-10-09 prod UI testi: TEST Claude Kuryer uchun GET /orders/25 javobida
 * `market_tariff:20000`, `branch_share`, `order.market.tariff_center` ham
 * kelardi. Karta talabi: superadmin/menejer — hammasi; market — faqat market
 * tarifi; kuryer — faqat kuryer tarifi. Proyeksiyasiz kod bu spec'da qizil.
 */
type Handlers = Record<string, unknown>;

function makeClient(handlers: Handlers = {}) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers[pattern.cmd];
      if (handler instanceof Error) {
        return throwError(() => handler);
      }
      const value =
        typeof handler === 'function'
          ? (handler as (p: unknown) => unknown)(payload)
          : handler;
      return of(value ?? { statusCode: 200, data: null });
    }),
  };
}

const user = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as any;

/** Prod'dagi order 25 market profili (identity.market.find_by_ids). */
const marketProfile = () => ({
  id: '16',
  name: 'TEST E2E Market',
  phone_number: '+998887000701',
  role: 'market',
  salary: 0,
  payment_day: null,
  tariff_home: 30000,
  tariff_center: 20000,
  compensation_mode: 'per_order',
  commission_type: null,
  commission_value: null,
  default_tariff: 'center',
  add_order: false,
  can_sell_cancel: false,
  cancelled_handover_qr_required: true,
  expense_proof_conditions: ['sell_extra_cost'],
});

/** Prod'dagi order 25 (find_by_id_enriched) — O'RAMSIZ qator. */
const order25 = (overrides: Record<string, unknown> = {}) => ({
  id: '25',
  market_id: '16',
  customer_id: '29',
  courier_id: '26',
  holder_type: 'COURIER',
  holder_courier_id: '26',
  holder_branch_id: '3',
  branch_id: '3',
  home_branch_id: '3',
  post_id: '8',
  status: 'sold',
  total_price: 100000,
  market_tariff: 20000,
  courier_tariff: 15000,
  courier_share: 15000,
  branch_share: 0,
  branch_cashbox_amount: 0,
  sale_collectible_amount: 100000,
  paid_online_amount: 0,
  extra_cost: 0,
  to_be_paid: 80000,
  paid_amount: 0,
  order_number: 'EL-100025',
  market: marketProfile(),
  customer: { id: '29', name: 'TEST Claude Mijoz 3', salary: 0 },
  branch: { id: '3', name: 'QA Filial 3854902' },
  items: [{ id: '25', order_id: '25', product_id: '4', quantity: 1 }],
  ...overrides,
});

const MARKET_SECRET_KEYS = [
  'courier_tariff',
  'courier_share',
  'branch_share',
  'branch_cashbox_amount',
];
const COURIER_SECRET_KEYS = [
  'market_tariff',
  'branch_share',
  'branch_cashbox_amount',
];
const COURIER_SECRET_MARKET_KEYS = [
  'tariff_home',
  'tariff_center',
  'salary',
  'payment_day',
  'compensation_mode',
  'commission_type',
  'commission_value',
];

function expectCourierView(row: Record<string, any>) {
  for (const key of COURIER_SECRET_KEYS) {
    expect(row).not.toHaveProperty(key);
  }
  for (const key of COURIER_SECRET_MARKET_KEYS) {
    expect(row.market).not.toHaveProperty(key);
  }
  // Kuryerga kerakli maydonlar qoladi.
  expect(row).toMatchObject({
    id: '25',
    total_price: 100000,
    courier_tariff: 15000,
    courier_share: 15000,
    sale_collectible_amount: 100000,
    paid_online_amount: 0,
    // Frontend detali hozircha barcha rolga ko'rsatadi — saqlanadi.
    to_be_paid: 80000,
    paid_amount: 0,
  });
  expect(row.market).toMatchObject({
    name: 'TEST E2E Market',
    phone_number: '+998887000701',
    expense_proof_conditions: ['sell_extra_cost'],
    cancelled_handover_qr_required: true,
    add_order: false,
  });
}

function expectMarketView(row: Record<string, any>) {
  for (const key of MARKET_SECRET_KEYS) {
    expect(row).not.toHaveProperty(key);
  }
  expect(row).toMatchObject({
    total_price: 100000,
    market_tariff: 20000,
    to_be_paid: 80000,
    paid_amount: 0,
  });
  // O'z profili — tariflari bilan.
  expect(row.market).toMatchObject({
    tariff_center: 20000,
    tariff_home: 30000,
  });
}

/**
 * Fail-closed ko'rinish (kH2zZsz3 tekshiruvi #3): ro'yxatda yo'q rol —
 * barcha ichki tariflar/ulushlar, market moliyasi va market profili
 * tariflari yo'q; mijozga kerakli summa (`total_price`) qoladi.
 */
function expectRestrictedView(row: Record<string, any>) {
  for (const key of [
    ...new Set([...MARKET_SECRET_KEYS, ...COURIER_SECRET_KEYS]),
    'to_be_paid',
    'paid_amount',
  ]) {
    expect(row).not.toHaveProperty(key);
  }
  for (const key of COURIER_SECRET_MARKET_KEYS) {
    expect(row.market).not.toHaveProperty(key);
  }
  expect(row).toMatchObject({
    id: '25',
    total_price: 100000,
    sale_collectible_amount: 100000,
    paid_online_amount: 0,
    extra_cost: 0,
  });
  expect(row.market).toMatchObject({ name: 'TEST E2E Market' });
}

function orderGateway(
  orderHandlers: Handlers,
  logisticsHandlers = {},
  identityHandlers: Handlers = {},
) {
  const order = makeClient(orderHandlers);
  const identity = makeClient({
    'identity.user.find_by_id': { statusCode: 200, data: { market_id: '16' } },
    ...identityHandlers,
  });
  const logistics = makeClient(logisticsHandlers);
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: '1' } },
  });
  return new OrderGatewayController(
    order as any,
    identity as any,
    logistics as any,
    branch as any,
  );
}

describe('kH2zZsz3 — projectOrderPayloadForRoles', () => {
  it("superadmin/admin/menejer/filial/registrator — to'liq ko'rinish (asl havola)", () => {
    const payload = { statusCode: 200, data: order25() };
    for (const roles of [
      ['superadmin'],
      ['admin'],
      ['manager'],
      ['branch'],
      ['registrator'],
      ['courier', 'manager'],
    ]) {
      expect(resolveOrderProjection(roles)).toBeNull();
      expect(projectOrderPayloadForRoles(roles, payload)).toBe(payload);
    }
  });

  it("kuryer — market tarifi, filial ulushi va market profili tariflari yo'q", () => {
    const row = order25();
    const projected = projectOrderPayloadForRoles(['courier'], row);

    expectCourierView(projected);
    // Asl obyekt o'zgarmaydi (copy-on-write).
    expect(row.market_tariff).toBe(20000);
    expect(row.market.tariff_center).toBe(20000);
  });

  it("market va market operatori — kuryer tarifi/ulushi va filial ulushi yo'q", () => {
    expectMarketView(projectOrderPayloadForRoles(['market'], order25()));
    expectMarketView(
      projectOrderPayloadForRoles(['market_operator'], order25()),
    );
  });

  it("rol nomi registrdan qat'i nazar; camelCase maydonlar ham yashiriladi", () => {
    const projected = projectOrderPayloadForRoles([' COURIER '], {
      id: '25',
      marketId: '16',
      totalPrice: 1,
      marketTariff: 20000,
      branchShare: 0,
      courierTariff: 15000,
    });
    expect(projected).toEqual({
      id: '25',
      marketId: '16',
      totalPrice: 1,
      courierTariff: 15000,
    });
  });

  it("konvert va ichma-ich ro'yxatlar (data.data[], allOrdersByPostId) ham qamraladi", () => {
    const projected = projectOrderPayloadForRoles(['courier'], {
      statusCode: 200,
      data: {
        data: [order25()],
        allOrdersByPostId: [order25({ id: '28' })],
        total: 2,
      },
    });
    expectCourierView(projected.data.data[0]);
    expect(projected.data.allOrdersByPostId[0]).not.toHaveProperty(
      'market_tariff',
    );
    expect(projected.data.total).toBe(2);
  });

  it("ro'yxatda yo'q rollar (mijoz, operator, investor, logist, noma'lum, bo'sh) — FAIL-CLOSED", () => {
    for (const roles of [
      ['customer'],
      ['operator'],
      ['investor'],
      ['logist'],
      ['some_future_role'],
      [],
      undefined,
    ]) {
      expect(resolveOrderProjection(roles)).not.toBeNull();
      expectRestrictedView(projectOrderPayloadForRoles(roles, order25()));
    }
    // Cheklangan rollar birlashadi: market + mijoz — market tarifi ham yo'q.
    expectRestrictedView(
      projectOrderPayloadForRoles(['market', 'customer'], order25()),
    );
  });

  it("yashiriladigan maydon yo'q bo'lsa — asl havola qaytadi", () => {
    const payload = { data: [{ id: '1', market_id: '16', total_price: 5 }] };
    expect(projectOrderPayloadForRoles(['courier'], payload)).toBe(payload);
    expect(projectOrderPayloadForRoles(['market'], payload)).toBe(payload);
  });
});

describe('kH2zZsz3 — GET /orders/:id rol proyeksiyasi', () => {
  it("kuryer (o'z buyurtmasi) — market_tariff/branch_share yo'q", async () => {
    const controller = orderGateway({
      'order.find_by_id_enriched': order25(),
    });

    const res = await controller.findById('25', user('26', ['courier']));

    expectCourierView(res);
  });

  it("market (o'z buyurtmasi) — kuryer tarifi/ulushi yo'q", async () => {
    const controller = orderGateway({
      'order.find_by_id_enriched': order25(),
    });

    expectMarketView(await controller.findById('25', user('16', ['market'])));
  });

  it("market operatori — kuryer tarifi/ulushi yo'q", async () => {
    const controller = orderGateway({
      'order.find_by_id_enriched': order25(),
    });

    expectMarketView(
      await controller.findById('25', user('77', ['market_operator'])),
    );
  });

  it("mijoz (o'z buyurtmasi) — tariflar, ulushlar va market moliyasi yo'q", async () => {
    const controller = orderGateway({
      'order.find_by_id_enriched': order25(),
    });

    expectRestrictedView(
      await controller.findById('25', user('29', ['customer'])),
    );
  });

  it("superadmin — 70 000 / 25 000 kabi barcha maydonlar o'zgarishsiz", async () => {
    const row = order25();
    const controller = orderGateway({ 'order.find_by_id_enriched': row });

    await expect(
      controller.findById('25', user('1', ['superadmin'])),
    ).resolves.toBe(row);
  });

  it("menejer (o'z filiali) — to'liq ko'rinish", async () => {
    const row = order25();
    const controller = orderGateway({ 'order.find_by_id_enriched': row });

    await expect(
      controller.findById('25', user('5', ['manager'], '3')),
    ).resolves.toBe(row);
  });
});

describe("kH2zZsz3 — QR, ro'yxat va skan yo'llari", () => {
  it('GET /orders/qr-code/:token — kuryer', async () => {
    const controller = orderGateway({
      'order.find_by_qr_enriched': { statusCode: 200, data: order25() },
    });

    const res: any = await controller.findByQrCode(
      'dd3e45dc80ad9904eeb767ff',
      user('26', ['courier']),
    );

    expectCourierView(res.data);
  });

  it('GET /orders — kuryer va market ro`yxati', async () => {
    const list = () => ({ data: [order25()], total: 1, page: 1, limit: 10 });
    const asCourier: any = await orderGateway({
      'order.find_all_enriched': list(),
    }).findAll(
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
      undefined,
      undefined,
      user('26', ['courier']),
    );
    expectCourierView(asCourier.data[0]);

    const asMarket: any = await orderGateway({
      'order.find_all_enriched': list(),
    }).findAll(
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
      undefined,
      undefined,
      user('16', ['market']),
    );
    expectMarketView(asMarket.data[0]);
  });

  it('GET /orders/courier/orders (legacy) — kuryer', async () => {
    const controller = orderGateway(
      {
        'order.find_all_enriched': {
          data: [order25()],
          total: 1,
          page: 1,
          limit: 10,
        },
      },
      {
        'logistics.post.my_for_courier': {
          statusCode: 200,
          data: { data: [{ id: '8' }], totalPages: 1 },
        },
      },
    );

    const res: any = await controller.findCourierOrdersLegacy(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      user('26', ['courier']),
    );

    expect(res.data.data).toHaveLength(1);
    expectCourierView(res.data.data[0]);
  });

  it('GET /orders/market/:marketId — market', async () => {
    const res: any = await orderGateway({
      'order.find_all_enriched': {
        data: [order25()],
        total: 1,
        page: 1,
        limit: 10,
      },
    }).findAllByMarket(
      '16',
      undefined,
      undefined,
      undefined,
      undefined,
      user('16', ['market']),
    );

    expectMarketView(res.data[0]);
  });

  it('GET /scan/:token (buyurtma) — kuryer', async () => {
    const orderClient = makeClient({
      'order.find_by_qr': { statusCode: 200, data: order25() },
    });
    const controller = new ScanGatewayController(
      orderClient as any,
      makeClient() as any,
      makeClient() as any,
    );

    const res: any = await controller.scan(
      'ORD-dd3e45dc',
      user('26', ['courier']),
    );

    expect(res.type).toBe('order');
    expectCourierView(res.data);
  });

  it('GET /post/orders/:id — kuryer pochtasi buyurtmalari', async () => {
    // logistics `findOrders` qatorida `market` yo'q — gateway uni identity'dan
    // boyitadi (enrichOrderRows), proyeksiya esa boyitilgandan KEYIN.
    const rowWithoutMarket: Record<string, unknown> = order25();
    delete rowWithoutMarket.market;
    const logistics = makeClient({
      'logistics.post.orders_by_post': {
        statusCode: 200,
        data: {
          allOrdersByPostId: [rowWithoutMarket],
          homeOrders: { homeOrders: 0, homeOrdersTotalPrice: 0 },
          centerOrders: { centerOrders: 1, centerOrdersTotalPrice: 100000 },
        },
      },
      'logistics.district.find_by_id': { statusCode: 200, data: null },
    });
    const identity = makeClient({
      'identity.market.find_by_id': { statusCode: 200, data: marketProfile() },
      'identity.customer.find_by_id': { statusCode: 200, data: { id: '29' } },
    });
    const controller = new LogisticsGatewayController(
      logistics as any,
      identity as any,
    );

    const res: any = await controller.getOrdersByPost(
      '8',
      user('26', ['courier']),
    );

    expectCourierView(res.data.allOrdersByPostId[0]);
    expect(res.data.centerOrders.centerOrdersTotalPrice).toBe(100000);
  });
});

describe("kH2zZsz3 (tekshiruv) — kassa tarixi, pochta qabuli va yaratish yo'llari", () => {
  /** finance `findHistoryById`: SELL yozuvi + `data.order` (TO'LIQ qator). */
  const sellHistory = (cashbox: Record<string, unknown>) => ({
    statusCode: 200,
    data: {
      id: '501',
      source_type: 'sell',
      source_id: '25',
      operation_type: 'income',
      amount: 85000,
      cashbox,
      order: order25(),
    },
  });

  function financeGateway(response: unknown) {
    return new FinanceGatewayController(
      makeClient({ 'finance.history.find_by_id': response }) as any,
      makeClient() as any,
      makeClient() as any,
      makeClient() as any,
    );
  }

  it("GET /finance/history/:id — kuryer o'z kassasi yozuvida market tarifini ko'rmaydi", async () => {
    const res: any = await financeGateway(
      sellHistory({ id: '9', user_id: '26', cashbox_type: 'couriers' }),
    ).findHistoryById('501', user('26', ['courier']));

    expectCourierView(res.data.order);
    // Kassa yozuvining o'zi o'zgarmaydi.
    expect(res.data).toMatchObject({ id: '501', amount: 85000 });
    expect(res.data.cashbox).toMatchObject({ user_id: '26' });
  });

  it("GET /finance/history/:id — market o'z kassasi yozuvida kuryer tarifi/ulushini ko'rmaydi", async () => {
    const res: any = await financeGateway(
      sellHistory({ id: '7', user_id: '16', cashbox_type: 'markets' }),
    ).findHistoryById('501', user('16', ['market']));

    expectMarketView(res.data.order);
  });

  it("GET /finance/history/:id — superadmin to'liq (asl havola)", async () => {
    const response = sellHistory({
      id: '1',
      user_id: '0',
      cashbox_type: 'main',
    });

    await expect(
      financeGateway(response).findHistoryById(
        '501',
        user('1', ['superadmin']),
      ),
    ).resolves.toBe(response);
  });

  it('PATCH /post/receive/:id — kuryer qabul qilgan buyurtma qatorlari', async () => {
    const logistics = makeClient({
      'logistics.post.receive': {
        statusCode: 200,
        message: 'Post received successfully',
        data: [order25({ status: 'waiting' })],
        failures: [],
        not_received_order_ids: [],
      },
    });
    const controller = new LogisticsGatewayController(
      logistics as any,
      makeClient() as any,
    );

    const res: any = await firstValueFrom(
      controller.receivePost(
        '8',
        { order_ids: ['25'] } as any,
        user('26', ['courier']),
      ),
    );

    expectCourierView(res.data[0]);
    expect(res.not_received_order_ids).toEqual([]);
  });

  it('POST /orders — market yaratgan buyurtma javobida kuryer tarifi/ulushi kalitlari yo`q', async () => {
    const controller = orderGateway(
      { 'order.create': { statusCode: 201, data: order25() } },
      {},
      {
        'identity.market.find_by_id': {
          statusCode: 200,
          data: { id: '16', status: 'active', add_order: true },
        },
        'identity.customer.create': { statusCode: 201, data: { id: '29' } },
      },
    );

    const res: any = await controller.create(
      {
        customer: {
          name: 'TEST Claude Mijoz 3',
          phone_number: '+998900000029',
          district_id: '1',
        },
        total_price: 100000,
        items: [],
      } as any,
      user('16', ['market']),
    );

    expectMarketView(res.data);
  });

  it('POST /orders/external — market', async () => {
    const controller = orderGateway(
      { 'order.external.create': { statusCode: 201, data: order25() } },
      {},
      {
        'identity.market.find_by_id': {
          statusCode: 200,
          data: { id: '16', status: 'active', add_order: true },
        },
        'identity.customer.create': { statusCode: 201, data: { id: '29' } },
      },
    );

    const res: any = await controller.createExternal(
      {
        customer: {
          name: 'TEST Claude Mijoz 3',
          phone_number: '+998900000029',
          district_id: '1',
        },
        external_id: 'EXT-25',
        total_price: 100000,
      } as any,
      user('16', ['market']),
    );

    expectMarketView(res.data);
  });
});
