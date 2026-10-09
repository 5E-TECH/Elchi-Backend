import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { of, throwError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * fix3 A2 — buyurtma o'qish/o'zgartirish doirasi (order-gateway).
 *
 *  - C11 / CODE-04: GET /orders (OPERATOR, INVESTOR, CUSTOMER,
 *    MARKET_OPERATOR), GET /orders/:id, markets/new, qr-code/:token.
 *  - RBAC-03: /orders/market/:marketId va /orders/markets/:marketId/new rollari.
 *  - C4 (RBAC-21, LC-10): HQ registratori bekor qilinganlar ro'yxatlari.
 *  - RBAC-15: tracking doirasi.
 *  - C6 (M11, CODE-03, RBAC-04): PATCH maydonlari va filial doirasi, DELETE.
 */
/** cmd -> javob qiymati, Error (throwError) yoki (payload) => javob. */
type Handlers = Record<string, unknown>;

const HQ_BRANCH_ID = '1';

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

function setup(
  opts: {
    order?: Handlers;
    identity?: Handlers;
    branch?: Handlers;
  } = {},
) {
  const order = makeClient(opts.order);
  const identity = makeClient(opts.identity);
  const logistics = makeClient();
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: HQ_BRANCH_ID } },
    ...opts.branch,
  });
  const controller = new OrderGatewayController(
    order as any,
    identity as any,
    logistics as any,
    branch as any,
  );
  return { controller, order, identity, branch };
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

const user = (
  sub: string,
  roles: string[],
  branchId?: string,
): { user: { sub: string; username: string; roles: string[] } } =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as any;

const callFindAll = (
  controller: OrderGatewayController,
  q: {
    market_id?: string;
    customer_id?: string;
    status?: string;
    branch_id?: string;
  },
  req: unknown,
) =>
  controller.findAll(
    q.market_id,
    q.customer_id,
    q.status,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    q.branch_id,
    undefined,
    undefined,
    undefined,
    '1',
    '10',
    req as any,
  );

const listOk = { data: [], total: 0, page: 1, limit: 10 };

