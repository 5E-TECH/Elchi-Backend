import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  BranchTransferBatchAction,
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
} from '@app/common';
import { BranchTransferBatchService } from './branch-transfer-batch.service';
import { OrderHolderType } from '../entities/order.entity';

/**
 * Tuman ↔ filial qamrovi — return paketi faqat MANBA filial haqiqatan ushlab
 * turgan buyurtmalardan tuziladi (`createBranchReturnBatches`):
 *  - ushlovchi doirasi `holder_branch_id ?? branch_id` manba filialga teng;
 *  - HQ ushlagan (holder_branch_id yo'q) buyurtma faqat manba HQ bo'lsa
 *    (turi aniqlanmasa — zaxira: branch_id manba filialga teng);
 *  - kuryer qo'lidagi, bekor pochtasi qabul qilinmagan va tashqi manbadan
 *    kelgan NEW buyurtma — yo'q;
 *  - rad etish HECH NARSA yozilmasdan oldin (tranzaksiya ochilmaydi).
 */
const SOURCE_ID = '12';
const HOME_ID = '1';

type OrderFixture = Record<string, unknown> & { id: string };

function makeOrder(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    id: '900',
    branch_id: SOURCE_ID,
    home_branch_id: HOME_ID,
    region_id: '7',
    market_id: '55',
    total_price: 1000,
    status: Order_status.CANCELLED,
    holder_type: OrderHolderType.BRANCH,
    holder_branch_id: SOURCE_ID,
    courier_id: null,
    holder_courier_id: null,
    source: 'internal',
    canceled_post_id: null,
    ...overrides,
  };
}

function makeHarness(
  orders: OrderFixture[],
  opts: { sourceBranchType?: string | null; branchQueryFails?: boolean } = {},
) {
  const orderUpdateExecute = jest.fn(() =>
    Promise.resolve({ affected: orders.length }),
  );
  const orderQb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'where', 'andWhere']) {
    orderQb[method] = jest.fn(() => orderQb);
  }
  orderQb.execute = orderUpdateExecute;

  const batchRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((value: Record<string, unknown>) => value),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({ ...value, id: '500' }),
    ),
  };
  const itemRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const historyRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: { name: string }) => {
        if (entity.name === 'BranchTransferBatch') return batchRepo;
        if (entity.name === 'BranchTransferBatchItem') return itemRepo;
        if (entity.name === 'BranchTransferBatchHistory') return historyRepo;
        if (entity.name === 'Order') {
          return { createQueryBuilder: jest.fn(() => orderQb) };
        }
        return {};
      }),
    },
  };
  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    query: jest.fn(() =>
      opts.branchQueryFails
        ? Promise.reject(new Error('relation does not exist'))
        : Promise.resolve(
            opts.sourceBranchType === undefined
              ? []
              : [{ type: opts.sourceBranchType }],
          ),
    ),
  };
  const orderRepo = { find: jest.fn().mockResolvedValue(orders) };
  const transferBatchRepo = { find: jest.fn().mockResolvedValue([]) };
  const transferBatchItemRepo = { find: jest.fn().mockResolvedValue([]) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const custody = { auditActor: jest.fn(() => ({})) };

  const service = new BranchTransferBatchService(
    dataSource as never,
    transferBatchRepo as never,
    transferBatchItemRepo as never,
    {} as never, // transferBatchHistoryRepo
    orderRepo as never,
    {} as never, // orderTrackingRepo
    {} as never, // orderCustodyEventRepo
    activityLog as never,
    custody as never,
  );
  return { service, dataSource, orderRepo, orderUpdateExecute, itemRepo };
}

const create = (
  h: ReturnType<typeof makeHarness>,
  orderIds: string[] = ['900'],
  sourceBranchId = SOURCE_ID,
) =>
  h.service.createBranchReturnBatches({
    source_branch_id: sourceBranchId,
    order_ids: orderIds,
    request_key: 'rtn_custody_test_1',
    requester_id: '41',
  });

async function expectRejected(
  h: ReturnType<typeof makeHarness>,
  promise: Promise<unknown>,
  reason: string,
  orderIds: string[],
) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(RpcException);
  expect((error as RpcException).getError()).toMatchObject({
    statusCode: 400,
    data: { reason, details: { order_ids: orderIds } },
  });
  // HECH NARSA yozilmagan — tranzaksiya ham ochilmagan.
  expect(h.dataSource.createQueryRunner).not.toHaveBeenCalled();
  expect(h.orderUpdateExecute).not.toHaveBeenCalled();
}

