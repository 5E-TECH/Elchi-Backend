import {
  BadRequestException,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * GaBIPi3Z — GET /orders/status-counts: holat tablari sonlari + «Qabul va
 * yaratish» badge'i. Doira GET /orders bilan AYNAN bir xil
 * (`resolveOrderListRequest`): market/operator — o'z marketi, filial xodimi —
 * o'z filiali (+ «Bekor» tabi inventar rejimida), HQ registratori — HQ
 * inventari, kuryer — o'zi (+ kuryer bekor tabi), logist — faqat o'z
 * viloyatlari, ruxsatsiz rol — 403. Javobda pul maydoni yo'q.
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

const COUNTS_REPLY = {
  by_status: {
    new: 32,
    received: 120,
    'on the road': 80,
    waiting: 41,
    waiting_customer: 3,
    sold: 600,
    paid: 290,
    partly_paid: 10,
    cancelled: 70,
    'cancelled (sent)': 5,
  },
  total: 1251,
  cancelled: null,
  new_incoming: 7,
  search_truncated: false,
};

function setup(
  opts: {
    order?: Handlers;
    branchAssignment?: { branch_id: string; role: string } | null;
    hqRegistrator?: boolean;
    operatorMarketId?: string | null;
    logistRegions?: string[];
  } = {},
) {
  const order = makeClient({
    'order.status_counts': COUNTS_REPLY,
    ...opts.order,
  });
  const logistics = makeClient({
    'logistics.region.find_by_logist': {
      statusCode: 200,
      data: {
        logist_id: '42',
        region_ids: opts.logistRegions ?? ['5', '9'],
        regions: [],
      },
    },
  });
  const controller = new OrderGatewayController(
    order as never,
    makeClient() as never,
    logistics as never,
    makeClient() as never,
  );
  const internals = controller as unknown as Record<string, jest.Mock>;
  internals.resolveBranchAssignment = jest
    .fn()
    .mockResolvedValue(
      opts.branchAssignment === undefined
        ? { branch_id: '3', role: 'MANAGER' }
        : opts.branchAssignment,
    );
  internals.isHqRegistrator = jest
    .fn()
    .mockResolvedValue(opts.hqRegistrator ?? false);
  internals.resolveMarketOperatorMarketId = jest
    .fn()
    .mockResolvedValue(
      opts.operatorMarketId === undefined ? '37' : opts.operatorMarketId,
    );
  return { controller, order, logistics };
}

const user = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as never;

type Q = Partial<{
  market_id: string;
  search: string;
  start_day: string;
  end_day: string;
  region_id: string;
  district_id: string;
  branch_id: string;
  courier_id: string;
  where_deliver: string;
  source: string;
  cancelled_inventory: string;
  fulfillment_source: string;
  cancel_stage: string;
}>;

const call = (controller: OrderGatewayController, req: unknown, q: Q = {}) =>
  controller.statusCounts(
    req as never,
    q.market_id,
    undefined,
    q.search,
    q.start_day,
    q.end_day,
    undefined,
    q.region_id,
    q.district_id,
    q.branch_id,
    undefined,
    q.source,
    q.courier_id,
    q.where_deliver,
    q.cancelled_inventory,
    q.fulfillment_source,
    q.cancel_stage,
  );

const countsPayload = (order: { send: jest.Mock }) => {
  const calls = (order.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string })?.cmd === 'order.status_counts',
  );
  expect(calls).toHaveLength(1);
  return calls[0][1] as {
    query: Record<string, unknown>;
    cancelled_query: Record<string, unknown> | null;
    new_incoming: Record<string, unknown> | null;
  };
};

