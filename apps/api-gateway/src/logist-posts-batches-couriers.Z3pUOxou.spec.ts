import 'reflect-metadata';
import {
  BadRequestException,
  RequestMethod,
  ServiceUnavailableException,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { LogistRegionScopeService } from './auth/logist-scope';
import { ApiGatewayController } from './api-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * Z3pUOxou — logist: pochtalar, filial paketlari va kuryerlar ro'yxati —
 * faqat ko'rish, o'z viloyatlari (regions.logist_id = me), pulsiz (ega
 * LG-S1/LG-S3). Gateway qatlami: @Roles, doira uzatilishi, himoya filtri va
 * pul maydonlari proyeksiyasi; boshqa rollar javobi o'zgarmaydi.
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

const OWN = ['5', '9'];
const scopeWith = (ids: string[] | Error = OWN) =>
  new LogistRegionScopeService(
    makeClient({
      'logistics.region.find_by_logist':
        ids instanceof Error
          ? ids
          : { statusCode: 200, data: { region_ids: ids } },
    }) as never,
  );

const LOGIST = { user: { sub: '42', username: 'l', roles: ['logist'] } };
const MANAGER = { user: { sub: '20', username: 'm', roles: ['manager'] } };

const lastPayload = (client: { send: jest.Mock }, cmd: string) => {
  const calls = (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string }).cmd === cmd,
  );
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, any>;
};

const MONEY_RE =
  /"(total_price|post_total_price|amount_total|snapshot_price|market_tariff|courier_tariff|tariff_home|tariff_center|salary|payment_day|commission_type|commission_value|compensation_mode|balance|homeOrdersTotalPrice|centerOrdersTotalPrice|sent_total_price)"/;

/** Kontrollerning `logist` rolli marshrutlari (handler nomi → HTTP metod). */
function logistRoutes(controller: { prototype: object }) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => {
      const fn = proto[name];
      if (typeof fn !== 'function' || name === 'constructor') return false;
      const roles = Reflect.getMetadata(ROLES_KEY, fn) as string[] | undefined;
      return (roles ?? []).map((r) => r.toLowerCase()).includes('logist');
    })
    .map((name) => ({
      name,
      method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object) as
        | RequestMethod
        | undefined,
    }));
}

describe('Z3pUOxou — @Roles: faqat o‘qish yo‘llari', () => {
  it('Logistics: GET /post, /post/:id, /post/orders/:id (+ region stats); yozish yo‘q', () => {
    const routes = logistRoutes(LogisticsGatewayController);
    expect(routes.map((r) => r.name).sort()).toEqual(
      [
        'getAllPosts',
        'getAllRegionStats',
        'getOrdersByPost',
        'getPostById',
        'getRegionStatsById',
      ].sort(),
    );
    expect(routes.every((r) => r.method === RequestMethod.GET)).toBe(true);
  });

  it('Branch: GET /transfer-batches va /:id; yozish (send/receive/cancel/scan) yo‘q', () => {
    const routes = logistRoutes(BranchGatewayController);
    expect(routes.map((r) => r.name).sort()).toEqual(
      ['findTransferBatchById', 'findTransferBatches'].sort(),
    );
    expect(routes.every((r) => r.method === RequestMethod.GET)).toBe(true);
  });

  it('ApiGateway: logist yozish yo‘llarida yo‘q, GET /couriers da bor', () => {
    const routes = logistRoutes(ApiGatewayController);
    expect(routes.map((r) => r.name)).toContain('getCouriers');
    expect(routes.every((r) => r.method === RequestMethod.GET)).toBe(true);
  });
});

