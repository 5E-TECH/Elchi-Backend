import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  LogistRegionScopeService,
  isLogistRequester,
  projectLogistPayload,
  resolveLogistRegionFilter,
} from './auth/logist-scope';
import {
  LOGIST_HIDDEN_ORDER_FIELDS,
  projectOrderPayloadForRoles,
} from './auth/order-role-projection';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 4BftLLnc — logist: buyurtmalar ro'yxati, tafsiloti va kuzatuvi — faqat o'z
 * viloyatlari (regions.logist_id = me), faqat ko'rish, pulsiz (ega LG-S1/S3).
 *
 * Avval: GET /orders → 403, GET /orders/:id → 403, /tracking → 403 (LOGIST
 * @Roles'da yo'q). Endi: o'z viloyati — 200 (pul maydonlarisiz), boshqa
 * viloyat — 403 / 400, viloyatsiz logist — bo'sh ro'yxat.
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

const LOGIST_ID = '42';
const OWN_REGIONS = ['5', '9'];

const regionsReply = (ids: string[]) => ({
  statusCode: 200,
  data: {
    logist_id: LOGIST_ID,
    region_ids: ids,
    regions: ids.map((id) => ({ id, name: `Viloyat-${id}` })),
  },
});

/** Prod order 25 shakli (find_by_id_enriched) — pul maydonlari bilan. */
const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id: '25',
  market_id: '16',
  customer_id: '29',
  courier_id: '26',
  region_id: '5',
  district_id: '501',
  status: 'sold',
  total_price: 100000,
  market_tariff: 20000,
  courier_tariff: 15000,
  courier_share: 15000,
  branch_share: 0,
  branch_cashbox_amount: 0,
  sale_collectible_amount: 100000,
  sale_market_paid_amount: 0,
  paid_online_amount: 0,
  extra_cost: 0,
  to_be_paid: 80000,
  paid_amount: 0,
  order_number: 'EL-100025',
  market: {
    id: '16',
    name: 'TEST E2E Market',
    phone_number: '+998887000701',
    tariff_home: 30000,
    tariff_center: 20000,
    salary: 0,
    commission_value: null,
  },
  customer: { id: '29', name: 'TEST Claude Mijoz 3' },
  items: [{ id: '1', product_id: '4', quantity: 1, price: 100000 }],
  ...overrides,
});

const MONEY_KEYS = [
  'total_price',
  'sale_collectible_amount',
  'sale_market_paid_amount',
  'paid_online_amount',
  'extra_cost',
  'market_tariff',
  'courier_tariff',
  'courier_share',
  'branch_share',
  'branch_cashbox_amount',
  'to_be_paid',
  'paid_amount',
];

/** Javob daraxtining HECH bir joyida pulga xos kalit yo'q. */
function expectNoMoneyKeys(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of [
    ...MONEY_KEYS,
    'tariff_home',
    'tariff_center',
    'salary',
    'commission_value',
    '"price"',
  ]) {
    expect(json).not.toContain(key.startsWith('"') ? key : `"${key}"`);
  }
}

function setup(
  opts: {
    order?: Handlers;
    logistics?: Handlers;
    branch?: Handlers;
    identity?: Handlers;
  } = {},
) {
  const order = makeClient(opts.order);
  const identity = makeClient(opts.identity);
  const logistics = makeClient({
    'logistics.region.find_by_logist': regionsReply(OWN_REGIONS),
    ...opts.logistics,
  });
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: '1' } },
    ...opts.branch,
  });
  const controller = new OrderGatewayController(
    order as any,
    identity as any,
    logistics as any,
    branch as any,
  );
  return { controller, order, logistics, branch, identity };
}

const sentTo = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
  );

const lastPayload = (client: { send: jest.Mock }, cmd: string) => {
  const calls = sentTo(client, cmd);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, any>;
};

const user = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as any;

const LOGIST = user(LOGIST_ID, ['logist']);

const callFindAll = (
  controller: OrderGatewayController,
  q: { region_id?: string; market_id?: string; status?: string },
  req: unknown,
) =>
  controller.findAll(
    q.market_id,
    undefined,
    q.status,
    undefined,
    undefined,
    undefined,
    undefined,
    q.region_id,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    '1',
    '10',
    req as any,
  );