describe('fix3 A2 — GET /orders role scoping (C11, CODE-04)', () => {
  it.each([['operator'], ['investor'], ['unknown_role']])(
    '%s -> 403, order-service chaqirilmaydi',
    async (role) => {
      const { controller, order } = setup({
        order: { 'order.find_all_enriched': listOk },
      });
      await expect(
        callFindAll(controller, {}, user('9', [role])),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(order.send).not.toHaveBeenCalled();
    },
  );

  it('CUSTOMER -> faqat o‘z customer_id si (so‘rovdagi begona id e’tiborsiz)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
    });
    await callFindAll(
      controller,
      { customer_id: '999' },
      user('600', ['customer']),
    );
    expect(
      lastPayload(order, 'order.find_all_enriched').query.customer_id,
    ).toBe('600');
  });

  it('MARKET_OPERATOR -> faqat biriktirilgan market (server tomonda)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
      identity: { 'identity.user.find_by_id': { data: { market_id: '201' } } },
    });
    await callFindAll(controller, {}, user('400', ['market_operator']));
    expect(lastPayload(order, 'order.find_all_enriched').query.market_id).toBe(
      '201',
    );
  });

  it('MARKET_OPERATOR o`z market_id si bilan -> OK', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
      identity: { 'identity.user.find_by_id': { data: { market_id: '201' } } },
    });
    await callFindAll(
      controller,
      { market_id: '201' },
      user('400', ['market_operator']),
    );
    expect(lastPayload(order, 'order.find_all_enriched').query.market_id).toBe(
      '201',
    );
  });

  it('⭐ MARKET_OPERATOR ?market_id=<boshqa market> -> 400, order-service chaqirilmaydi (WWbdu8ya TC3)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
      identity: { 'identity.user.find_by_id': { data: { market_id: '201' } } },
    });
    await expect(
      callFindAll(
        controller,
        { market_id: '999' },
        user('400', ['market_operator']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sentTo(order, 'order.find_all_enriched')).toHaveLength(0);
  });

  it('MARKET ?market_id=<boshqa market> -> 400 (regressiya, WWbdu8ya TC4)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
    });
    await expect(
      callFindAll(controller, { market_id: '999' }, user('201', ['market'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sentTo(order, 'order.find_all_enriched')).toHaveLength(0);
  });

  it('MARKET_OPERATOR marketsiz -> 403', async () => {
    const { controller, order } = setup({
      identity: { 'identity.user.find_by_id': { data: { market_id: null } } },
    });
    await expect(
      callFindAll(controller, {}, user('400', ['market_operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('ADMIN — avvalgidek doirasiz (o‘zgarmagan)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
    });
    await callFindAll(
      controller,
      { market_id: '5', customer_id: '7' },
      user('1', ['admin']),
    );
    const { query } = lastPayload(order, 'order.find_all_enriched');
    expect(query.market_id).toBe('5');
    expect(query.customer_id).toBe('7');
  });
});

describe('fix3 A2 — HQ registrator cancelled lists (C4)', () => {
  it('GET /orders?status=cancelled: HQ registratori -> holder HQ, filial filtrsiz', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
    });
    await callFindAll(
      controller,
      { status: 'cancelled' },
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    const { query } = lastPayload(order, 'order.find_all_enriched');
    expect(query).toEqual(
      expect.objectContaining({
        status: ['cancelled'],
        holder_type: 'HQ',
        canceled_post_unassigned: true,
      }),
    );
    expect(query.branch_id).toBeUndefined();
  });

  it('GET /orders?status=cancelled: hududiy registrator -> avvalgidek BRANCH + o‘z filiali', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
    });
    await callFindAll(
      controller,
      { status: 'cancelled' },
      user('301', ['registrator'], '21'),
    );
    const { query } = lastPayload(order, 'order.find_all_enriched');
    expect(query.holder_type).toBe('BRANCH');
    expect(query.branch_id).toBe('21');
  });

  it('HQ aniqlanmasa (branch.find_hq xato) -> BRANCH doirasi qoladi (fail-closed)', async () => {
    const { controller, order } = setup({
      order: { 'order.find_all_enriched': listOk },
      branch: { 'branch.find_hq': new Error('branch down') },
    });
    await callFindAll(
      controller,
      { status: 'cancelled' },
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    const { query } = lastPayload(order, 'order.find_all_enriched');
    expect(query.holder_type).toBe('BRANCH');
    expect(query.branch_id).toBe(HQ_BRANCH_ID);
  });

  it('markets/cancelled: HQ registratori -> SA/admin bilan AYNI so‘rov', async () => {
    const { controller, order } = setup();
    await controller.findCancelledMarkets(
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    expect(lastPayload(order, 'order.find_cancelled_markets_enriched')).toEqual(
      {
        market_id: undefined,
        branch_id: undefined,
        holder_type: 'HQ',
        exclude_branch_source: false,
      },
    );
  });

  it('markets/cancelled: hududiy registrator -> BRANCH + o‘z filiali', async () => {
    const { controller, order } = setup();
    await controller.findCancelledMarkets(user('301', ['registrator'], '21'));
    expect(lastPayload(order, 'order.find_cancelled_markets_enriched')).toEqual(
      expect.objectContaining({ branch_id: '21', holder_type: 'BRANCH' }),
    );
  });

  it('markets/cancelled: menejer -> o‘zgarmagan (HQ tekshiruvi chaqirilmaydi)', async () => {
    const { controller, order, branch } = setup();
    await controller.findCancelledMarkets(
      user('55', ['manager'], HQ_BRANCH_ID),
    );
    expect(lastPayload(order, 'order.find_cancelled_markets_enriched')).toEqual(
      expect.objectContaining({
        branch_id: HQ_BRANCH_ID,
        holder_type: 'BRANCH',
      }),
    );
    expect(branch.send).not.toHaveBeenCalled();
  });

  it('markets/:id/cancelled: HQ registratori -> holder HQ, filial filtrsiz', async () => {
    const { controller, order } = setup();
    await controller.findCancelledOrdersByMarket(
      '16',
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    expect(
      lastPayload(order, 'order.find_cancelled_by_market_enriched'),
    ).toEqual({
      market_id: '16',
      branch_id: undefined,
      holder_type: 'HQ',
      exclude_branch_source: false,
    });
  });
});

describe('fix3 A2 — route roles (RBAC-03, CODE-04)', () => {
  const handlerOf = (name: keyof OrderGatewayController): object =>
    Object.getOwnPropertyDescriptor(OrderGatewayController.prototype, name)
      ?.value as object;
  const rolesOf = (handler: unknown) =>
    Reflect.getMetadata(ROLES_KEY, handler as object) as string[];
  const guardsOf = (handler: unknown) =>
    (Reflect.getMetadata(GUARDS_METADATA, handler as object) ??
      []) as unknown[];

  it('GET /orders/market/:marketId — faqat SUPERADMIN/ADMIN/MARKET', () => {
    const handler = handlerOf('findAllByMarket');
    expect(guardsOf(handler)).toContain(RolesGuard);
    expect(rolesOf(handler).sort()).toEqual(
      ['admin', 'market', 'superadmin'].sort(),
    );
  });

  it.each([['findNewMarkets'], ['findNewOrdersByMarket']] as Array<
    [keyof OrderGatewayController]
  >)('%s — kuryer/operator/mijoz/investor kirmaydi', (name) => {
    const handler = handlerOf(name);
    expect(guardsOf(handler)).toContain(RolesGuard);
    const roles = rolesOf(handler);
    for (const denied of [
      'courier',
      'operator',
      'customer',
      'investor',
      'market_operator',
    ]) {
      expect(roles).not.toContain(denied);
    }
    for (const allowed of [
      'superadmin',
      'admin',
      'registrator',
      'manager',
      'branch',
      'market',
    ]) {
      expect(roles).toContain(allowed);
    }
  });

  it('markets/new (MARKET) -> faqat o‘z qatori, boshqa market profili sizmaydi', async () => {
    const { controller, identity } = setup({
      order: {
        'order.find_new_markets_enriched': [
          { market_id: '201', orders_count: 2 },
          { market_id: '202', orders_count: 5 },
        ],
      },
      identity: {
        'identity.market.find_by_ids': { data: [{ id: '201', name: 'M' }] },
      },
    });
    const rows = (await controller.findNewMarkets(
      user('201', ['market']),
    )) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.market_id)).toEqual(['201']);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.market.find_by_ids' },
      { ids: ['201'] },
    );
  });

  it('markets/new (ADMIN) -> barcha qatorlar (o‘zgarmagan)', async () => {
    const { controller } = setup({
      order: {
        'order.find_new_markets_enriched': [
          { market_id: '201' },
          { market_id: '202' },
        ],
      },
      identity: { 'identity.market.find_by_ids': { data: [] } },
    });
    const rows = (await controller.findNewMarkets(
      user('1', ['admin']),
    )) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
  });
});