describe('Z3pUOxou — GET /post, /post/:id, /post/orders/:id (gateway)', () => {
  const postList = {
    statusCode: 200,
    data: {
      data: [{ id: '11', region_id: '5', post_total_price: 250000 }],
      total: 1,
      orders_total: 2,
      amount_total: 250000,
    },
  };

  it('logist: so‘rovchi uzatiladi, javobda pul yo‘q; menejer javobi o‘zgarmagan', async () => {
    const logistics = makeClient({ 'logistics.post.find_all': postList });
    const controller = new LogisticsGatewayController(
      logistics as never,
      makeClient() as never,
    );
    const res: any = await firstValueFrom(
      controller.getAllPosts('1', '10', undefined, undefined, LOGIST as never),
    );
    expect(lastPayload(logistics, 'logistics.post.find_all').requester).toEqual(
      { id: '42', roles: ['logist'] },
    );
    expect(JSON.stringify(res)).not.toMatch(MONEY_RE);
    expect(res.data.orders_total).toBe(2);

    const managerRes: any = await firstValueFrom(
      controller.getAllPosts('1', '10', undefined, undefined, MANAGER as never),
    );
    expect(managerRes).toBe(postList);
  });

  it('logist: /post/:id — post_total_price yo‘q', async () => {
    const logistics = makeClient({
      'logistics.post.find_by_id': {
        statusCode: 200,
        data: { id: '11', region_id: '5', post_total_price: 1 },
      },
    });
    const controller = new LogisticsGatewayController(
      logistics as never,
      makeClient() as never,
    );
    const res: any = await firstValueFrom(
      controller.getPostById('11', LOGIST as never),
    );
    expect(res.data).toEqual({ id: '11', region_id: '5' });
  });

  it('logist: /post/orders/:id — buyurtma qatorlari va summalar pulsiz', async () => {
    const logistics = makeClient({
      'logistics.post.orders_by_post': {
        statusCode: 200,
        data: {
          allOrdersByPostId: [
            {
              id: '100',
              market_id: '16',
              region_id: '5',
              status: 'on the road',
              total_price: 150000,
              market_tariff: 20000,
              to_be_paid: 130000,
            },
          ],
          homeOrders: { homeOrders: 1, homeOrdersTotalPrice: 150000 },
          centerOrders: { centerOrders: 0, centerOrdersTotalPrice: 0 },
        },
      },
      'logistics.district.find_by_id': { statusCode: 200, data: null },
    });
    const controller = new LogisticsGatewayController(
      logistics as never,
      makeClient({
        'identity.market.find_by_id': {
          data: { id: '16', name: 'M', tariff_home: 1 },
        },
      }) as never,
    );
    const res: any = await controller.getOrdersByPost('11', LOGIST as never);
    expect(JSON.stringify(res)).not.toMatch(MONEY_RE);
    expect(JSON.stringify(res)).not.toContain('to_be_paid');
    expect(res.data.allOrdersByPostId[0]).toEqual(
      expect.objectContaining({ id: '100', status: 'on the road' }),
    );
    expect(res.data.homeOrders).toEqual({ homeOrders: 1 });
  });
});

