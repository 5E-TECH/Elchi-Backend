import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { SettlementStatus } from '@app/common';
import { OrderServiceController } from './order-service.controller';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * C8 (CODE-06) — `order.settlement.close_zero_courier_rows`.
 *
 * Kuryerning oxirgi sotuvi aynan uning ulushiga teng bo'lsa PENDING qator 0,
 * kassa ham 0: menejer 0 so'm qabul qila olmaydi, kuryerni o'tkazish /
 * filialdan chiqarish esa abadiy 409. Bu RPC FAQAT sof-nol holatda (qatorlar
 * yig'indisi aynan 0 tiyin, qoldiq 0) qatorlarni nol lump-sum FIFO bilan
 * yopadi. Pul ko'chmaydi.
 */

describe('order.settlement.close_zero_courier_rows handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'settlementCloseZeroCourierRows',
  )?.value as (data: unknown, context: RmqContext) => Promise<unknown>;

  it("naqsh AYNAN { cmd: 'order.settlement.close_zero_courier_rows' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.settlement.close_zero_courier_rows' },
    ]);
  });

  it('payload executeAndAck orqali servisga o`zgarishsiz uzatiladi', async () => {
    const reply = { closed_count: 2 };
    const settlementService = {
      closeZeroCourierRows: jest.fn().mockResolvedValue(reply),
    };
    const executeAndAck = jest.fn(
      (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
    );
    const ctx = {} as RmqContext;
    const payload = {
      courier_id: '263',
      requester: { id: '5', roles: ['manager'] },
    };

    const res: unknown = await handler.call(
      { executeAndAck, settlementService },
      payload,
      ctx,
    );

    expect(res).toBe(reply);
    expect(executeAndAck).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(settlementService.closeZeroCourierRows).toHaveBeenCalledWith(
      payload,
    );
  });

  it('payload bo`lmasa bo`sh obyekt uzatiladi', async () => {
    const settlementService = {
      closeZeroCourierRows: jest.fn().mockResolvedValue({}),
    };

    await handler.call(
      {
        executeAndAck: (_ctx: RmqContext, fn: () => Promise<unknown>) => fn(),
        settlementService,
      },
      undefined,
      {} as RmqContext,
    );

    expect(settlementService.closeZeroCourierRows).toHaveBeenCalledWith({});
  });
});