// Kutilgan ogohlantirishlar (filial turini o'qib bo'lmadi, qayta batchlash
// xatosi) test chiqishini to'ldirmasin.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('createBranchReturnBatches — manba filial ushlovchisi', () => {
  it('ushlovchi tekshiruvi uchun holder/kuryer/manba ustunlari o`qiladi', async () => {
    const h = makeHarness([makeOrder()]);
    await create(h);
    const [args] = h.orderRepo.find.mock.calls[0] as [{ select: string[] }];
    expect(args.select).toEqual(
      expect.arrayContaining([
        'holder_type',
        'holder_branch_id',
        'courier_id',
        'holder_courier_id',
        'source',
        'status',
        'canceled_post_id',
      ]),
    );
  });

  it('⭐ manba filial ushlab turgan buyurtma — paket yaratiladi', async () => {
    const h = makeHarness([makeOrder()]);
    await expect(create(h)).resolves.toMatchObject({ statusCode: 201 });
    expect(h.orderUpdateExecute).toHaveBeenCalledTimes(1);
    expect(h.itemRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ batch_id: '500', order_id: '900' }),
    ]);
    // Doira mos — filial turi so'ralmaydi.
    expect(h.dataSource.query).not.toHaveBeenCalled();
  });

  describe('HQ ushlagan buyurtma, branch_id = manba filial', () => {
    const hqHeldAtSource = () =>
      makeOrder({ holder_type: OrderHolderType.HQ, holder_branch_id: null });

    it('⭐ manba oddiy filial (turi ma`lum) — rad: posilka HQ`da', async () => {
      const h = makeHarness([hqHeldAtSource()], {
        sourceBranchType: 'PICKUP',
      });
      await expectRejected(h, create(h), 'order_not_held_by_source', ['900']);
      expect(h.dataSource.query).toHaveBeenCalledTimes(1);
    });

    it('manba HQ — o`tadi', async () => {
      const h = makeHarness([hqHeldAtSource()], { sourceBranchType: 'HQ' });
      await expect(create(h)).resolves.toMatchObject({ statusCode: 201 });
    });

    it('filial topilmadi yoki turini o`qib bo`lmadi — zaxira: branch_id = manba, o`tadi', async () => {
      const missing = makeHarness([hqHeldAtSource()]);
      await expect(create(missing)).resolves.toMatchObject({
        statusCode: 201,
      });
      expect(missing.dataSource.query).toHaveBeenCalledTimes(1);

      const failing = makeHarness([hqHeldAtSource()], {
        branchQueryFails: true,
      });
      await expect(create(failing)).resolves.toMatchObject({
        statusCode: 201,
      });
    });
  });

  it('⭐ boshqa filial ushlab turgan buyurtma — 400 order_not_held_by_source', async () => {
    const h = makeHarness([
      makeOrder(),
      makeOrder({ id: '901', holder_branch_id: '13', branch_id: '13' }),
    ]);
    await expectRejected(
      h,
      create(h, ['900', '901']),
      'order_not_held_by_source',
      ['901'],
    );
    // holder_branch_id bor — HQ tekshiruvi kerak emas.
    expect(h.dataSource.query).not.toHaveBeenCalled();
  });

  it('holder_branch_id boshqa filial, branch_id manba — baribir rad (ushlovchi ustun)', async () => {
    const h = makeHarness([makeOrder({ holder_branch_id: '13' })]);
    await expectRejected(h, create(h), 'order_not_held_by_source', ['900']);
  });

  it('marketga topshirilgan (MARKET) buyurtma — rad', async () => {
    const h = makeHarness([
      makeOrder({
        holder_type: OrderHolderType.MARKET,
        holder_branch_id: null,
      }),
    ]);
    await expectRejected(h, create(h), 'order_not_held_by_source', ['900']);
  });

  it('⭐ kuryer qo`lidagi buyurtma (courier_id / holder_courier_id) — 400 order_with_courier', async () => {
    const byCourierId = makeHarness([makeOrder({ courier_id: '77' })]);
    await expectRejected(
      byCourierId,
      create(byCourierId),
      'order_with_courier',
      ['900'],
    );

    const byHolderCourier = makeHarness([
      makeOrder({
        holder_type: OrderHolderType.COURIER,
        holder_courier_id: '77',
      }),
    ]);
    await expectRejected(
      byHolderCourier,
      create(byHolderCourier),
      'order_with_courier',
      ['900'],
    );
  });

  it('⭐ bekor pochtasi jo`natilgan, hali qabul qilinmagan — 400 cancel_post_not_received', async () => {
    // Jo'natishda holder allaqachon maqsadga (manba filialga) o'tgan, kuryer
    // bo'shatilgan — ushlovchi tekshiruvi o'tib ketardi.
    const sent = makeHarness([
      makeOrder({
        status: Order_status.CANCELLED_SENT,
        canceled_post_id: '3001',
      }),
    ]);
    await expectRejected(sent, create(sent), 'cancel_post_not_received', [
      '900',
    ]);

    // Holat `cancelled`, lekin bekor pochta hali ochiq (`canceled_post_id`).
    const openPost = makeHarness([makeOrder({ canceled_post_id: '3001' })]);
    await expectRejected(
      openPost,
      create(openPost),
      'cancel_post_not_received',
      ['900'],
    );
  });

  it('⭐ tashqi manbadan kelgan NEW buyurtma — 400 external_order_not_received', async () => {
    const h = makeHarness([
      makeOrder({ source: 'external', status: Order_status.NEW }),
    ]);
    await expectRejected(h, create(h), 'external_order_not_received', ['900']);
  });

  it('tashqi buyurtma qabul qilingandan keyin (NEW emas) — o`tadi', async () => {
    const h = makeHarness([
      makeOrder({ source: 'external', status: Order_status.CANCELLED }),
    ]);
    await expect(create(h)).resolves.toMatchObject({ statusCode: 201 });
  });

  describe('HQ ushlagan buyurtma (holder_branch_id yo`q, branch_id boshqa)', () => {
    const hqHeld = () =>
      makeOrder({
        holder_type: OrderHolderType.HQ,
        holder_branch_id: null,
        branch_id: '13',
      });

    it('manba HQ — o`tadi', async () => {
      const h = makeHarness([hqHeld()], { sourceBranchType: 'HQ' });
      await expect(create(h)).resolves.toMatchObject({ statusCode: 201 });
      expect(h.dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('"branch_schema"."branches"'),
        [SOURCE_ID],
      );
    });

    it('manba oddiy filial — rad', async () => {
      const h = makeHarness([hqHeld()], { sourceBranchType: 'PICKUP' });
      await expectRejected(h, create(h), 'order_not_held_by_source', ['900']);
    });

    it('filial topilmadi yoki turini o`qib bo`lmadi — rad (fail-closed)', async () => {
      const missing = makeHarness([hqHeld()]);
      await expectRejected(
        missing,
        create(missing),
        'order_not_held_by_source',
        ['900'],
      );

      const failing = makeHarness([hqHeld()], { branchQueryFails: true });
      await expectRejected(
        failing,
        create(failing),
        'order_not_held_by_source',
        ['900'],
      );
    });

    it('manba HQ bo`lsa ham boshqa filial ushlagan buyurtma — rad', async () => {
      const h = makeHarness(
        [hqHeld(), makeOrder({ id: '901', holder_branch_id: '13' })],
        { sourceBranchType: 'HQ' },
      );
      await expectRejected(
        h,
        create(h, ['900', '901']),
        'order_not_held_by_source',
        ['901'],
      );
    });
  });
});

