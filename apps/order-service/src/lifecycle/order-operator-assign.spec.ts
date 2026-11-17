import { RpcException } from '@nestjs/microservices';
import { ORDER_OPERATOR_EARNING_STATUSES, Order_status } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 2026-11-16 (Dilshod): «operator tanlanmasa shu buyurtmaga operator biriktirib
 * qo'yish imkoni bo'lishi kerak» — `order.operator.assign` (order-service qatlami):
 *  • operatori yo'q buyurtmaga — `operator_id` + ism, tracking, jurnal, holat o'zgarmaydi;
 *  • sotilgan (sold / paid / partly_paid) — operator ulushi outbox'ga (sotuvdagi komanda);
 *  • operator bor — 409 ORDER_OPERATOR_ALREADY_ASSIGNED; integratsiya — 409 ORDER_OPERATOR_EXTERNAL;
 *  • tekshirilgan market ≠ buyurtma marketi — 409 ORDER_OPERATOR_MARKET_CHANGED;
 *  • market — faqat o'z buyurtmasi (403); doirasiz so'rovchi — 403; yo'q — 404.
 */

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string; code?: string };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

const ADMIN = { id: '2', roles: ['admin'] };
const REGISTRATOR = { id: '30', roles: ['registrator'] };
const MARKET = { id: '501', roles: ['market'], market_id: '501' };
const OTHER_MARKET = { id: '502', roles: ['market'], market_id: '502' };
const COURIER = { id: '40', roles: ['courier'] };

function makeHarness(order: Row | null) {
  const findOne = jest.fn().mockResolvedValue(order);
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const trackingRepo = { marker: 'tracking' };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === Order
        ? { findOne, update }
        : entity === OrderTracking
          ? trackingRepo
          : {},
    ),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  const custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'admin'),
    auditActor: jest.fn((r: { id?: string }) => ({ user_id: r?.id ?? null })),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  Object.assign(s, {
    dataSource: {
      transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    },
    custody,
    activityLog,
    outbox,
  });
  return {
    s,
    findOne,
    update,
    custody,
    activityLog,
    outbox,
    manager,
    trackingRepo,
  };
}

const orderRow = (status: Order_status, extra: Row = {}): Row => ({
  id: '120',
  market_id: '501',
  status,
  operator_id: null,
  operator: null,
  total_price: 250000,
  ...extra,
});

const input = (extra: Row = {}) => ({
  operator_id: '412',
  operator_name: 'Aziza Karimova',
  market_id: '501',
  ...extra,
});

