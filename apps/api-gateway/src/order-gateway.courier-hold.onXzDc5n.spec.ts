import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';

/**
 * onXzDc5n — kuryerdagi buyurtmalar:
 *   - `GET /orders?courier_hold=any|near_48|over_48|over_72` → order-service
 *     `findAll` ga `courier_hold` (rol doirasi o'zgarmaydi); noto'g'ri qiymat
 *     — 400; registrator / market operatori / logist / operator — 403;
 *   - `GET /orders/courier-hold/summary` — doira tokendan: SA/admin hammasi
 *     (filtrlar bilan), menejer — o'z filiali, kuryer — o'zi, market — o'zi
 *     (kuryer telefoni yashirin); boshqa rol — 403, order-service'ga so'rov yo'q.
 */
type Resolver = (
  filters: Record<string, unknown>,
  user: unknown,
) => Promise<{ kind: string; query?: Record<string, unknown> }>;

const SUMMARY = {
  couriers: [
    {
      courier_id: '26',
      total: 3,
      under_36: 1,
      near_48: 1,
      over_48: 0,
      over_72: 1,
      oldest_since: '2026-11-23T08:00:00.000Z',
      oldest_hours: 98,
      cancelled_held: 0,
    },
  ],
  totals: { couriers: 1, total: 3 },
  now: '2026-11-27T10:00:00.000Z',
  thresholds: { near_from: 36, deadline: 48, over: 72 },
};

function makeController() {
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'order.courier_hold.summary'
          ? { statusCode: 200, data: SUMMARY }
          : { data: [], total: 0 },
      ),
    ),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'identity.courier.find_by_ids'
          ? {
              data: [{ id: '26', name: 'Aziz', phone_number: '+998901112233' }],
            }
          : { data: null },
      ),
    ),
  };
  const controller = new OrderGatewayController(
    orderClient as never,
    identityClient as never,
    { send: jest.fn(() => of({ data: [] })) } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
  );
  const internals = controller as unknown as {
    resolveOrderListRequest: Resolver;
    resolveBranchAssignment: jest.Mock;
    isHqRegistrator: jest.Mock;
    logistRegionIds: jest.Mock;
    resolveMarketOperatorMarketId: jest.Mock;
  };
  internals.resolveBranchAssignment = jest
    .fn()
    .mockResolvedValue({ branch_id: '13', role: 'MANAGER' });
  internals.isHqRegistrator = jest.fn().mockResolvedValue(false);
  internals.logistRegionIds = jest.fn().mockResolvedValue(['5']);
  internals.resolveMarketOperatorMarketId = jest.fn().mockResolvedValue('37');
  const resolve: Resolver = internals.resolveOrderListRequest.bind(controller);
  const summary = (user: unknown, q: Record<string, string> = {}) =>
    controller.courierHoldSummary(
      { user } as never,
      q.market_id,
      q.branch_id,
      q.region_id,
      q.courier_id,
    );
  const summaryCalls = () =>
    (orderClient.send.mock.calls as unknown[][]).filter(
      (call) =>
        (call[0] as { cmd?: string })?.cmd === 'order.courier_hold.summary',
    );
  return { controller, orderClient, resolve, summary, summaryCalls, internals };
}

const superadmin = { sub: '1', roles: ['superadmin'] };
const admin = { sub: '2', roles: ['admin'] };
const market = { sub: '37', roles: ['market'] };
const manager = { sub: '25', roles: ['manager'] };
const courier = { sub: '26', roles: ['courier'] };
const registrator = { sub: '30', roles: ['registrator'] };
const marketOperator = { sub: '31', roles: ['market_operator'] };
const logist = { sub: '32', roles: ['logist'] };
const operator = { sub: '33', roles: ['operator'] };