describe('GaBIPi3Z — GET /orders/status-counts', () => {
  it('⭐ SA: tab guruhlari (paid = paid+partly_paid, cancelled = cancelled+sent), all = total, by_status, new_incoming', async () => {
    const { controller, order } = setup();
    const res = (await call(controller, user('1', ['superadmin']))) as {
      data: Record<string, unknown>;
    };
    expect(res.data).toEqual({
      all: 1251,
      new: 32,
      received: 120,
      on_the_road: 80,
      waiting: 41,
      sold: 600,
      paid: 300,
      cancelled: 75,
      new_incoming: 7,
      by_status: COUNTS_REPLY.by_status,
      search_truncated: false,
    });
    const payload = countsPayload(order);
    // Holat filtri yo'q, SA — filtrsiz; «Bekor» tabi GROUP BY dan.
    expect(payload.query.status).toBeUndefined();
    expect(payload.query.market_id).toBeUndefined();
    expect(payload.query.branch_id).toBeUndefined();
    expect(payload.cancelled_query).toBeNull();
    expect(payload.new_incoming).toEqual({ exclude_branch_source: true });
    // BITTA so'rov (8 ta alohida emas).
    expect(order.send).toHaveBeenCalledTimes(1);
  });

  it("⭐ GET /orders filtrlari o'tadi (market, sana, qidiruv, where_deliver, region, filial, kuryer, manba)", async () => {
    const { controller, order } = setup();
    await call(controller, user('1', ['admin']), {
      market_id: '37',
      start_day: '2026-10-01',
      end_day: '2026-10-26',
      search: 'EL-100081',
      where_deliver: 'center',
      region_id: '5',
      district_id: '501',
      branch_id: '3',
      courier_id: '26',
      fulfillment_source: 'warehouse',
    });
    expect(countsPayload(order).query).toMatchObject({
      market_id: '37',
      start_day: '2026-10-01',
      end_day: '2026-10-26',
      search: 'EL-100081',
      where_deliver: 'center',
      region_id: '5',
      district_id: '501',
      branch_id: '3',
      courier_ids: ['26'],
      fulfillment_source: 'WAREHOUSE',
    });
  });

  it('⭐ market: o`z id`si (query market_id e`tiborsiz emas — boshqasi 400), badge — o`z marketi', async () => {
    const { controller, order } = setup();
    await call(controller, user('37', ['market']));
    const payload = countsPayload(order);
    expect(payload.query.market_id).toBe('37');
    expect(payload.cancelled_query).toBeNull();
    expect(payload.new_incoming).toEqual({
      exclude_branch_source: true,
      market_id: '37',
    });

    const other = setup();
    await expect(
      call(other.controller, user('37', ['market']), { market_id: '16' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(other.order.send).not.toHaveBeenCalled();
  });

  it('⭐ market operatori: biriktirilgan market, boshqa market 400, badge yo`q (null)', async () => {
    const { controller, order } = setup({ operatorMarketId: '37' });
    const res = (await call(controller, user('55', ['market_operator']))) as {
      data: Record<string, unknown>;
    };
    const payload = countsPayload(order);
    expect(payload.query.market_id).toBe('37');
    expect(payload.new_incoming).toBeNull();
    expect(res.data.new_incoming).toBeNull();

    const other = setup({ operatorMarketId: '37' });
    await expect(
      call(other.controller, user('55', ['market_operator']), {
        market_id: '16',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const unassigned = setup({ operatorMarketId: null });
    await expect(
      call(unassigned.controller, user('55', ['market_operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('⭐ menejer: tokendagi filial (query branch_id emas); «Bekor» — filial inventari (alohida COUNT); badge — o`z filiali', async () => {
    const { controller, order } = setup({
      branchAssignment: { branch_id: '3', role: 'MANAGER' },
      order: {
        'order.status_counts': { ...COUNTS_REPLY, cancelled: 4 },
      },
    });
    const res = (await call(controller, user('25', ['manager']), {
      branch_id: '99',
    })) as { data: Record<string, unknown> };
    const payload = countsPayload(order);
    expect(payload.query.branch_id).toBe('3');
    expect(payload.query.holder_type).toBeUndefined();
    expect(payload.cancelled_query).toMatchObject({
      branch_id: '3',
      status: ['cancelled'],
      holder_type: 'BRANCH',
      canceled_post_unassigned: true,
    });
    expect(payload.new_incoming).toEqual({ branch_id: '3' });
    // GET /orders?status=cancelled,... (menejer) bilan AYNI son.
    expect(res.data.cancelled).toBe(4);
  });

  it('registrator / filial: filialga biriktirilmagan — 400 (GET /orders kabi)', async () => {
    const { controller, order } = setup({ branchAssignment: null });
    await expect(
      call(controller, user('30', ['registrator'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('HQ registratori: «Bekor» — HQ inventari (filialsiz), qolgan tablar — o`z filiali', async () => {
    const { controller, order } = setup({
      branchAssignment: { branch_id: '1', role: 'REGISTRATOR' },
      hqRegistrator: true,
    });
    await call(controller, user('30', ['registrator']));
    const payload = countsPayload(order);
    expect(payload.query.branch_id).toBe('1');
    expect(payload.cancelled_query).toMatchObject({
      holder_type: 'HQ',
      canceled_post_unassigned: true,
      status: ['cancelled'],
    });
    expect(payload.cancelled_query?.branch_id).toBeUndefined();
    expect(payload.new_incoming).toEqual({ branch_id: '1' });
  });

  it('SA cancelled_inventory=true: «Bekor» — HQ inventari (GET /orders kabi)', async () => {
    const { controller, order } = setup();
    await call(controller, user('1', ['superadmin']), {
      cancelled_inventory: 'true',
    });
    expect(countsPayload(order).cancelled_query).toMatchObject({
      holder_type: 'HQ',
      canceled_post_unassigned: true,
    });
  });

  it('⭐ kuryer: faqat o`zi (courier_ids = sub, query courier_id e`tiborsiz); «Bekor» — kuryer bekor tabi; badge yo`q', async () => {
    const { controller, order } = setup({
      order: {
        'order.status_counts': { ...COUNTS_REPLY, cancelled: 2 },
      },
    });
    const res = (await call(controller, user('26', ['courier']), {
      courier_id: '77',
    })) as { data: Record<string, unknown> };
    const payload = countsPayload(order);
    expect(payload.query.courier_ids).toEqual(['26']);
    expect(payload.cancelled_query).toMatchObject({
      status: ['cancelled'],
      courier_ids: ['26'],
      holder_courier_ids: ['26'],
      courier_scope: 'any',
      courier_post_history: true,
      courier_cancelled_tab: true,
    });
    expect(payload.new_incoming).toBeNull();
    expect(res.data.cancelled).toBe(2);
  });

  it('⭐ logist: faqat o`z viloyatlari (region_ids), begona viloyat 400, viloyatsiz — nol (order-service`ga so`rov yo`q)', async () => {
    const { controller, order } = setup({ logistRegions: ['5', '9'] });
    await call(controller, user('42', ['logist']), { region_id: '9' });
    const payload = countsPayload(order);
    expect(payload.query.region_ids).toEqual(['5', '9']);
    expect(payload.query.region_id).toBe('9');
    expect(payload.new_incoming).toBeNull();

    const foreign = setup({ logistRegions: ['5', '9'] });
    await expect(
      call(foreign.controller, user('42', ['logist']), { region_id: '7' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const none = setup({ logistRegions: [] });
    const res = (await call(none.controller, user('42', ['logist']))) as {
      data: Record<string, unknown>;
    };
    expect(res.data).toMatchObject({
      all: 0,
      new: 0,
      paid: 0,
      cancelled: 0,
      new_incoming: null,
    });
    expect(
      (none.order.send.mock.calls as unknown[][]).some(
        (args) => (args[0] as { cmd?: string })?.cmd === 'order.status_counts',
      ),
    ).toBe(false);
  });

  it('ruxsatsiz rol (investor) — 403, order-service`ga so`rov yo`q', async () => {
    const { controller, order } = setup();
    await expect(
      call(controller, user('77', ['investor'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('javobda pul maydonlari yo`q (logist / market)', async () => {
    const { controller } = setup();
    const res = await call(controller, user('42', ['logist']));
    const json = JSON.stringify(res);
    for (const key of ['total_price', 'price', 'tariff', 'share', 'amount']) {
      expect(json).not.toContain(key);
    }
  });
});

describe('GaBIPi3Z — HTTP marshrut: /orders/status-counts `:id` ga tushmaydi', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            sub: '1',
            roles: ['admin'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /orders/status-counts?status=sold → order.status_counts (status e`tiborsiz), 200', async () => {
    orderSend.mockReturnValue(of(COUNTS_REPLY));
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    ).get('/orders/status-counts?status=sold&start_day=2026-10-01');
    expect(res.status).toBe(200);
    expect((orderSend.mock.calls[0] as unknown[])[0]).toEqual({
      cmd: 'order.status_counts',
    });
    const payload = (orderSend.mock.calls[0] as unknown[])[1] as {
      query: Record<string, unknown>;
    };
    expect(payload.query.status).toBeUndefined();
    expect(payload.query.start_day).toBe('2026-10-01');
    expect((res.body as { data: { all: number } }).data.all).toBe(1251);
  });
});