describe('fix3 A2 — QR lookup (C11)', () => {
  const qrOrder = (marketId: string) => ({
    'order.find_by_qr_enriched': {
      statusCode: 200,
      data: { id: '77', market_id: marketId },
    },
  });

  it('MARKET boshqa market posilkasi -> 403', async () => {
    const { controller } = setup({ order: qrOrder('202') });
    await expect(
      controller.findByQrCode('ORD-x', user('201', ['market'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('MARKET o‘z posilkasi -> OK', async () => {
    const { controller } = setup({ order: qrOrder('201') });
    await expect(
      controller.findByQrCode('ORD-x', user('201', ['market'])),
    ).resolves.toMatchObject({ data: { id: '77' } });
  });

  it('KURYER — skan oqimi uchun cheklanmaydi (O‘zimga olish)', async () => {
    const { controller } = setup({ order: qrOrder('202') });
    await expect(
      controller.findByQrCode('ORD-x', user('179', ['courier'])),
    ).resolves.toMatchObject({ data: { id: '77' } });
  });
});

describe('fix3 A2 — GET /orders/:id visibility (C11, CODE-04)', () => {
  const withOrder = (data: Record<string, unknown>) => ({
    'order.find_by_id_enriched': { statusCode: 200, data },
  });

  it('OPERATOR -> 403 (ilgari to‘liq kirish)', async () => {
    const { controller } = setup({
      order: withOrder({ id: '1', market_id: '201' }),
    });
    await expect(
      controller.findById('1', user('9', ['operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('MARKET_OPERATOR: o‘z marketi -> OK, boshqasi -> 403', async () => {
    const identity = {
      'identity.user.find_by_id': { data: { market_id: '201' } },
    };
    const own = setup({
      order: withOrder({ id: '1', market_id: '201' }),
      identity,
    });
    await expect(
      own.controller.findById('1', user('400', ['market_operator'])),
    ).resolves.toMatchObject({ data: { id: '1' } });

    const other = setup({
      order: withOrder({ id: '2', market_id: '202' }),
      identity,
    });
    await expect(
      other.controller.findById('2', user('400', ['market_operator'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('HQ registratori HQ qo‘lidagi (filialdan qaytgan) buyurtmani ko‘radi', async () => {
    const { controller } = setup({
      order: withOrder({
        id: '3',
        branch_id: '21',
        home_branch_id: '21',
        holder_type: 'HQ',
        holder_branch_id: null,
      }),
    });
    await expect(
      controller.findById('3', user('300', ['registrator'], HQ_BRANCH_ID)),
    ).resolves.toMatchObject({ data: { id: '3' } });
  });

  it('boshqa hududiy registrator o‘sha buyurtmani ko‘rmaydi', async () => {
    const { controller } = setup({
      order: withOrder({
        id: '3',
        branch_id: '21',
        home_branch_id: '21',
        holder_type: 'HQ',
        holder_branch_id: null,
      }),
    });
    await expect(
      controller.findById('3', user('302', ['registrator'], '22')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('fix3 A2 — tracking scope (RBAC-15)', () => {
  const trackingHandlers = (data: Record<string, unknown>) => ({
    'order.find_by_id_enriched': { statusCode: 200, data },
    'order.tracking': { data: [{ id: 't1' }], total: 1 },
  });

  it('HQ registratori HQ qo‘lidagi buyurtma trackingini ko‘radi', async () => {
    const { controller } = setup({
      order: trackingHandlers({
        id: '5',
        branch_id: '21',
        holder_type: 'HQ',
        holder_branch_id: null,
      }),
    });
    await expect(
      controller.getTracking(
        '5',
        undefined,
        undefined,
        user('300', ['registrator'], HQ_BRANCH_ID),
      ),
    ).resolves.toMatchObject({ total: 1 });
  });

  it('menejer o‘z filiali buyurtmasini kuryer qo‘lida bo‘lsa ham ko‘radi', async () => {
    const { controller } = setup({
      order: trackingHandlers({
        id: '6',
        branch_id: '21',
        holder_type: 'COURIER',
        holder_courier_id: '179',
        holder_branch_id: null,
      }),
    });
    await expect(
      controller.getTracking(
        '6',
        undefined,
        undefined,
        user('55', ['manager'], '21'),
      ),
    ).resolves.toMatchObject({ total: 1 });
  });

  it('boshqa filial menejeri -> 403', async () => {
    const { controller } = setup({
      order: trackingHandlers({
        id: '6',
        branch_id: '21',
        holder_type: 'COURIER',
        holder_courier_id: '179',
      }),
    });
    await expect(
      controller.getTracking(
        '6',
        undefined,
        undefined,
        user('56', ['manager'], '22'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('HQ aniqlanmasa HQ qo‘lidagi buyurtma -> 403 (fail-closed)', async () => {
    const { controller } = setup({
      order: trackingHandlers({
        id: '5',
        branch_id: '21',
        holder_type: 'HQ',
        holder_branch_id: null,
      }),
      branch: { 'branch.find_hq': new Error('branch down') },
    });
    await expect(
      controller.getTracking(
        '5',
        undefined,
        undefined,
        user('300', ['registrator'], HQ_BRANCH_ID),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('fix3 A2 — PATCH /orders/:id (C6, M11, CODE-03)', () => {
  const ownOrder = {
    'order.find_by_id': {
      statusCode: 200,
      data: { id: '10', branch_id: '21', holder_branch_id: '21' },
    },
    'order.update_from_api': { statusCode: 200, data: { id: '10' } },
  };

  it.each([
    [{ status: 'sold' }],
    [{ market_id: '202' }],
    [{ to_be_paid: 0 }],
    [{ paid_amount: 100 }],
  ])('superadmin ham %j yubora olmaydi -> 400', async (dto) => {
    const { controller, order } = setup({ order: ownOrder });
    await expect(
      controller.update('10', dto as any, user('1', ['superadmin'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sentTo(order, 'order.update_from_api')).toHaveLength(0);
  });

  it('PATCH :id/full ham xuddi shu qoidada (status -> 400)', async () => {
    const { controller, order } = setup({ order: ownOrder });
    await expect(
      controller.updateFull(
        '10',
        { status: 'paid' } as any,
        user('1', ['admin']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sentTo(order, 'order.update_from_api')).toHaveLength(0);
  });

  it.each([
    [{ post_id: '4' }],
    [{ customer_id: '9' }],
    [{ qr_code_token: 'ORD-z' }],
    [{ source: 'branch' }],
  ])('admin %j -> 403 (faqat superadmin)', async (dto) => {
    const { controller, order } = setup({ order: ownOrder });
    await expect(
      controller.update('10', dto as any, user('2', ['admin'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.update_from_api')).toHaveLength(0);
  });

  it('superadmin post_id -> uzatiladi (filial tekshiruvisiz)', async () => {
    const { controller, order } = setup({ order: ownOrder });
    await controller.update(
      '10',
      { post_id: '4' } as any,
      user('1', ['superadmin']),
    );
    expect(lastPayload(order, 'order.update_from_api')).toEqual({
      id: '10',
      dto: { post_id: '4' },
      requester: { id: '1', roles: ['superadmin'] },
    });
    expect(sentTo(order, 'order.find_by_id')).toHaveLength(0);
  });

  it('REGISTRATOR o‘z filiali buyurtmasi -> uzatiladi', async () => {
    const { controller, order } = setup({ order: ownOrder });
    await controller.updateFull(
      '10',
      { comment: 'ok', total_price: 5000 } as any,
      user('300', ['registrator'], '21'),
    );
    expect(lastPayload(order, 'order.update_from_api').dto).toEqual({
      comment: 'ok',
      total_price: 5000,
    });
  });

  it('REGISTRATOR boshqa filial buyurtmasi -> 403', async () => {
    const { controller, order } = setup({ order: ownOrder });
    await expect(
      controller.update(
        '10',
        { comment: 'x' } as any,
        user('301', ['registrator'], '22'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.update_from_api')).toHaveLength(0);
  });
});

describe('fix3 A2 — DELETE /orders/:id (C6, RBAC-04)', () => {
  const orderOf = (data: Record<string, unknown>) => ({
    'order.find_by_id': { statusCode: 200, data },
    'order.delete': { statusCode: 200, data: {} },
  });

  it('MARKET boshqa market buyurtmasi -> 403, o‘chirilmaydi', async () => {
    const { controller, order } = setup({
      order: orderOf({ id: '10', market_id: '202', status: 'new' }),
    });
    await expect(
      controller.remove('10', user('201', ['market'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(order, 'order.delete')).toHaveLength(0);
  });

  it('MARKET o‘z buyurtmasi -> order.delete ga uzatiladi', async () => {
    const { controller, order } = setup({
      order: orderOf({ id: '10', market_id: '201', status: 'new' }),
    });
    await controller.remove('10', user('201', ['market']));
    expect(lastPayload(order, 'order.delete')).toEqual({
      id: '10',
      requester: { id: '201', roles: ['market'] },
    });
  });

  it('REGISTRATOR boshqa filial -> 403; o‘z filiali -> uzatiladi', async () => {
    const other = setup({
      order: orderOf({ id: '10', branch_id: '21', home_branch_id: '21' }),
    });
    await expect(
      other.controller.remove('10', user('301', ['registrator'], '22')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sentTo(other.order, 'order.delete')).toHaveLength(0);

    const own = setup({
      order: orderOf({ id: '10', branch_id: '21', home_branch_id: '21' }),
    });
    await own.controller.remove('10', user('300', ['registrator'], '21'));
    expect(sentTo(own.order, 'order.delete')).toHaveLength(1);
  });

  it('ADMIN -> oldindan o‘qishsiz uzatiladi (holat qoidalari order-service’da)', async () => {
    const { controller, order } = setup({ order: orderOf({ id: '10' }) });
    await controller.remove('10', user('1', ['admin']));
    expect(sentTo(order, 'order.find_by_id')).toHaveLength(0);
    expect(sentTo(order, 'order.delete')).toHaveLength(1);
  });
});