describe('onXzDc5n — GET /orders courier_hold filtri', () => {
  it('⭐ qiymatlar → query.courier_hold (kichik harf); berilmasa — kalit yo`q', async () => {
    const { resolve } = makeController();
    for (const value of ['any', 'near_48', 'over_48', 'over_72']) {
      await expect(
        resolve({ courier_hold: value.toUpperCase() }, admin),
      ).resolves.toMatchObject({
        kind: 'query',
        query: { courier_hold: value },
      });
    }
    const none = await resolve({}, admin);
    expect(none.query).not.toHaveProperty('courier_hold');
    const empty = await resolve({ courier_hold: '' }, admin);
    expect(empty.query).not.toHaveProperty('courier_hold');
  });

  it('⭐ noto`g`ri qiymat — 400 (order-service`ga yetmaydi)', async () => {
    const { resolve } = makeController();
    await expect(resolve({ courier_hold: '72' }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(resolve({ courier_hold: 'over_96' }, admin)).rejects.toThrow(
      /courier_hold noto'g'ri/,
    );
  });

  it('⭐ rol doirasi saqlanadi: market — o`z id, menejer — o`z filiali, kuryer — o`zi', async () => {
    const { resolve } = makeController();
    await expect(
      resolve({ courier_hold: 'over_72' }, market),
    ).resolves.toMatchObject({
      query: { courier_hold: 'over_72', market_id: '37' },
    });
    await expect(
      resolve({ courier_hold: 'over_72' }, manager),
    ).resolves.toMatchObject({
      query: { courier_hold: 'over_72', branch_id: '13' },
    });
    await expect(
      resolve({ courier_hold: 'near_48' }, courier),
    ).resolves.toMatchObject({
      query: { courier_hold: 'near_48', courier_ids: ['26'] },
    });
    await expect(
      resolve({ courier_hold: 'any' }, superadmin),
    ).resolves.toMatchObject({ query: { courier_hold: 'any' } });
  });

  it('⭐ registrator, market operatori, logist, operator — 403; filtrsiz so`rov ular uchun o`zgarmaydi', async () => {
    const { resolve } = makeController();
    for (const user of [registrator, marketOperator, logist, operator]) {
      await expect(
        resolve({ courier_hold: 'over_72' }, user),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(resolve({}, registrator)).resolves.toMatchObject({
      kind: 'query',
    });
    await expect(resolve({}, marketOperator)).resolves.toMatchObject({
      kind: 'query',
    });
  });

  it('handler → find_all_enriched: courier_hold so`rovda (oxirgi parametr)', async () => {
    const { controller, orderClient } = makeController();
    // findAll: 25 ta pozitsion parametr, `courier_hold` — oxirgi.
    const args: unknown[] = Array.from({ length: 25 }, () => undefined);
    args[15] = { user: admin };
    args.push('over_72');
    await controller.findAll.call(controller, ...args);
    const sent = (orderClient.send.mock.calls as unknown[][]).find(
      (call) =>
        (call[0] as { cmd?: string })?.cmd === 'order.find_all_enriched',
    );
    expect(
      (sent?.[1] as { query: Record<string, unknown> }).query,
    ).toMatchObject({ courier_hold: 'over_72' });
  });
});

describe('onXzDc5n — GET /orders/courier-hold/summary', () => {
  it('⭐ @Roles: superadmin, admin, manager, courier, market', () => {
    const handler = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'courierHoldSummary',
    )?.value as object;
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect([...roles].sort()).toEqual(
      ['admin', 'courier', 'manager', 'market', 'superadmin'].sort(),
    );
  });

  it('⭐ ruxsatsiz rol — 403, order-service`ga so`rov yo`q', async () => {
    const { summary, summaryCalls } = makeController();
    for (const user of [registrator, marketOperator, logist, operator]) {
      await expect(summary(user)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(summaryCalls()).toHaveLength(0);
  });

  it('⭐ SA/admin — filtrlar o`tadi (courier_id → courier_ids); kuryer ismi va telefoni', async () => {
    const { summary, summaryCalls } = makeController();
    const result = (await summary(admin, {
      market_id: '37',
      branch_id: '13',
      region_id: '5',
      courier_id: '26',
    })) as { data: { couriers: Array<Record<string, unknown>> } };
    expect(summaryCalls()[0][1]).toEqual({
      query: {
        market_id: '37',
        branch_id: '13',
        region_id: '5',
        courier_ids: ['26'],
      },
    });
    expect(result.data.couriers[0]).toMatchObject({
      courier_id: '26',
      over_72: 1,
      courier: { id: '26', name: 'Aziz', phone_number: '+998901112233' },
    });
  });

  it('⭐ menejer — faqat o`z filiali (so`ralgan branch_id e`tiborsiz)', async () => {
    const { summary, summaryCalls } = makeController();
    await summary(manager, { branch_id: '99', courier_id: '26' });
    expect(summaryCalls()[0][1]).toEqual({
      query: { branch_id: '13', courier_ids: ['26'] },
    });
  });

  it('menejer filialga biriktirilmagan — 400', async () => {
    const { summary, internals } = makeController();
    internals.resolveBranchAssignment.mockResolvedValueOnce(null);
    await expect(summary(manager)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⭐ kuryer — faqat o`zi (so`ralgan courier_id e`tiborsiz)', async () => {
    const { summary, summaryCalls } = makeController();
    await summary(courier, { courier_id: '99', market_id: '37' });
    expect(summaryCalls()[0][1]).toEqual({ query: { courier_ids: ['26'] } });
  });

  it('⭐ market — o`zi; boshqa market_id — 400; kuryer telefoni yashirin', async () => {
    const { summary, summaryCalls } = makeController();
    const result = (await summary(market)) as {
      data: { couriers: Array<Record<string, unknown>> };
    };
    expect(summaryCalls()[0][1]).toEqual({ query: { market_id: '37' } });
    expect(result.data.couriers[0]).toMatchObject({
      courier: { id: '26', name: 'Aziz', phone_number: null },
    });
    await expect(summary(market, { market_id: '38' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('noto`g`ri id — 400', async () => {
    const { summary } = makeController();
    await expect(summary(admin, { courier_id: 'abc' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('identity javob bermasa — jamlama ismsiz qaytadi (yiqilmaydi)', async () => {
    const { controller, summary } = makeController();
    (
      controller as unknown as { identityClient: { send: jest.Mock } }
    ).identityClient.send.mockImplementation(() => {
      throw new Error('identity down');
    });
    const result = (await summary(admin)) as {
      data: { couriers: Array<Record<string, unknown>> };
    };
    expect(result.data.couriers[0]).toMatchObject({
      courier: { id: '26', name: null, phone_number: null },
    });
  });
});
