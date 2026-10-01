/**
 * fix3b — buyurtma tahriri RPC naqshlari (M11 / CODE-03) va SOLD →
 * PARTLY_PAID (finance qisman market to'lovi).
 *
 * L2 `updateFromApi` (taqiqlangan maydon / rol / filial doirasi) qoidalari
 * FAQAT HTTP PATCH yo'liga tegishli. Ichki oqimlar (filial dispatch,
 * logistika, finance `writeOrderPayment`) o'sha naqshlar orqali status va
 * custody maydonlarini QONUNIY yozadi — qoidalar ularga qo'yilsa butun
 * jo'natish/to'lov zanjiri 400/403 bilan to'xtardi.
 *
 *   • `order.update_from_api` (yangi) → `updateFromApi` — qoidalar ishlaydi;
 *   • `order.update` / `order.update_full` / `order.update_normalized` →
 *     to'g'ridan-to'g'ri `updateFull` (avvalgidek).
 *
 * "Muvaffaqiyatli" testlar HAQIQIY `updateFull` dan o'tadi (status mashinasi,
 * holder qayta hisobi, tracking) — faqat DB va RMQ chegaralari mock.
 */
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { Order_status, RmqService } from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderCustodyService } from './custody/order-custody.service';
import { OrderHolderType } from './entities/order.entity';
import { isValidStatusTransition } from './domain/order-status.machine';

type Row = Record<string, unknown>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
const REGISTRATOR = { id: '301', roles: ['registrator'], note: 'dispatch' };
const COURIER = { id: '289', roles: ['courier'] };
const ADMIN = { id: '2', roles: ['admin'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

const ctx = { getPattern: () => 'test' } as unknown as RmqContext;

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

const baseOrder = (over: Row = {}): Row => ({
  id: '700',
  status: Order_status.RECEIVED,
  market_id: '501',
  customer_id: '801',
  where_deliver: 'center',
  total_price: 150000,
  to_be_paid: 0,
  paid_amount: 0,
  return_requested: false,
  comment: null,
  operator: null,
  post_id: '9001',
  canceled_post_id: null,
  sold_at: null,
  branch_id: HQ_ID,
  home_branch_id: HQ_ID,
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  holder_courier_id: null,
  courier_id: null,
  district_id: '12',
  region_id: '5',
  address: null,
  qr_code_token: 'qr-700',
  external_id: null,
  source: 'internal',
  isDeleted: false,
  ...over,
});

/**
 * HAQIQIY `OrderLifecycleService` + HAQIQIY controller. `findById` joriy
 * (oxirgi saqlangan) holatni qaytaradi — ya'ni `updateFull` ning yakuniy
 * o'qishi ham haqiqiy natijani ko'radi.
 */
function makeWorld(initial: Row) {
  let current: Row = { ...initial };
  const saves: Row[] = [];
  const orderRepo = {
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      current = { ...value };
      return Promise.resolve(value);
    }),
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };
  const trackingRepo = {
    create: jest.fn((payload: Row) => payload),
    save: jest.fn((payload: Row) => Promise.resolve(payload)),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const custodyRepo = {
    create: jest.fn((payload: Row) => payload),
    save: jest.fn((payload: Row) => Promise.resolve(payload)),
    find: jest.fn().mockResolvedValue([]),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) =>
        entity.name === 'Order'
          ? orderRepo
          : entity.name === 'OrderCustodyEvent'
            ? custodyRepo
            : trackingRepo,
      ),
    },
  };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const nullClient = { send: jest.fn() };
  const lookup = {
    getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
    getBranchAssignmentByUser: jest
      .fn()
      .mockResolvedValue({ branch_id: HQ_ID }),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const custody = new OrderCustodyService(
    trackingRepo as never,
    custodyRepo as never,
  );
  const lifecycle = new OrderLifecycleService(
    dataSource as never,
    orderRepo as never,
    {} as never, // orderItemRepo
    trackingRepo as never,
    custodyRepo as never,
    {} as never, // orderSettlementRepo
    {} as never, // extraCostApprovalRepo
    { find: jest.fn().mockResolvedValue([]) } as never, // transferBatchItemRepo
    nullClient as never, // identity
    nullClient as never, // logistics
    nullClient as never, // finance
    nullClient as never, // integration
    nullClient as never, // branch
    nullClient as never, // file
    outbox as never,
    activityLog as never,
    lookup as never,
    custody,
  );
  jest
    .spyOn(lifecycle, 'findById')
    .mockImplementation(() =>
      Promise.resolve({ ...current, items: [] } as never),
    );
  jest
    .spyOn(
      lifecycle as unknown as { syncOrderToSearch: () => Promise<void> },
      'syncOrderToSearch',
    )
    .mockResolvedValue(undefined);
  const updateFullSpy = jest.spyOn(lifecycle, 'updateFull');
  const updateFromApiSpy = jest.spyOn(lifecycle, 'updateFromApi');

  // `normalizeUpdatePayload` — sof funksiya; og'ir konstruktorsiz.
  const orderService = Object.create(
    OrderServiceService.prototype,
  ) as OrderServiceService;
  const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
  const controller = new OrderServiceController(
    rmqService as unknown as RmqService,
    orderService,
    {} as never,
    {} as never,
    {} as never,
    lifecycle,
    {} as never,
    {} as never,
  );

  return {
    controller,
    lifecycle,
    saves,
    outbox,
    trackingRepo,
    lookup,
    updateFullSpy,
    updateFromApiSpy,
    current: () => current,
  };
}