describe('2026-11-16 assignOperator — biriktirish', () => {
  it('⭐ yangi buyurtma: operator_id + ism, tracking, jurnal; ulush YO`Q, holat o`zgarmaydi', async () => {
    const h = makeHarness(
      orderRow(Order_status.NEW, { operator: 'Yozilgan Ism' }),
    );

    const res = await h.s.assignOperator('120', input(), ADMIN);

    expect(res).toEqual({
      statusCode: 200,
      message: 'success',
      data: {
        id: '120',
        operator_id: '412',
        operator: 'Aziza Karimova',
        earning_recorded: false,
      },
    });
    expect(h.findOne).toHaveBeenCalledWith({
      where: { id: '120', isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    expect(h.update).toHaveBeenCalledWith(
      { id: '120' },
      { operator_id: '412', operator: 'Aziza Karimova' },
    );
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '120',
        from_status: Order_status.NEW,
        to_status: Order_status.NEW,
        action: 'operator_assigned',
        old_value: { operator_id: null, operator: 'Yozilgan Ism' },
        new_value: { operator_id: '412', operator: 'Aziza Karimova' },
        changed_by: '2',
        note: 'Operator biriktirildi: Aziza Karimova',
      }),
      h.trackingRepo,
    );
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '120',
        action: 'order.operator_assigned',
        metadata: { status: Order_status.NEW, earning_recorded: false },
      }),
    );
    expect(h.outbox.enqueue).not.toHaveBeenCalled();
  });

  it.each(ORDER_OPERATOR_EARNING_STATUSES.map((status) => [status]))(
    '⭐ sotilgan (%s): operator ulushi outbox`ga — sotuvdagi komanda va payload, shu tranzaksiyada',
    async (status) => {
      const h = makeHarness(orderRow(status));

      const res = await h.s.assignOperator('120', input(), MARKET);

      expect(res.data.earning_recorded).toBe(true);
      expect(h.outbox.enqueue).toHaveBeenCalledWith(
        'FINANCE',
        'finance.operator.earning.record',
        {
          order_id: '120',
          operator_id: '412',
          market_id: '501',
          total_price: 250000,
        },
        { manager: h.manager },
      );
    },
  );

  it.each([
    Order_status.CREATED,
    Order_status.RECEIVED,
    Order_status.ON_THE_ROAD,
    Order_status.WAITING,
    Order_status.CANCELLED,
    Order_status.CANCELLED_SENT,
    Order_status.CLOSED,
    Order_status.RETURNED_TO_MARKET,
  ])('sotilmagan (%s): biriktiriladi, ulush yozilmaydi', async (status) => {
    const h = makeHarness(orderRow(status));
    const res = await h.s.assignOperator('120', input(), REGISTRATOR);
    expect(res.data.earning_recorded).toBe(false);
    expect(h.update).toHaveBeenCalled();
    expect(h.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('ism kelmasa — yozilgan matn qoladi (operator ustuniga tegilmaydi)', async () => {
    const h = makeHarness(
      orderRow(Order_status.NEW, { operator: 'Eski Matn' }),
    );
    const res = await h.s.assignOperator(
      '120',
      input({ operator_name: '  ' }),
      ADMIN,
    );
    expect(h.update).toHaveBeenCalledWith(
      { id: '120' },
      { operator_id: '412' },
    );
    expect(res.data.operator).toBe('Eski Matn');
  });
});

describe('2026-11-16 assignOperator — rad etish (hech narsa yozilmaydi)', () => {
  const expectNothingWritten = (h: ReturnType<typeof makeHarness>) => {
    expect(h.update).not.toHaveBeenCalled();
    expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
    expect(h.outbox.enqueue).not.toHaveBeenCalled();
  };

  it('⭐ operator bor — 409 ORDER_OPERATOR_ALREADY_ASSIGNED (almashtirish yo`q)', async () => {
    const h = makeHarness(
      orderRow(Order_status.SOLD, {
        operator_id: '300',
        operator: 'Bor Operator',
      }),
    );
    await expect(
      rpcError(h.s.assignOperator('120', input(), ADMIN)),
    ).resolves.toEqual({
      statusCode: 409,
      code: 'ORDER_OPERATOR_ALREADY_ASSIGNED',
      message: 'Bu buyurtmaga operator allaqachon biriktirilgan',
    });
    expectNothingWritten(h);
  });

  it('integratsiya buyurtmasi (`external_…`) — 409 ORDER_OPERATOR_EXTERNAL', async () => {
    const h = makeHarness(
      orderRow(Order_status.NEW, {
        operator: 'external_uzum',
        external_id: 'X-1',
      }),
    );
    await expect(
      rpcError(h.s.assignOperator('120', input(), ADMIN)),
    ).resolves.toEqual({
      statusCode: 409,
      code: 'ORDER_OPERATOR_EXTERNAL',
      message: "Integratsiya buyurtmasiga operator biriktirib bo'lmaydi",
    });
    expectNothingWritten(h);
  });

  it('tekshirilgan market ≠ buyurtma marketi — 409 ORDER_OPERATOR_MARKET_CHANGED', async () => {
    const h = makeHarness(orderRow(Order_status.NEW, { market_id: '777' }));
    await expect(
      rpcError(h.s.assignOperator('120', input(), ADMIN)),
    ).resolves.toMatchObject({
      statusCode: 409,
      code: 'ORDER_OPERATOR_MARKET_CHANGED',
    });
    expectNothingWritten(h);
  });

  it('market — begona buyurtma: 403', async () => {
    const h = makeHarness(orderRow(Order_status.NEW));
    await expect(
      rpcError(h.s.assignOperator('120', input(), OTHER_MARKET)),
    ).resolves.toMatchObject({
      statusCode: 403,
    });
    expectNothingWritten(h);
  });

  it('doirasiz so`rovchi (kuryer) — 403, buyurtma o`qilmaydi', async () => {
    const h = makeHarness(orderRow(Order_status.NEW));
    await expect(
      rpcError(h.s.assignOperator('120', input(), COURIER)),
    ).resolves.toMatchObject({
      statusCode: 403,
    });
    expect(h.findOne).not.toHaveBeenCalled();
    expectNothingWritten(h);
  });

  it('buyurtma yo`q — 404', async () => {
    const h = makeHarness(null);
    await expect(
      rpcError(h.s.assignOperator('120', input(), ADMIN)),
    ).resolves.toMatchObject({
      statusCode: 404,
    });
    expectNothingWritten(h);
  });

  it.each([
    [{ operator_id: '' }],
    [{ operator_id: 'abc' }],
    [{ market_id: '' }],
  ])('noto`g`ri kirish %p — 400', async (extra) => {
    const h = makeHarness(orderRow(Order_status.NEW));
    await expect(
      rpcError(h.s.assignOperator('120', input(extra), ADMIN)),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
