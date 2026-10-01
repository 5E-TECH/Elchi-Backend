import { ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * fix3b (lead) — GET /orders/:id va GET /orders/:id/tracking ko'rish
 * tekshiruvlari O'RAMSIZ buyurtma qatori bilan ishlaydi.
 *
 * order-service `find_by_id(_enriched)` qatorni o'ramsiz qaytaradi. Ilgari
 * gateway tekshiruvga `response.data` ni berardi — prod'da u doim
 * `undefined` bo'lib, tekshiruv darhol qaytardi: istalgan kuryer, market yoki
 * filial xodimi istalgan buyurtmani (mijoz ma'lumoti bilan) id bo'yicha
 * o'qiy olardi. Eski `{ statusCode, data }` o'rami ham qo'llab-quvvatlanadi.
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

const TRACKING = { statusCode: 200, data: { items: [], total: 0 } };

function setup(orderRow: unknown) {
  const order = makeClient({
    'order.find_by_id_enriched': orderRow,
    'order.tracking': TRACKING,
  });
  const identity = makeClient();
  const logistics = makeClient();
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: '1' } },
  });
  const controller = new OrderGatewayController(
    order as any,
    identity as any,
    logistics as any,
    branch as any,
  );
  return { controller, order, branch };
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

/** order-service `findByIdEnriched` javobi — O'RAMSIZ buyurtma qatori. */
const rawOrder = (overrides: Record<string, unknown> = {}) => ({
  id: '10',
  market_id: '201',
  courier_id: '300',
  holder_type: 'COURIER',
  holder_courier_id: '300',
  branch_id: '21',
  holder_branch_id: '21',
  home_branch_id: '21',
  status: 'on the road',
  customer: { phone_number: '+998900000000' },
  ...overrides,
});

describe("fix3b lead — GET /orders/:id o'ramsiz qator bilan tekshiriladi", () => {
  it('begona kuryer — 403', async () => {
    const { controller } = setup(rawOrder());

    await expect(
      controller.findById('10', user('999', ['courier'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("o'z kuryeri — buyurtma qaytadi", async () => {
    const row = rawOrder();
    const { controller } = setup(row);

    await expect(
      controller.findById('10', user('300', ['courier'])),
    ).resolves.toBe(row);
  });

  it("begona market — 403, o'z marketi — buyurtma qaytadi", async () => {
    const row = rawOrder();

    await expect(
      setup(row).controller.findById('10', user('202', ['market'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup(row).controller.findById('10', user('201', ['market'])),
    ).resolves.toBe(row);
  });

  it("boshqa filial menejeri — 403, o'z filiali menejeri — buyurtma qaytadi", async () => {
    const row = rawOrder();

    await expect(
      setup(row).controller.findById('10', user('5', ['manager'], '22')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup(row).controller.findById('10', user('5', ['manager'], '21')),
    ).resolves.toBe(row);
  });

  it("HQ registratori HQ qo'lidagi buyurtmani ko'radi (holder_branch_id NULL)", async () => {
    const row = rawOrder({
      holder_type: 'HQ',
      holder_courier_id: null,
      courier_id: null,
      holder_branch_id: null,
      status: 'cancelled',
    });

    await expect(
      setup(row).controller.findById('10', user('7', ['registrator'], '1')),
    ).resolves.toBe(row);
  });

  it('superadmin — filial so`rovisiz buyurtma qaytadi', async () => {
    const row = rawOrder();
    const { controller, branch } = setup(row);

    await expect(
      controller.findById('10', user('1', ['superadmin'])),
    ).resolves.toBe(row);
    expect(branch.send).not.toHaveBeenCalled();
  });

  it("eski { statusCode, data } o'rami ham tekshiriladi", async () => {
    const wrapped = { statusCode: 200, data: rawOrder() };

    await expect(
      setup(wrapped).controller.findById('10', user('999', ['courier'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      setup(wrapped).controller.findById('10', user('300', ['courier'])),
    ).resolves.toBe(wrapped);
  });
});

describe("fix3b lead — GET /orders/:id/tracking o'ramsiz qator bilan tekshiriladi", () => {
  it('begona kuryer — 403, tracking so`ralmaydi', async () => {
    const { controller, order } = setup(rawOrder());

    await expect(
      controller.getTracking(
        '10',
        undefined,
        undefined,
        user('999', ['courier']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const cmds = (order.send.mock.calls as unknown[][]).map(
      (args) => (args[0] as { cmd: string }).cmd,
    );
    expect(cmds).not.toContain('order.tracking');
  });

  it('buyurtmani ushlab turgan kuryer — tracking qaytadi', async () => {
    const { controller } = setup(rawOrder());

    await expect(
      controller.getTracking(
        '10',
        undefined,
        undefined,
        user('300', ['courier']),
      ),
    ).resolves.toEqual(TRACKING);
  });

  it('boshqa filial menejeri — 403', async () => {
    const { controller } = setup(rawOrder());

    await expect(
      controller.getTracking(
        '10',
        undefined,
        undefined,
        user('5', ['manager'], '22'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
