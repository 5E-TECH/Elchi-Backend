import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * «QABUL VA YARATISH → BEKOR QILINGANLAR → TOPSHIRILGAN» (2026-11-10) — gateway:
 *  - `GET orders/markets/cancelled/handovers` va `…/handovers/:batchId` faqat superadmin, admin va HQ
 *    registratoriga (FE `canHandoverCancelledToMarket` bilan bir xil); filial registratori — 403;
 *  - sahifa o'lchami 12 / 24 / 48 (sukut 24), boshqasi — 400; filtrlar order-service'ga o'zgarishsiz;
 *  - javobga sahifalash meta qo'shiladi.
 */
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

function setup(order: Handlers = {}) {
  const orderClient = makeClient(order);
  const identity = makeClient();
  const logistics = makeClient();
  const branch = makeClient({
    'branch.find_hq': { statusCode: 200, data: { id: HQ_BRANCH_ID } },
  });
  const controller = new OrderGatewayController(
    orderClient as any,
    identity as any,
    logistics as any,
    branch as any,
  );
  return { controller, order: orderClient, branch };
}

const calls = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
  );

const user = (sub: string, roles: string[], branchId?: string) =>
  ({
    user: {
      sub,
      username: `u${sub}`,
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as any;

const LIST_CMD = 'order.cancelled_handover_batches.find';
const ONE_CMD = 'order.cancelled_handover_batches.find_one';

describe('GET orders/markets/cancelled/handovers («Topshirilgan»)', () => {
  it('rollar: superadmin, admin, registrator (HQ tekshiruvi ichida)', () => {
    const proto = OrderGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of [
      'findCancelledHandoverBatches',
      'findCancelledHandoverBatch',
    ]) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[name] as object)).toEqual([
        'superadmin',
        'admin',
        'registrator',
      ]);
    }
  });

  it('superadmin: filtrlar va sukut sahifasi (24) order-service ga, meta qo‘shiladi', async () => {
    const { controller, order, branch } = setup({
      [LIST_CMD]: {
        data: [{ id: '121_1_520' }],
        total: 30,
        page: 2,
        limit: 24,
        totals: { batches: 30, orders: 90, amount: 1000 },
      },
    });
    const result = await controller.findCancelledHandoverBatches(
      user('1', ['superadmin']),
      '  Baraka ',
      '2026-11-01',
      '2026-11-10',
      '2',
    );
    expect(calls(order, LIST_CMD)[0][1]).toEqual({
      search: 'Baraka',
      start_day: '2026-11-01',
      end_day: '2026-11-10',
      page: 2,
      limit: 24,
    });
    expect(result).toEqual(
      expect.objectContaining({
        data: [{ id: '121_1_520' }],
        total: 30,
        totals: { batches: 30, orders: 90, amount: 1000 },
        total_pages: 2,
        has_prev: true,
        has_next: false,
      }),
    );
    // SA uchun filial tekshiruvi kerak emas.
    expect(branch.send).not.toHaveBeenCalled();
  });

  it('admin: limit 12 va 48 qabul qilinadi, boshqasi — 400', async () => {
    const { controller, order } = setup({ [LIST_CMD]: { data: [], total: 0 } });
    await controller.findCancelledHandoverBatches(
      user('2', ['admin']),
      undefined,
      undefined,
      undefined,
      undefined,
      '48',
    );
    expect(calls(order, LIST_CMD)[0][1]).toEqual({ page: 1, limit: 48 });
    await expect(
      controller.findCancelledHandoverBatches(
        user('2', ['admin']),
        undefined,
        undefined,
        undefined,
        undefined,
        '25',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('HQ registratori — ruxsat', async () => {
    const { controller, order } = setup({ [LIST_CMD]: { data: [], total: 0 } });
    await controller.findCancelledHandoverBatches(
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    expect(calls(order, LIST_CMD)).toHaveLength(1);
  });

  it('filial registratori — 403, order-service ga so‘rov ketmaydi', async () => {
    const { controller, order } = setup();
    await expect(
      controller.findCancelledHandoverBatches(
        user('301', ['registrator'], '21'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.findCancelledHandoverBatch(
        '121_1_520',
        user('301', ['registrator'], '21'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(order.send).not.toHaveBeenCalled();
  });

  it('HQ aniqlanmasa registrator rad etiladi (fail-closed)', async () => {
    const branchless = new OrderGatewayController(
      makeClient() as any,
      makeClient() as any,
      makeClient() as any,
      makeClient({ 'branch.find_hq': new Error('down') }) as any,
    );
    await expect(
      branchless.findCancelledHandoverBatches(
        user('300', ['registrator'], HQ_BRANCH_ID),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET orders/markets/cancelled/handovers/:batchId', () => {
  it('batch_id order-service ga kesilgan holda, javob qaytadi', async () => {
    const payload = {
      batch: { id: '121_1_520', orders_count: 1 },
      data: [{ id: '9', status: 'returned_to_market' }],
      total: 1,
    };
    const { controller, order } = setup({ [ONE_CMD]: payload });
    const result = await controller.findCancelledHandoverBatch(
      ' 121_1_520 ',
      user('300', ['registrator'], HQ_BRANCH_ID),
    );
    expect(calls(order, ONE_CMD)[0][1]).toEqual({ batch_id: '121_1_520' });
    expect(result).toEqual(
      expect.objectContaining({
        batch: { id: '121_1_520', orders_count: 1 },
        total: 1,
      }),
    );
  });
});