describe('OrderSettlementService.closeZeroCourierRows', () => {
  type Row = Partial<OrderSettlement>;
  type Carry = Partial<OrderSettlementCarry>;

  function makeService(
    rows: Row[],
    carries: Carry[] = [],
    opts: { carryTable?: boolean } = {},
  ) {
    const store = rows.map((r, i) => ({
      id: String(i + 1),
      status: SettlementStatus.PENDING,
      courier_amount: 0,
      branch_amount: 0,
      market_amount: 0,
      isDeleted: false,
      ...r,
    })) as OrderSettlement[];
    const carryStore = carries.map((c, i) => ({
      id: String(i + 1),
      branch_id: null,
      amount: 0,
      isDeleted: false,
      ...c,
    })) as OrderSettlementCarry[];
    const matches = (row: object, where: object = {}) =>
      Object.entries(where).every(
        ([k, v]) => (row as Record<string, unknown>)[k] === v,
      );

    const settlementRepo = {
      find: jest.fn((o: { where?: object }) =>
        Promise.resolve(
          store
            .filter((row) => matches(row, o?.where))
            .sort((a, b) => Number(a.id) - Number(b.id)),
        ),
      ),
      findOne: jest.fn(
        (o: { where?: object }) =>
          store.find((row) => matches(row, o?.where)) ?? null,
      ),
      update: jest.fn((criteria: { id: string }, patch: object) => {
        const row = store.find((r) => r.id === criteria.id);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      }),
      createQueryBuilder: jest.fn(),
    };
    const carryRepo = {
      createQueryBuilder: jest.fn(() => {
        let values: Record<string, unknown> = {};
        const qb = {
          insert: () => qb,
          values: (v: Record<string, unknown>) => {
            values = v;
            return qb;
          },
          orIgnore: () => qb,
          execute: () => {
            if (
              !carryStore.some(
                (c) =>
                  c.level === values.level && c.party_id === values.party_id,
              )
            ) {
              carryStore.push({
                id: String(carryStore.length + 1),
                isDeleted: false,
                ...values,
              } as OrderSettlementCarry);
            }
            return Promise.resolve({});
          },
        };
        return qb;
      }),
      findOne: jest.fn(
        (o: { where?: object }) =>
          carryStore.find((c) => matches(c, o?.where)) ?? null,
      ),
      find: jest.fn((o: { where?: object }) =>
        Promise.resolve(carryStore.filter((c) => matches(c, o?.where))),
      ),
      update: jest.fn((criteria: { id: string }, patch: object) => {
        const row = carryStore.find((c) => c.id === criteria.id);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      }),
    };
    const repoFor = (entity: unknown) =>
      entity === OrderSettlementCarry ? carryRepo : settlementRepo;
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: { getRepository: jest.fn(repoFor) },
    };
    const dataSource = {
      options: { schema: 'order_schema' },
      createQueryRunner: jest.fn(() => queryRunner),
      query: jest
        .fn()
        .mockResolvedValue([
          { t: opts.carryTable === false ? null : 'order_settlement_carry' },
        ]),
      getRepository: jest.fn(repoFor),
    };
    const service = new OrderSettlementService(
      dataSource as never,
      settlementRepo as never,
      {} as never,
    );
    return {
      service,
      store,
      carryStore,
      settlementRepo,
      carryRepo,
      queryRunner,
      dataSource,
    };
  }

  type Reply = {
    statusCode: number;
    message: string;
    closed_count: number;
    data: {
      courier_id: string;
      closed_count: number;
      closed_order_ids: string[];
      skipped_reason: string | null;
    };
  };
  const close = (
    service: OrderSettlementService,
    data: Parameters<OrderSettlementService['closeZeroCourierRows']>[0] = {
      courier_id: '263',
      requester: { id: '42', roles: ['manager'] },
    },
  ) => service.closeZeroCourierRows(data) as Promise<Reply>;

  const rpcErrorOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => {
        throw new Error('rad etilishi kutilgandi');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('⭐ sof-nol (5 000 + −5 000 + 0) va qoldiq 0 — HAMMA qator bitta tranzaksiyada yopiladi', async () => {
    const { service, store, queryRunner } = makeService([
      {
        order_id: 'A',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 5000,
      },
      {
        order_id: 'B',
        courier_id: '263',
        branch_id: '10',
        courier_amount: -5000,
      },
      { order_id: 'C', courier_id: '263', branch_id: null, courier_amount: 0 },
    ]);

    const res = await close(service);

    expect(res.statusCode).toBe(200);
    expect(res.closed_count).toBe(3);
    expect(res.data).toEqual({
      courier_id: '263',
      closed_count: 3,
      closed_order_ids: ['A', 'B', 'C'],
      skipped_reason: null,
    });
    // Filial qatori — filialga; HQ kuryeri qatori (branch_id NULL) — HQ'da.
    expect(store.map((row) => row.status)).toEqual([
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ]);
    expect(store.every((row) => row.courier_to_branch_by === '42')).toBe(true);
    expect(store.every((row) => row.courier_to_branch_at instanceof Date)).toBe(
      true,
    );
    expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('qoldiq qatori QULF bilan o`qiladi (parallel to`lov bilan poyga yo`q)', async () => {
    const { service, carryRepo } = makeService([
      { order_id: 'A', courier_id: '263', courier_amount: 0 },
    ]);

    await close(service);

    expect(carryRepo.findOne).toHaveBeenCalledWith({
      where: { level: 'courier_to_branch', party_id: '263' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('butun tiyinda: 0,10 + 0,20 − 0,30 = 0 → yopiladi (suzuvchi nuqta to`xtatmaydi)', async () => {
    const { service, store } = makeService([
      {
        order_id: 'A',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 0.1,
      },
      {
        order_id: 'B',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 0.2,
      },
      {
        order_id: 'C',
        courier_id: '263',
        branch_id: '10',
        courier_amount: -0.3,
      },
    ]);

    const res = await close(service);

    expect(res.closed_count).toBe(3);
    expect(
      store.every((row) => row.status === SettlementStatus.COURIER_SETTLED),
    ).toBe(true);
  });

  it('yig`indi 1 tiyin ham farq qilsa — hech narsa yopilmaydi (rollback)', async () => {
    const { service, store, queryRunner } = makeService([
      {
        order_id: 'A',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 5000,
      },
      {
        order_id: 'B',
        courier_id: '263',
        branch_id: '10',
        courier_amount: -4999.99,
      },
    ]);

    const res = await close(service);

    expect(res.closed_count).toBe(0);
    expect(res.data.skipped_reason).toBe('pending_amount_not_zero');
    expect(res.data.closed_order_ids).toEqual([]);
    expect(store.every((row) => row.status === SettlementStatus.PENDING)).toBe(
      true,
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it.each([[5000], [0.01], [-50]])(
    'qoldiq %p (0 emas) — yopilmaydi, qoldiq o`zgarmaydi',
    async (amount) => {
      const { service, store, carryStore, carryRepo } = makeService(
        [
          {
            order_id: 'A',
            courier_id: '263',
            branch_id: '10',
            courier_amount: 0,
          },
        ],
        [{ level: 'courier_to_branch', party_id: '263', amount }],
      );

      const res = await close(service);

      expect(res.closed_count).toBe(0);
      expect(res.data.skipped_reason).toBe('carry_not_zero');
      expect(store[0].status).toBe(SettlementStatus.PENDING);
      expect(Number(carryStore[0].amount)).toBe(amount);
      expect(carryRepo.update).not.toHaveBeenCalled();
    },
  );

  it('PENDING qator yo`q — no_pending_rows; ikkinchi chaqiruv ham xavfsiz (idempotent)', async () => {
    const { service } = makeService([
      { order_id: 'A', courier_id: '263', branch_id: '10', courier_amount: 0 },
    ]);

    expect((await close(service)).closed_count).toBe(1);
    const again = await close(service);

    expect(again.closed_count).toBe(0);
    expect(again.data.skipped_reason).toBe('no_pending_rows');
  });

  it('faqat shu kuryerning PENDING qatorlari: boshqa kuryer va boshqa holatlar hisobga kirmaydi', async () => {
    const { service, store } = makeService([
      { order_id: 'A', courier_id: '263', branch_id: '10', courier_amount: 0 },
      // Boshqa kuryerning noldan farqli qatori — bu kuryerga ta'sir qilmaydi.
      {
        order_id: 'X',
        courier_id: '999',
        branch_id: '10',
        courier_amount: 7000,
      },
      // Shu kuryerning allaqachon yopilgan qatori — yig'indiga kirmaydi.
      {
        order_id: 'S',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 90000,
        status: SettlementStatus.COURIER_SETTLED,
      },
      // O'chirilgan qator ham kirmaydi.
      {
        order_id: 'D',
        courier_id: '263',
        branch_id: '10',
        courier_amount: 3000,
        isDeleted: true,
      },
    ]);

    const res = await close(service);

    expect(res.data.closed_order_ids).toEqual(['A']);
    expect(store[1].status).toBe(SettlementStatus.PENDING);
    expect(store[3].status).toBe(SettlementStatus.PENDING);
  });

  it('kaskad: filialning branch_to_hq qoldig`i yangi yopilgan qatorga darhol qo`llanadi', async () => {
    const { service, store, carryStore } = makeService(
      [
        {
          order_id: 'A',
          courier_id: '263',
          branch_id: '10',
          market_id: '191',
          courier_amount: 0,
          branch_amount: 3000,
        },
      ],
      [{ level: 'branch_to_hq', party_id: '10', amount: 3000 }],
    );

    const res = await close(service);

    expect(res.closed_count).toBe(1);
    // courier → branch (sof-nol), so'ng filialning oldindan topshirgan
    // qoldig'i bilan branch → HQ — advanceSettlement dagi kabi.
    expect(store[0].status).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(
      Number(carryStore.find((c) => c.level === 'branch_to_hq')?.amount ?? NaN),
    ).toBe(0);
  });

  it("qoldiq jadvali yo'q muhit — qoldiq yo'q, sof-nol qatorlar baribir yopiladi", async () => {
    const { service, carryRepo } = makeService(
      [{ order_id: 'A', courier_id: '263', courier_amount: 0 }],
      [],
      { carryTable: false },
    );

    const res = await close(service);

    expect(res.closed_count).toBe(1);
    expect(carryRepo.findOne).not.toHaveBeenCalled();
  });

  it('requester yo`q yoki raqam emas — `courier_to_branch_by` NULL', async () => {
    const first = makeService([
      { order_id: 'A', courier_id: '263', courier_amount: 0 },
    ]);
    await close(first.service, { courier_id: '263' });
    expect(first.store[0].courier_to_branch_by).toBeNull();

    const second = makeService([
      { order_id: 'A', courier_id: '263', courier_amount: 0 },
    ]);
    await close(second.service, {
      courier_id: '263',
      requester: { id: 'system', roles: ['superadmin'] },
    });
    expect(second.store[0].courier_to_branch_by).toBeNull();
  });

  it.each([['abc'], [''], [null], [undefined], ['12a']])(
    'raqam bo`lmagan courier_id (%p) — 400, tranzaksiya ochilmaydi',
    async (courierId) => {
      const { service, dataSource } = makeService([]);

      const err = await rpcErrorOf(
        service.closeZeroCourierRows({ courier_id: courierId as never }),
      );

      expect(err).toEqual({
        statusCode: 400,
        message: "courier_id raqam ko'rinishida bo'lishi kerak",
      });
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    },
  );

  it('baza xatosi — har doim RpcException 500 (o`zbekcha), tranzaksiya qaytariladi', async () => {
    const { service, settlementRepo, queryRunner } = makeService([
      { order_id: 'A', courier_id: '263', courier_amount: 0 },
    ]);
    settlementRepo.find.mockRejectedValueOnce(new Error('connection reset'));

    const err = await rpcErrorOf(close(service));

    expect(err).toEqual({
      statusCode: 500,
      message:
        "Kuryerning sof-nol hisob-kitob qatorlarini yopib bo'lmadi (ma'lumotlar bazasi xatosi)",
    });
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it("qoldiq jadvalini tekshirish xatosi — 500 (qoldiq 'yo`q' deb taxmin QILINMAYDI)", async () => {
    const { service, dataSource, store } = makeService([
      { order_id: 'A', courier_id: '263', courier_amount: 0 },
    ]);
    dataSource.query.mockRejectedValueOnce(new Error('statement timeout'));

    const err = await rpcErrorOf(close(service));

    expect(err.statusCode).toBe(500);
    expect(store[0].status).toBe(SettlementStatus.PENDING);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('yutilgan xatodan qolgan `false` kesh qoldiqni yashira olmaydi', async () => {
    const { service, store } = makeService(
      [{ order_id: 'A', courier_id: '263', courier_amount: 0 }],
      [{ level: 'courier_to_branch', party_id: '263', amount: 5000 }],
    );
    (
      service as unknown as { carryTableReady: boolean | null }
    ).carryTableReady = false;
    (service as unknown as { carryCheckedAt: number }).carryCheckedAt =
      Date.now();

    const res = await close(service);

    expect(res.data.skipped_reason).toBe('carry_not_zero');
    expect(store[0].status).toBe(SettlementStatus.PENDING);
  });
});