describe('4BftLLnc — logist doirasi yordamchisi', () => {
  it('isLogistRequester: faqat boshqa doirali rolsiz logist', () => {
    expect(isLogistRequester(['logist'])).toBe(true);
    expect(isLogistRequester(['LOGIST'])).toBe(true);
    expect(isLogistRequester(['logist', 'admin'])).toBe(false);
    expect(isLogistRequester(['logist', 'manager'])).toBe(false);
    expect(isLogistRequester(['manager'])).toBe(false);
    expect(isLogistRequester([])).toBe(false);
    expect(isLogistRequester(undefined)).toBe(false);
  });

  it('region filtri: to‘plam ichida — kanonik id, tashqarida/buzuq — 400', () => {
    expect(resolveLogistRegionFilter(undefined, OWN_REGIONS)).toBeNull();
    expect(resolveLogistRegionFilter('', OWN_REGIONS)).toBeNull();
    expect(resolveLogistRegionFilter('05', OWN_REGIONS)).toBe('5');
    expect(() => resolveLogistRegionFilter('7', OWN_REGIONS)).toThrow(
      BadRequestException,
    );
    expect(() => resolveLogistRegionFilter('abc', OWN_REGIONS)).toThrow(
      BadRequestException,
    );
    expect(() => resolveLogistRegionFilter('5', [])).toThrow(
      BadRequestException,
    );
  });

  it('LogistRegionScopeService: kesh (30 s) — bitta RPC', async () => {
    const logistics = makeClient({
      'logistics.region.find_by_logist': regionsReply(['9', '5', '5']),
    });
    const scope = new LogistRegionScopeService(logistics as any);
    expect(await scope.regionIds('42')).toEqual(['9', '5']);
    expect(await scope.regionIds('42')).toEqual(['9', '5']);
    expect(sentTo(logistics, 'logistics.region.find_by_logist')).toHaveLength(
      1,
    );
    expect(lastPayload(logistics, 'logistics.region.find_by_logist')).toEqual({
      logist_id: '42',
    });
  });

  it('LogistRegionScopeService: logistics xato / buzuq javob — 503 (fail-closed), keshlanmaydi', async () => {
    const down = new LogistRegionScopeService(
      makeClient({
        'logistics.region.find_by_logist': new Error('timeout'),
      }) as any,
    );
    await expect(down.regionIds('42')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const broken = new LogistRegionScopeService(
      makeClient({
        'logistics.region.find_by_logist': { statusCode: 200, data: null },
      }) as any,
    );
    await expect(broken.regionIds('42')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('LogistRegionScopeService: id yo‘q/buzuq — bo‘sh, RPC yo‘q', async () => {
    const logistics = makeClient();
    const scope = new LogistRegionScopeService(logistics as any);
    expect(await scope.regionIds(undefined)).toEqual([]);
    expect(await scope.regionIds('abc')).toEqual([]);
    expect(logistics.send).not.toHaveBeenCalled();
  });

  it('projectLogistPayload: logist — pul yo‘q; boshqa rol — ASL havola', () => {
    const payload = { data: [orderRow()] };
    expect(projectLogistPayload(['manager'], payload)).toBe(payload);
    expect(projectLogistPayload(['courier'], payload)).toBe(payload);
    expectNoMoneyKeys(projectLogistPayload(['logist'], payload));
  });
});

describe('4BftLLnc — LOGIST proyeksiyasi (order-role-projection)', () => {
  it('kartadagi maydonlar ro‘yxatda', () => {
    for (const key of [
      'total_price',
      'sale_collectible_amount',
      'paid_online_amount',
      'extra_cost',
      'market_tariff',
    ]) {
      expect(LOGIST_HIDDEN_ORDER_FIELDS).toContain(key);
    }
  });

  it('buyurtma, market profili, mahsulotlar va yig‘indilar — pulsiz; operatsion maydonlar qoladi', () => {
    const projected = projectOrderPayloadForRoles(['logist'], {
      data: [orderRow()],
      homeOrders: { homeOrders: 1, homeOrdersTotalPrice: 100000 },
      amount_total: 100000,
      summary: { totalRevenue: 5, deliveredOrders: 1 },
    }) as any;
    expectNoMoneyKeys(projected);
    expect(JSON.stringify(projected)).not.toMatch(
      /TotalPrice|amount_total|totalRevenue/,
    );
    expect(projected.data[0]).toMatchObject({
      id: '25',
      status: 'sold',
      region_id: '5',
      order_number: 'EL-100025',
      market: { name: 'TEST E2E Market' },
      customer: { name: 'TEST Claude Mijoz 3' },
    });
    expect(projected.homeOrders).toEqual({ homeOrders: 1 });
    expect(projected.summary).toEqual({ deliveredOrders: 1 });
  });

  it('boshqa rollar o‘zgarmagan: menejer — to‘liq, mijoz — total_price qoladi', () => {
    const payload = { data: [orderRow()] };
    expect(projectOrderPayloadForRoles(['manager'], payload)).toBe(payload);
    const customer = projectOrderPayloadForRoles(['customer'], payload) as any;
    expect(customer.data[0].total_price).toBe(100000);
    expect(customer.data[0].sale_collectible_amount).toBe(100000);
  });
});

describe('4BftLLnc — GET /orders (logist)', () => {
  const listReply = (rows: unknown[]) => ({
    data: rows,
    total: rows.length,
    page: 1,
    limit: 10,
  });

  it('o‘z viloyatlari: order-service region_ids = to‘plam; javob pulsiz', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_all_enriched': listReply([
          orderRow(),
          orderRow({ id: '26', region_id: '9' }),
        ]),
      },
    });
    const res: any = await callFindAll(controller, {}, LOGIST);

    const query = lastPayload(order, 'order.find_all_enriched').query;
    expect(query.region_ids).toEqual(OWN_REGIONS);
    expect(query.region_id).toBeUndefined();
    expect(query.branch_id).toBeUndefined();
    expect(res.data.map((row: any) => row.id)).toEqual(['25', '26']);
    expectNoMoneyKeys(res);
  });

  it('«Market» filtri va o‘z viloyati filtri o‘tadi (region_id kanonik)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listReply([]) },
    });
    await callFindAll(controller, { region_id: '09', market_id: '16' }, LOGIST);
    const query = lastPayload(order, 'order.find_all_enriched').query;
    expect(query).toMatchObject({
      region_id: '9',
      region_ids: OWN_REGIONS,
      market_id: '16',
    });
  });

  it('⛔ boshqa viloyat filtri — 400, order-service chaqirilmaydi', async () => {
    const { controller, order } = setup();
    await expect(
      callFindAll(controller, { region_id: '7' }, LOGIST),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('viloyat biriktirilmagan logist — 200, bo‘sh ro‘yxat (403 emas)', async () => {
    const { controller, order } = setup({
      logistics: { 'logistics.region.find_by_logist': regionsReply([]) },
    });
    const res: any = await callFindAll(controller, {}, LOGIST);
    expect(res).toMatchObject({ data: [], total: 0, page: 1, limit: 10 });
    expect(order.send).not.toHaveBeenCalled();
  });

  it('logistics javob bermasa — 503 (doirasiz ro‘yxat YO‘Q)', async () => {
    const { controller, order } = setup({
      logistics: {
        'logistics.region.find_by_logist': new Error('logistics down'),
      },
    });
    await expect(callFindAll(controller, {}, LOGIST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(order.send).not.toHaveBeenCalled();
  });

  it('himoya: order-service filtrni bilmasa ham begona viloyat qatori chiqmaydi', async () => {
    const { controller } = setup({
      order: {
        'order.find_all_enriched': listReply([
          orderRow(),
          orderRow({ id: '27', region_id: '7' }),
          orderRow({ id: '28', region_id: null }),
        ]),
      },
    });
    const res: any = await callFindAll(controller, {}, LOGIST);
    expect(res.data.map((row: any) => row.id)).toEqual(['25']);
  });

  it('boshqa rollar o‘zgarmagan: operator — 403, admin — region_ids yo‘q', async () => {
    const { controller, order, logistics } = setup({
      order: { 'order.find_all_enriched': listReply([orderRow()]) },
    });
    await expect(
      callFindAll(controller, {}, user('3', ['operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const res: any = await callFindAll(controller, {}, user('1', ['admin']));
    expect(
      lastPayload(order, 'order.find_all_enriched').query.region_ids,
    ).toBeUndefined();
    expect(res.data[0].total_price).toBe(100000);
    expect(sentTo(logistics, 'logistics.region.find_by_logist')).toHaveLength(
      0,
    );
  });
});

describe('4BftLLnc — GET /orders/:id (logist)', () => {
  it('o‘z viloyati — 200, pul maydonlari yo‘q', async () => {
    const { controller } = setup({
      order: { 'order.find_by_id_enriched': orderRow() },
    });
    const res: any = await controller.findById('25', LOGIST);
    expect(res).toMatchObject({ id: '25', status: 'sold', region_id: '5' });
    expectNoMoneyKeys(res);
  });

  it('⛔ boshqa viloyat — 403', async () => {
    const { controller } = setup({
      order: { 'order.find_by_id_enriched': orderRow({ region_id: '7' }) },
    });
    await expect(controller.findById('25', LOGIST)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('⛔ viloyatsiz buyurtma yoki viloyatsiz logist — 403', async () => {
    const noRegion = setup({
      order: { 'order.find_by_id_enriched': orderRow({ region_id: null }) },
    });
    await expect(
      noRegion.controller.findById('25', LOGIST),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const unassigned = setup({
      order: { 'order.find_by_id_enriched': orderRow() },
      logistics: { 'logistics.region.find_by_logist': regionsReply([]) },
    });
    await expect(
      unassigned.controller.findById('25', LOGIST),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('4BftLLnc — GET /orders/:id/tracking (logist)', () => {
  const tracking = {
    data: [
      {
        id: 't1',
        action: 'sold',
        new_value: { status: 'sold', total_price: 100000 },
        actor: { id: '26', name: 'Kuryer', role: 'courier' },
      },
    ],
    meta: { page: 1, limit: 20, total: 1 },
  };

  it('@Roles: LOGIST qo‘shilgan', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'getTracking',
    )?.value as object;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).toContain('logist');
  });

  it('o‘z viloyati — 200, hodisalarda pul yo‘q', async () => {
    const { controller } = setup({
      order: {
        'order.find_by_id_enriched': orderRow(),
        'order.tracking': tracking,
      },
    });
    const res: any = await controller.getTracking('25', '1', '20', LOGIST);
    expect(res.data[0]).toMatchObject({
      id: 't1',
      new_value: { status: 'sold' },
    });
    expectNoMoneyKeys(res);
  });

  it('⛔ boshqa viloyat — 403, tarix so‘ralmaydi', async () => {
    const { controller, order } = setup({
      order: {
        'order.find_by_id_enriched': orderRow({ region_id: '7' }),
        'order.tracking': tracking,
      },
    });
    await expect(
      controller.getTracking('25', '1', '20', LOGIST),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.tracking')).toHaveLength(0);
  });

  it('menejer tarixi o‘zgarmagan (pul maydonlari qoladi)', async () => {
    const { controller } = setup({
      order: {
        'order.find_by_id_enriched': orderRow({ branch_id: '3' }),
        'order.tracking': tracking,
      },
    });
    const res: any = await controller.getTracking(
      '25',
      '1',
      '20',
      user('20', ['manager'], '3'),
    );
    expect(res.data[0].new_value.total_price).toBe(100000);
  });
});

describe('4BftLLnc — logist uchun yozish yo‘li YO‘Q', () => {
  it('OrderGatewayController: LOGIST faqat GET /orders/:id/tracking @Roles’ida', () => {
    const proto = OrderGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    const withLogist = Object.getOwnPropertyNames(proto).filter((name) => {
      const fn = proto[name];
      if (typeof fn !== 'function' || name === 'constructor') return false;
      const roles = Reflect.getMetadata(ROLES_KEY, fn) as string[] | undefined;
      return (roles ?? []).map((r) => r.toLowerCase()).includes('logist');
    });
    expect(withLogist).toEqual(['getTracking']);
  });
});

describe('review 2026-10-25 — order.market ichidagi AI narxi logist/kuryerga chiqmaydi', () => {
  it.each(['logist', 'courier'])(
    '%s: market.ai_price_per_order olib tashlanadi',
    (role) => {
      const out = projectOrderPayloadForRoles([role], {
        data: {
          id: '1',
          status: 'new',
          total_price: 10000,
          market_id: '37',
          market: { id: '37', name: 'TEST', ai_price_per_order: 500 },
        },
      }) as { data: { market: Record<string, unknown> } };
      expect(out.data.market.name).toBe('TEST');
      expect(out.data.market).not.toHaveProperty('ai_price_per_order');
    },
  );
});