/**
 * Qisman qabuldan keyin qolganlarni qayta batchlash COMMIT'dan KEYIN ishlaydi —
 * uning xatosi (masalan, yuqoridagi ushlovchi tekshiruvi — 400) qabul qilingan
 * paketni xato qilib ko'rsatmasligi kerak: javob — muvaffaqiyat, paketsiz
 * qolgan buyurtmalar tarix va activity log'ga yoziladi.
 */
describe('receiveBranchTransferBatchOrders — qolganlarni qayta batchlash xatosi', () => {
  function makeReceiveHarness() {
    const batch = {
      id: '70',
      status: BranchTransferBatchStatus.SENT,
      direction: BranchTransferDirection.RETURN,
      source_branch_id: SOURCE_ID,
      destination_branch_id: HOME_ID,
      target_region_id: '7',
      order_count: 2,
      total_price: 0,
      isDeleted: false,
    };
    const items = [
      { id: 'i1', batch_id: '70', order_id: '900', sent_at: new Date() },
      { id: 'i2', batch_id: '70', order_id: '901', sent_at: new Date() },
    ];
    const chain = () => {
      const qb: Record<string, jest.Mock> = {};
      for (const method of ['update', 'set', 'where', 'andWhere']) {
        qb[method] = jest.fn(() => qb);
      }
      qb.execute = jest.fn(() => Promise.resolve({ affected: 1 }));
      return qb;
    };
    const batchRepo = {
      findOne: jest.fn().mockResolvedValue(batch),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const itemRepo = {
      find: jest.fn(
        ({ where }: { where: { order_id?: { value: string[] } } }) =>
          Promise.resolve(
            where.order_id
              ? items.filter((item) =>
                  (where.order_id?.value ?? []).includes(item.order_id),
                )
              : // tanlab qabuldan keyin qolgan — 901
                [items[1]],
          ),
      ),
      createQueryBuilder: jest.fn(chain),
    };
    const orderRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: '900',
          status: Order_status.CANCELLED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: SOURCE_ID,
          holder_courier_id: null,
        },
      ]),
      createQueryBuilder: jest.fn(chain),
    };
    const txHistoryRepo = {
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === 'BranchTransferBatch') return batchRepo;
          if (entity.name === 'BranchTransferBatchItem') return itemRepo;
          if (entity.name === 'Order') return orderRepo;
          if (entity.name === 'BranchTransferBatchHistory') {
            return txHistoryRepo;
          }
          return {};
        }),
      },
    };
    const historyRepo = {
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const custody = {
      toTrackingRole: jest.fn(() => 'manager'),
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      auditActor: jest.fn(() => ({})),
    };
    const service = new BranchTransferBatchService(
      { createQueryRunner: jest.fn(() => queryRunner) } as never,
      {} as never, // transferBatchRepo
      {} as never, // transferBatchItemRepo
      historyRepo as never,
      {} as never, // orderRepo
      {} as never, // orderTrackingRepo
      {} as never, // orderCustodyEventRepo
      activityLog as never,
      custody as never,
    );
    return { service, queryRunner, historyRepo, activityLog };
  }

  const receive = (h: ReturnType<typeof makeReceiveHarness>) =>
    h.service.receiveBranchTransferBatchOrders({
      batch_id: '70',
      order_ids: ['900'],
      requester_id: '41',
      requester_name: 'Filial menejeri',
      requester_roles: ['manager'],
    });

  it('⭐ qayta batchlash 400 — qabul baribir muvaffaqiyatli, paketsiz qolganlar yoziladi', async () => {
    const h = makeReceiveHarness();
    const requeue = jest
      .spyOn(h.service, 'createBranchReturnBatches')
      .mockRejectedValue(
        new RpcException({
          statusCode: 400,
          message: 'Quyidagi buyurtmalar manba filialda emas: 901',
          data: {
            reason: 'order_not_held_by_source',
            details: { order_ids: ['901'] },
          },
        }),
      );

    await expect(receive(h)).resolves.toMatchObject({ statusCode: 200 });
    expect(requeue).toHaveBeenCalledWith(
      expect.objectContaining({
        source_branch_id: SOURCE_ID,
        order_ids: ['901'],
      }),
    );
    expect(h.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(h.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(h.historyRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        batch_id: '70',
        action: BranchTransferBatchAction.RECEIVED,
        notes: expect.stringContaining('901') as unknown,
      }),
    );
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          requeued_count: 0,
          requeue_failed_order_ids: ['901'],
        }) as unknown,
      }),
    );
  });

  it('qayta batchlash muvaffaqiyatli — qo`shimcha tarix yozuvi yo`q', async () => {
    const h = makeReceiveHarness();
    jest
      .spyOn(h.service, 'createBranchReturnBatches')
      .mockResolvedValue({} as never);

    await expect(receive(h)).resolves.toMatchObject({ statusCode: 200 });
    expect(h.historyRepo.save).not.toHaveBeenCalled();
    const [entry] = h.activityLog.log.mock.calls[0] as [
      { metadata: Record<string, unknown> },
    ];
    expect(entry.metadata.requeued_count).toBe(1);
    expect(entry.metadata).not.toHaveProperty('requeue_failed_order_ids');
  });
});