describe('fix3b — order.update_from_api naqshi', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'updateFromApi',
  )?.value as (...args: unknown[]) => unknown;

  it("naqsh AYNAN { cmd: 'order.update_from_api' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.update_from_api' },
    ]);
  });

  it('eski naqshlar o`z joyida (ichki chaqiruvchilar uchun)', () => {
    const patternOf = (method: string) =>
      Reflect.getMetadata(
        PATTERN_METADATA,
        Object.getOwnPropertyDescriptor(
          OrderServiceController.prototype,
          method,
        )?.value as object,
      ) as unknown;
    expect(patternOf('update')).toEqual([{ cmd: 'order.update' }]);
    expect(patternOf('updateFull')).toEqual([{ cmd: 'order.update_full' }]);
    expect(patternOf('updateNormalized')).toEqual([
      { cmd: 'order.update_normalized' },
    ]);
  });
});

describe('fix3b — ichki naqshlar qoidalarsiz updateFull ga boradi', () => {
  it("⭐ order.update {status:'on the road', post_id, branch_id} REGISTRATOR bilan (filial dispatch) — muvaffaqiyatli", async () => {
    const w = makeWorld(baseOrder());
    // branch-service dispatchPostToBranch yuboradigan AYNI payload.
    const dto = {
      branch_id: '22',
      holder_type: 'BRANCH',
      holder_branch_id: '22',
      holder_courier_id: null,
      post_id: '9100',
      current_batch_id: null,
      status: Order_status.ON_THE_ROAD,
    };

    const result = (await w.controller.update(
      { id: '700', dto: dto as never, requester: REGISTRATOR },
      ctx,
    )) as Row;

    expect(w.updateFromApiSpy).not.toHaveBeenCalled();
    expect(w.updateFullSpy).toHaveBeenCalledWith('700', dto, REGISTRATOR);
    expect(result).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      post_id: '9100',
      branch_id: '22',
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '22',
    });
    expect(w.saves).toHaveLength(1);
    // Tracking yozildi (RECEIVED → ON_THE_ROAD).
    expect(w.trackingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '700',
        from_status: Order_status.RECEIVED,
        to_status: Order_status.ON_THE_ROAD,
        changed_by: '301',
      }),
    );
  });

  it('order.update — logistika (kuryer so`rovchisi) courier_id/status yozadi, 403/400 yo`q', async () => {
    const w = makeWorld(baseOrder());

    const result = (await w.controller.update(
      {
        id: '700',
        dto: {
          courier_id: '289',
          assigned_at: '2026-10-01T09:00:00.000Z',
          status: Order_status.ON_THE_ROAD,
          post_id: '9200',
        },
        requester: COURIER,
      },
      ctx,
    )) as Row;

    expect(w.updateFromApiSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      courier_id: '289',
      holder_type: OrderHolderType.COURIER,
      holder_courier_id: '289',
    });
  });

  it('order.update_full ham to`g`ridan-to`g`ri updateFull (registrator status yozadi)', async () => {
    const w = makeWorld(baseOrder());

    await w.controller.updateFull(
      {
        id: '700',
        dto: { status: Order_status.ON_THE_ROAD, post_id: '9100' },
        requester: REGISTRATOR,
      },
      ctx,
    );

    expect(w.updateFromApiSpy).not.toHaveBeenCalled();
    expect(w.current()).toMatchObject({ status: Order_status.ON_THE_ROAD });
  });

  it("⭐ so'rovchisiz order.update_normalized {status:'paid', paid_amount} (finance) — muvaffaqiyatli", async () => {
    const w = makeWorld(
      baseOrder({
        status: Order_status.SOLD,
        to_be_paid: 120000,
        sold_at: '1759300000000',
      }),
    );

    const result = (await w.controller.updateNormalized(
      { id: '700', dto: { status: 'PAID', paid_amount: 120000 } },
      ctx,
    )) as Row;

    expect(w.updateFromApiSpy).not.toHaveBeenCalled();
    // `normalizeUpdatePayload` statusni kichik harfga o'tkazadi.
    expect(w.updateFullSpy).toHaveBeenCalledWith(
      '700',
      { status: Order_status.PAID, paid_amount: 120000 },
      undefined,
    );
    expect(result).toMatchObject({
      status: Order_status.PAID,
      paid_amount: 120000,
    });
  });

  it("⭐ SOLD → PARTLY_PAID (finance qisman market to'lovi) endi o'tadi — status ham, paid_amount ham yoziladi", async () => {
    const w = makeWorld(
      baseOrder({
        status: Order_status.SOLD,
        to_be_paid: 120000,
        sold_at: '1759300000000',
      }),
    );

    const result = (await w.controller.updateNormalized(
      {
        id: '700',
        dto: { status: Order_status.PARTLY_PAID, paid_amount: 50000 },
      },
      ctx,
    )) as Row;

    expect(result).toMatchObject({
      status: Order_status.PARTLY_PAID,
      paid_amount: 50000,
    });
    // SOLD va PARTLY_PAID ikkalasi "sotilgan" holat — foyda ikkinchi marta
    // yozilmaydi (enteredSold = false).
    expect(w.outbox.enqueue).not.toHaveBeenCalledWith(
      'FINANCE',
      'finance.financial_balance.record',
      expect.objectContaining({ source_type: 'sell_profit' }),
      expect.anything(),
    );
  });
});