describe('Z3pUOxou — GET /transfer-batches (gateway)', () => {
  const batches = {
    statusCode: 200,
    data: {
      items: [
        {
          id: '601',
          target_region_id: '5',
          total_price: 250000,
          items: [{ id: '1', order_id: '100', snapshot_price: 250000 }],
        },
        { id: '602', target_region_id: '7', total_price: 1 },
      ],
      meta: { page: 1, limit: 20, total: 2, totalPages: 1 },
    },
  };

  const call = (
    controller: BranchGatewayController,
    req: unknown,
    targetRegionId?: string,
  ) =>
    controller.findTransferBatches(
      undefined,
      undefined,
      'SENT',
      undefined,
      undefined,
      undefined,
      '1',
      '20',
      req as never,
      targetRegionId,
    );

  it('logist: requester.region_ids = o‘z viloyatlari; begona qator va pul yo‘q', async () => {
    const branch = makeClient({ 'branch.transfer_batches.find_all': batches });
    const controller = new BranchGatewayController(
      branch as never,
      scopeWith(),
    );
    const res: any = await call(controller, LOGIST);
    const payload = lastPayload(branch, 'branch.transfer_batches.find_all');
    expect(payload.requester).toEqual({
      id: '42',
      roles: ['logist'],
      region_ids: OWN,
    });
    expect(payload.query).toEqual(
      expect.objectContaining({ status: 'SENT', target_region_id: undefined }),
    );
    expect(res.data.items.map((b: any) => b.id)).toEqual(['601']);
    expect(JSON.stringify(res)).not.toMatch(MONEY_RE);
  });

  it('⛔ logist: boshqa viloyat filtri — 400, branch-service chaqirilmaydi', async () => {
    const branch = makeClient();
    const controller = new BranchGatewayController(
      branch as never,
      scopeWith(),
    );
    await expect(call(controller, LOGIST, '7')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(branch.send).not.toHaveBeenCalled();
  });

  it('logist: viloyat xizmati yo‘q yoki xato — 503 (fail-closed)', async () => {
    const branch = makeClient();
    await expect(
      call(new BranchGatewayController(branch as never), LOGIST),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      call(
        new BranchGatewayController(
          branch as never,
          scopeWith(new Error('down')),
        ),
        LOGIST,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(branch.send).not.toHaveBeenCalled();
  });

  it('menejer: payload va javob o‘zgarmagan (region_ids yo‘q, pul qoladi)', async () => {
    const branch = makeClient({ 'branch.transfer_batches.find_all': batches });
    const controller = new BranchGatewayController(
      branch as never,
      scopeWith(),
    );
    const res: any = await firstValueFrom(
      call(controller, MANAGER, '5') as never,
    );
    const payload = lastPayload(branch, 'branch.transfer_batches.find_all');
    expect(payload.requester).toEqual({ id: '20', roles: ['manager'] });
    expect(payload.query.target_region_id).toBe('5');
    expect(res).toBe(batches);
  });

  it('logist: /transfer-batches/:id — region_ids uzatiladi, javob pulsiz', async () => {
    const branch = makeClient({
      'branch.transfer_batches.find_by_id': {
        id: '601',
        target_region_id: '5',
        total_price: 250000,
        items: [
          {
            id: '1',
            snapshot_price: 250000,
            order: { id: '100', market_id: '16', total_price: 250000 },
          },
        ],
      },
    });
    const controller = new BranchGatewayController(
      branch as never,
      scopeWith(),
    );
    const res: any = await controller.findTransferBatchById(
      '601',
      LOGIST as never,
    );
    expect(
      lastPayload(branch, 'branch.transfer_batches.find_by_id').requester,
    ).toEqual({ id: '42', roles: ['logist'], region_ids: OWN });
    expect(JSON.stringify(res)).not.toMatch(MONEY_RE);
    expect(res.items[0].order).toEqual({ id: '100', market_id: '16' });
  });
});

describe('Z3pUOxou — GET /couriers (gateway)', () => {
  const couriers = () => ({
    statusCode: 200,
    data: {
      items: [
        {
          id: '26',
          name: 'TEST Claude Kuryer',
          phone_number: '+998900000026',
          region_id: '5',
          region: { id: '5', name: 'Samarqand' },
          status: 'active',
          salary: 3000000,
          payment_day: 10,
          tariff_home: 15000,
          tariff_center: 10000,
          compensation_mode: 'per_order',
          commission_type: null,
          commission_value: null,
        },
        { id: '27', name: 'Begona', region_id: '7', salary: 1 },
      ],
      meta: { page: 1, limit: 10, total: 2, totalPages: 1 },
    },
  });

  // `null` — xizmat umuman yo'q (DI'da topilmagan holat).
  const build = (scope: LogistRegionScopeService | null = scopeWith()) => {
    const identity = makeClient({ 'identity.courier.find_all': couriers() });
    const finance = makeClient();
    const branch = makeClient();
    const controller = new ApiGatewayController(
      identity as never,
      finance as never,
      branch as never,
      undefined,
      scope ?? undefined,
    );
    return { controller, identity, finance, branch };
  };

  const call = (
    controller: ApiGatewayController,
    req: unknown,
    regionId?: string,
  ) =>
    controller.getCouriers(
      undefined,
      undefined,
      regionId,
      undefined,
      undefined,
      '1',
      '10',
      req as never,
    );

  it('logist: identity’ga region_ids (qat’iy), filial/kassa so‘ralmaydi, pul yo‘q', async () => {
    const { controller, identity, finance, branch } = build();
    const res: any = await call(controller, LOGIST);
    const query = lastPayload(identity, 'identity.courier.find_all').query;
    expect(query.region_ids).toEqual(OWN);
    expect(query.region_id).toBeUndefined();
    expect(branch.send).not.toHaveBeenCalled();
    expect(finance.send).not.toHaveBeenCalled();
    expect(res.data.items.map((c: any) => c.id)).toEqual(['26']);
    expect(res.data.items[0]).toEqual(
      expect.objectContaining({
        name: 'TEST Claude Kuryer',
        phone_number: '+998900000026',
        status: 'active',
      }),
    );
    expect(JSON.stringify(res)).not.toMatch(MONEY_RE);
  });

  it('logist: o‘z viloyati filtri — [region]; ⛔ boshqasi — 400', async () => {
    const { controller, identity } = build();
    await call(controller, LOGIST, '9');
    expect(
      lastPayload(identity, 'identity.courier.find_all').query.region_ids,
    ).toEqual(['9']);
    await expect(call(controller, LOGIST, '7')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('logist: viloyatsiz — bo‘sh; xizmat yo‘q — 503', async () => {
    const empty = build(scopeWith([]));
    const res: any = await call(empty.controller, LOGIST);
    expect(res.data.items).toEqual([]);
    expect(empty.identity.send).not.toHaveBeenCalled();

    const noScope = build(null);
    await expect(call(noScope.controller, LOGIST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