describe('fix3b — order.update_from_api qoidalarni qo`llaydi', () => {
  it.each([
    ['status', { status: Order_status.SOLD }],
    ['market_id', { market_id: '502' }],
    ['paid_amount', { paid_amount: 150000 }],
    ['branch_id', { branch_id: '22' }],
    ['courier_id', { courier_id: '289' }],
  ])(
    '⭐ %s — superadmin uchun ham 400, updateFull chaqirilmaydi',
    async (field, dto) => {
      const w = makeWorld(baseOrder());

      const error = await rpcError(
        w.controller.updateFromApi(
          { id: '700', dto, requester: SUPERADMIN },
          ctx,
        ) as Promise<unknown>,
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain(field);
      expect(w.updateFullSpy).not.toHaveBeenCalled();
      expect(w.saves).toHaveLength(0);
    },
  );

  it('`status` katta harf bilan kelsa ham (normallashtirilib) 400', async () => {
    const w = makeWorld(baseOrder());

    const error = await rpcError(
      w.controller.updateFromApi(
        { id: '700', dto: { status: 'SOLD' }, requester: SUPERADMIN },
        ctx,
      ) as Promise<unknown>,
    );

    expect(error.statusCode).toBe(400);
    expect(w.updateFullSpy).not.toHaveBeenCalled();
  });

  it('post_id — admin uchun 403', async () => {
    const w = makeWorld(baseOrder());

    const error = await rpcError(
      w.controller.updateFromApi(
        { id: '700', dto: { post_id: '9100' }, requester: ADMIN },
        ctx,
      ) as Promise<unknown>,
    );

    expect(error.statusCode).toBe(403);
    expect(w.updateFullSpy).not.toHaveBeenCalled();
  });

  it('⭐ registrator boshqa filial buyurtmasini tahrirlay olmaydi — 403', async () => {
    const w = makeWorld(baseOrder());
    w.lookup.getBranchAssignmentByUser.mockResolvedValue({ branch_id: '22' });

    const error = await rpcError(
      w.controller.updateFromApi(
        { id: '700', dto: { address: 'yangi' }, requester: REGISTRATOR },
        ctx,
      ) as Promise<unknown>,
    );

    expect(error.statusCode).toBe(403);
    expect(w.updateFullSpy).not.toHaveBeenCalled();
  });

  it('kuryer — 403 (PATCH faqat SA/ADMIN/REGISTRATOR)', async () => {
    const w = makeWorld(baseOrder());

    const error = await rpcError(
      w.controller.updateFromApi(
        { id: '700', dto: { comment: 'x' }, requester: COURIER },
        ctx,
      ) as Promise<unknown>,
    );

    expect(error.statusCode).toBe(403);
  });

  it("⭐ so'rovchisiz chaqiruv qoidalarni chetlab o'tolmaydi — 403 (fail-closed)", async () => {
    const w = makeWorld(baseOrder());

    const error = await rpcError(
      w.controller.updateFromApi(
        { id: '700', dto: { status: Order_status.SOLD } },
        ctx,
      ) as Promise<unknown>,
    );

    expect(error.statusCode).toBe(403);
    expect(w.updateFullSpy).not.toHaveBeenCalled();
  });

  it('ruxsat etilgan tahrir: HQ registratori o`z buyurtmasi manzilini o`zgartiradi', async () => {
    const w = makeWorld(baseOrder());

    const result = (await w.controller.updateFromApi(
      { id: '700', dto: { address: 'Chilonzor 5' }, requester: REGISTRATOR },
      ctx,
    )) as Row;

    expect(w.updateFullSpy).toHaveBeenCalledWith(
      '700',
      { address: 'Chilonzor 5' },
      REGISTRATOR,
    );
    expect(result).toMatchObject({ address: 'Chilonzor 5' });
  });
});

describe('fix3b — status mashinasi: SOLD → PARTLY_PAID', () => {
  it('⭐ SOLD → PARTLY_PAID ruxsat etiladi (finance qisman market to`lovi)', () => {
    expect(
      isValidStatusTransition(Order_status.SOLD, Order_status.PARTLY_PAID),
    ).toBe(true);
  });

  it('qolgan SOLD o`tishlari o`zgarmadi, teskari yo`nalish ochilmadi', () => {
    expect(isValidStatusTransition(Order_status.SOLD, Order_status.PAID)).toBe(
      true,
    );
    expect(
      isValidStatusTransition(Order_status.SOLD, Order_status.WAITING),
    ).toBe(true);
    expect(
      isValidStatusTransition(Order_status.SOLD, Order_status.CANCELLED),
    ).toBe(false);
    expect(
      isValidStatusTransition(Order_status.PARTLY_PAID, Order_status.SOLD),
    ).toBe(false);
  });
});
