import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import { IdempotencyKey, SettlementStatus } from '@app/common';
import { OrderSettlementService } from './settlement/order-settlement.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderSettlementCarry } from './entities/order-settlement-carry.entity';

/**
 * znD3KaZL — FIFO qoldig'i (`leftover`) JIM YO'QOLMASIN.
 *
 * Kassa to'lovni to'liq ko'chiradi (`finance.cashbox.payment_courier /
 * branch_to_main / market`), FIFO esa faqat BUTUN buyurtmalarni yopadi.
 * Sig'magan qism `order_settlement_carry` da (tomon + bo'g'in) saqlanadi,
 * keyingi to'lovga qo'shiladi va yig'indilarda ko'rinadi. Bu spec:
 *   • TC1 — 100k+200k+300k, 550k → leftover 250k; keyingi 300k → uchinchi
 *     qator ham yopiladi;
 *   • TC2 — leftover > 0 da qoldiq yozuvi (+ WARN log), idempotentlik, lock
 *     tartibi, jadval tekshiruvi yiqilsa to'lov qoldiqsiz O'TMAYDI;
 *   • TC3 — pul saqlanishi: N ta qisman to'lovdan keyin
 *     Σ kassa harakati == Σ yopilgan oyoqlar + qoldiq (har bo'g'inda);
 *   • /financial-balance uchun "taqsimlanmagan qoldiq" ko'rsatkichi.
 */

const uniqueViolation = () => {
  const err = new QueryFailedError('insert', [], new Error('dup') as never);
  (err as QueryFailedError & { code?: string }).code = '23505';
  return err;
};

type Level = 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
type Row = OrderSettlement & Record<string, unknown>;
type AdvanceData = {
  settled_order_ids: string[];
  allocated: number;
  leftover: number;
  replayed?: boolean;
};

const STAMP: Record<Level, keyof OrderSettlement> = {
  courier_to_branch: 'courier_to_branch_at',
  branch_to_hq: 'branch_to_hq_at',
  hq_to_market: 'hq_to_market_at',
};
const AMOUNT: Record<
  Level,
  'courier_amount' | 'branch_amount' | 'market_amount'
> = {
  courier_to_branch: 'courier_amount',
  branch_to_hq: 'branch_amount',
  hq_to_market: 'market_amount',
};

/**
 * Xotiradagi daftar: `order_settlement`, `order_settlement_carry`,
 * `idempotency_keys`. Tranzaksiya: `rollbackTransaction` holatni
 * `startTransaction` dagi nusxaga qaytaradi, idempotency yozuvlari faqat
 * COMMIT'da ko'rinadi (haqiqiy Postgres kabi).
 */
function makeLedger(
  rows: Partial<OrderSettlement>[] = [],
  opts: {
    carryTable?: boolean;
    carries?: Array<Record<string, unknown>>;
    lookup?: { getHqBranchId: jest.Mock };
    /**
     * Tranzaksion outbox soxtasi (`order_schema.outbox_events`): hodisa
     * faqat COMMIT'da ko'rinadi, rollback'da yo'qoladi (haqiqiy kabi).
     */
    outbox?: boolean;
  } = {},
) {
  let nextId = 0;
  const toRow = (r: Partial<OrderSettlement>): Row =>
    ({
      id: String(++nextId),
      status: SettlementStatus.PENDING,
      courier_amount: 0,
      branch_amount: 0,
      market_amount: 0,
      branch_id: null,
      market_id: null,
      courier_id: null,
      isDeleted: false,
      ...r,
    }) as Row;
  const store: Row[] = rows.map(toRow);
  const carryStore: Array<Record<string, unknown>> = (opts.carries ?? []).map(
    (c, i) => ({ id: `c${i + 1}`, branch_id: null, isDeleted: false, ...c }),
  );
  const committed = new Map<string, Record<string, unknown>>();
  let staged = new Map<string, Record<string, unknown>>();
  type OutboxRow = {
    target: string;
    pattern: string;
    payload: Record<string, unknown>;
  };
  const outboxCommitted: OutboxRow[] = [];
  let outboxStaged: OutboxRow[] = [];
  let snapshot: {
    store: Row[];
    carries: Array<Record<string, unknown>>;
  } | null = null;

  const matches = (row: Record<string, unknown>, where: object = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const settlementRepo = {
    find: jest.fn((o: { where?: object }) =>
      Promise.resolve(
        store
          .filter((row) => matches(row, o?.where))
          .sort((a, b) => Number(a.id) - Number(b.id)),
      ),
    ),
    findOne: jest.fn((o: { where?: object; order?: object }) => {
      const found = store.filter((row) => matches(row, o?.where));
      return Promise.resolve(
        (o?.order ? found.reverse()[0] : found[0]) ?? null,
      );
    }),
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
              (c) => c.level === values.level && c.party_id === values.party_id,
            )
          ) {
            carryStore.push({
              id: `c${carryStore.length + 1}`,
              isDeleted: false,
              ...values,
            });
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

  const txIdemRepo = {
    insert: jest.fn((row: Record<string, unknown>) => {
      const key = String(row.key);
      if (committed.has(key) || staged.has(key)) {
        return Promise.reject(uniqueViolation());
      }
      staged.set(key, { ...row, response: null });
      return Promise.resolve({});
    }),
    update: jest.fn(
      (criteria: { key: string }, patch: Record<string, unknown>) => {
        const row = staged.get(criteria.key);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
    ),
  };
  const idemRepo = {
    findOne: jest.fn((o: { where: { key: string } }) =>
      Promise.resolve(committed.get(o.where.key) ?? null),
    ),
  };

  const clone = <T>(value: T): T => structuredClone(value);
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      staged = new Map();
      outboxStaged = [];
      snapshot = { store: clone(store), carries: clone(carryStore) };
    }),
    commitTransaction: jest.fn(() => {
      staged.forEach((row, key) => committed.set(key, row));
      staged = new Map();
      outboxCommitted.push(...outboxStaged);
      outboxStaged = [];
      snapshot = null;
    }),
    rollbackTransaction: jest.fn(() => {
      staged = new Map();
      outboxStaged = [];
      if (snapshot) {
        store.splice(0, store.length, ...snapshot.store);
        carryStore.splice(0, carryStore.length, ...snapshot.carries);
      }
      snapshot = null;
    }),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === OrderSettlementCarry) return carryRepo;
        if (entity === IdempotencyKey) return txIdemRepo;
        return settlementRepo;
      }),
    },
  };
  const dataSource = {
    options: { schema: 'order_schema' },
    createQueryRunner: jest.fn(() => queryRunner),
    query: jest
      .fn()
      .mockResolvedValue([
        { t: opts.carryTable === false ? null : 'order_settlement_carry' },
      ]),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderSettlementCarry) return carryRepo;
      if (entity === IdempotencyKey) return idemRepo;
      return settlementRepo;
    }),
  };

  const outbox = opts.outbox
    ? {
        enqueue: jest.fn(
          (
            target: string,
            pattern: string,
            payload: Record<string, unknown>,
            options?: { manager?: unknown },
          ) => {
            // Faqat FIFO tranzaksiyasi ichida (manager = queryRunner.manager).
            if (options?.manager !== queryRunner.manager) {
              return Promise.reject(
                new Error('outbox: tranzaksiyadan tashqari'),
              );
            }
            outboxStaged.push({ target, pattern, payload: { ...payload } });
            return Promise.resolve({});
          },
        ),
      }
    : undefined;

  const service = new OrderSettlementService(
    dataSource as never,
    settlementRepo as never,
    {} as never,
    opts.lookup as never,
    outbox as never,
  );

  /** Bitta kassa to'lovi → advance (M8 tokeni bilan, finance kabi). */
  const pay = async (
    level: Level,
    party: string,
    amount: number,
    token: string,
  ): Promise<AdvanceData> => {
    const res = (await service.advanceSettlement({
      level,
      match_value: party,
      amount,
      requester_id: '1',
      request_id: token,
    })) as { data: AdvanceData };
    return res.data;
  };
  const carryOf = (level: Level, party: string) =>
    Number(
      carryStore.find((c) => c.level === level && c.party_id === party)
        ?.amount ?? 0,
    );
  /** Shu bo'g'inda yopilgan (stamp qo'yilgan) oyoqlar yig'indisi (ishorali). */
  const closedLegSum = (
    level: Level,
    partyColumn: keyof OrderSettlement,
    party: string,
  ) =>
    store
      .filter((row) => row[partyColumn] === party && row[STAMP[level]])
      .reduce((sum, row) => sum + Number(row[AMOUNT[level]] ?? 0), 0);
  const addRows = (more: Partial<OrderSettlement>[]) => {
    for (const r of more) store.push(toRow(r));
  };
  const statusOf = (orderId: string) =>
    store.find((row) => row.order_id === orderId)?.status;

  return {
    service,
    store,
    carryStore,
    committed,
    outbox,
    outboxCommitted,
    settlementRepo,
    carryRepo,
    txIdemRepo,
    queryRunner,
    dataSource,
    pay,
    carryOf,
    closedLegSum,
    addRows,
    statusOf,
  };
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const leftoverLogs = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map((call) => String(call[0]))
    .filter((msg) => msg.includes("FIFO qoldig'i (znD3KaZL)"));

const courierRows = (): Partial<OrderSettlement>[] => [
  { order_id: 'A', courier_id: '7', branch_id: '10', courier_amount: 100000 },
  { order_id: 'B', courier_id: '7', branch_id: '10', courier_amount: 200000 },
  { order_id: 'C', courier_id: '7', branch_id: '10', courier_amount: 300000 },
];

describe('znD3KaZL TC1 — qisman topshiruvlar to`planib buyurtmani yopadi', () => {
  it('⭐ 100k+200k+300k: 550k → A,B yopiladi, leftover 250k; keyingi 300k → C ham yopiladi', async () => {
    const l = makeLedger(courierRows());

    const first = await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    expect(first).toEqual({
      settled_order_ids: ['A', 'B'],
      allocated: 300000,
      leftover: 250000,
    });
    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
    expect(l.statusOf('C')).toBe(SettlementStatus.PENDING);

    // 250 000 (qoldiq) + 300 000 = 550 000 ≥ 300 000 → C yopiladi.
    const second = await l.pay('courier_to_branch', '7', 300000, 'pay-2');
    expect(second).toEqual({
      settled_order_ids: ['C'],
      allocated: 300000,
      leftover: 250000,
    });
    for (const id of ['A', 'B', 'C']) {
      expect(l.statusOf(id)).toBe(SettlementStatus.COURIER_SETTLED);
    }
    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
  });

  it('kartadagi holat: 550k dan keyin atigi 50k → 250k + 50k = 300k, C yopiladi, qoldiq 0', async () => {
    const l = makeLedger(courierRows());

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    const second = await l.pay('courier_to_branch', '7', 50000, 'pay-2');

    expect(second).toEqual({
      settled_order_ids: ['C'],
      allocated: 300000,
      leftover: 0,
    });
    expect(l.statusOf('C')).toBe(SettlementStatus.COURIER_SETTLED);
    expect(l.carryOf('courier_to_branch', '7')).toBe(0);
  });

  it('uch marta kichik to`lov (120k, 120k, 120k) — 300k lik C uchinchisida yopiladi', async () => {
    const l = makeLedger([
      {
        order_id: 'C',
        courier_id: '7',
        branch_id: '10',
        courier_amount: 300000,
      },
    ]);

    expect(
      (await l.pay('courier_to_branch', '7', 120000, 'p1')).settled_order_ids,
    ).toEqual([]);
    expect(
      (await l.pay('courier_to_branch', '7', 120000, 'p2')).settled_order_ids,
    ).toEqual([]);
    expect(l.carryOf('courier_to_branch', '7')).toBe(240000);
    const third = await l.pay('courier_to_branch', '7', 120000, 'p3');
    expect(third.settled_order_ids).toEqual(['C']);
    expect(third.leftover).toBe(60000);
  });

  it('filial → HQ va HQ → market bo`g`inlarida ham xuddi shunday', async () => {
    const l = makeLedger([
      {
        order_id: 'B1',
        branch_id: '14',
        status: SettlementStatus.COURIER_SETTLED,
        branch_amount: 300000,
      },
      {
        order_id: 'M1',
        market_id: '191',
        status: SettlementStatus.BRANCH_SETTLED,
        market_amount: 300000,
      },
    ]);

    await l.pay('branch_to_hq', '14', 250000, 'b1');
    expect(l.statusOf('B1')).toBe(SettlementStatus.COURIER_SETTLED);
    await l.pay('branch_to_hq', '14', 50000, 'b2');
    expect(l.statusOf('B1')).toBe(SettlementStatus.BRANCH_SETTLED);
    expect(l.carryOf('branch_to_hq', '14')).toBe(0);

    await l.pay('hq_to_market', '191', 100000, 'm1');
    await l.pay('hq_to_market', '191', 200000, 'm2');
    expect(l.statusOf('M1')).toBe(SettlementStatus.MARKET_SETTLED);
    expect(l.carryOf('hq_to_market', '191')).toBe(0);
  });
});

describe('znD3KaZL TC2 — qoldiq yozuvi, log, idempotentlik, poyga', () => {
  it('⭐ leftover > 0 → order_settlement_carry yozuvi (bo`g`in, tomon, filial, summa) + WARN log', async () => {
    const l = makeLedger(courierRows());

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(l.carryStore).toEqual([
      expect.objectContaining({
        level: 'courier_to_branch',
        party_id: '7',
        branch_id: '10',
        amount: 250000,
      }),
    ]);
    const logs = leftoverLogs(warnSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('level=courier_to_branch');
    expect(logs[0]).toContain('match=7');
    expect(logs[0]).toContain('amount=550000');
    expect(logs[0]).toContain('allocated=300000');
    expect(logs[0]).toContain('leftover=250000');
    expect(logs[0]).toContain('order_settlement_carry ga saqlandi');
    expect(leftoverLogs(errorSpy)).toHaveLength(0);
  });

  it('leftover 0 bo`lsa log yo`q', async () => {
    const l = makeLedger(courierRows());

    const res = await l.pay('courier_to_branch', '7', 300000, 'pay-1');

    expect(res.leftover).toBe(0);
    expect(leftoverLogs(warnSpy)).toHaveLength(0);
    expect(leftoverLogs(errorSpy)).toHaveLength(0);
  });

  it('⭐ idempotent: AYNAN shu to`lov qayta kelsa (tezkor yo`l + outbox relay) qoldiq ikki marta qo`shilmaydi', async () => {
    const l = makeLedger(courierRows());

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    const replay = await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(replay).toEqual({
      settled_order_ids: ['A', 'B'],
      allocated: 300000,
      leftover: 250000,
      replayed: true,
    });
    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
    expect(l.statusOf('C')).toBe(SettlementStatus.PENDING);
    // Takrorda FIFO ishlamaydi — log ham qayta chiqmaydi.
    expect(leftoverLogs(warnSpy)).toHaveLength(1);
  });

  it('poyga: token → qoldiq qatori (pessimistic_write) → nomzodlar — shu tartibda, bitta tranzaksiyada', async () => {
    const l = makeLedger(courierRows());

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    const lockCall = l.carryRepo.findOne.mock.calls.findIndex(
      (call) =>
        (call[0] as { lock?: { mode?: string } })?.lock?.mode ===
        'pessimistic_write',
    );
    expect(lockCall).toBeGreaterThanOrEqual(0);
    const lockOrder = l.carryRepo.findOne.mock.invocationCallOrder[lockCall];
    expect(l.txIdemRepo.insert.mock.invocationCallOrder[0]).toBeLessThan(
      lockOrder,
    );
    expect(lockOrder).toBeLessThan(
      l.settlementRepo.find.mock.invocationCallOrder[0],
    );
    expect(l.queryRunner.startTransaction).toHaveBeenCalledTimes(1);
    expect(l.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('⭐ jadval tekshiruvi yiqilsa tokenli to`lov qoldiqsiz O`TMAYDI: 500, hech narsa o`zgarmaydi; qayta urinishda qoldiq saqlanadi', async () => {
    const l = makeLedger(courierRows());
    l.dataSource.query.mockRejectedValueOnce(new Error('connection reset'));

    const error = await l
      .pay('courier_to_branch', '7', 550000, 'pay-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 500,
    });
    // Tranzaksiya ochilmagan, M8 belgisi qo'yilmagan, daftar o'zgarmagan.
    expect(l.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(l.committed.size).toBe(0);
    expect(l.carryStore).toHaveLength(0);
    expect(l.statusOf('A')).toBe(SettlementStatus.PENDING);

    // Outbox AYNAN shu tokenni qayta yuboradi — endi qoldiq saqlanadi.
    const retry = await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    expect(retry.settled_order_ids).toEqual(['A', 'B']);
    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
  });

  it('60 s lik `false` kesh (yutilgan xatodan) tokenli to`lovni qoldiqsiz o`tkazib yubormaydi', async () => {
    const l = makeLedger(courierRows());
    // Fail-open o'quvchi (yig'indi) xatoni yutadi va `false` ni keshlaydi.
    l.dataSource.query.mockRejectedValueOnce(new Error('pool exhausted'));
    l.settlementRepo.createQueryBuilder.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }));
    await l.service.getFinancialBalanceSettlementSummary();

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
  });

  it('jadval yo`q (migratsiya ishlamagan) — avvalgi tartib, lekin ERROR log "SAQLANMADI"', async () => {
    const l = makeLedger(courierRows(), { carryTable: false });

    const res = await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(res.leftover).toBe(250000);
    expect(l.carryStore).toHaveLength(0);
    const logs = leftoverLogs(errorSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('SAQLANMADI');
    expect(logs[0]).toContain('leftover=250000');
  });

  it('C10: HQ`ning o`z "filial → HQ" to`lovi — qoldiq ataylab saqlanmaydi, WARN da sababi', async () => {
    const l = makeLedger(
      [
        {
          order_id: 'H1',
          branch_id: '1',
          status: SettlementStatus.COURIER_SETTLED,
          branch_amount: 100000,
        },
      ],
      { lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') } },
    );

    const res = await l.pay('branch_to_hq', '1', 150000, 'hq-1');

    expect(res).toEqual({
      settled_order_ids: ['H1'],
      allocated: 100000,
      leftover: 50000,
    });
    expect(l.carryStore).toHaveLength(0);
    const logs = leftoverLogs(warnSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('C10');
    expect(leftoverLogs(errorSpy)).toHaveLength(0);
  });
});

describe('znD3KaZL TC3 — pul saqlanishi (Σ kassa == Σ yopilgan oyoqlar + qoldiq)', () => {
  /** Deterministik psevdo-tasodif (Math.random emas — qayta takrorlanadi). */
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  /** Butun so'm (1 000 ga karrali) — suzuvchi nuqta xatosisiz. */
  const som = (next: () => number, min: number, max: number) =>
    Math.round((min + next() * (max - min)) / 1000) * 1000;

  const LEVELS: Array<{
    level: Level;
    partyColumn: keyof OrderSettlement;
    party: string;
    row: (amount: number) => Partial<OrderSettlement>;
  }> = [
    {
      level: 'courier_to_branch',
      partyColumn: 'courier_id',
      party: '7',
      row: (amount) => ({
        courier_id: '7',
        branch_id: '10',
        courier_amount: amount,
      }),
    },
    {
      level: 'branch_to_hq',
      partyColumn: 'branch_id',
      party: '14',
      row: (amount) => ({
        branch_id: '14',
        status: SettlementStatus.COURIER_SETTLED,
        branch_amount: amount,
      }),
    },
    {
      level: 'hq_to_market',
      partyColumn: 'market_id',
      party: '191',
      row: (amount) => ({
        market_id: '191',
        status: SettlementStatus.BRANCH_SETTLED,
        market_amount: amount,
      }),
    },
  ];

  it.each(LEVELS.map((cfg) => [cfg.level, cfg] as const))(
    '⭐ %s: 15 ta qisman to`lov (har biri 2 marta yetkaziladi) + yangi sotuvlar — har qadamda saqlanadi, oxirida hammasi yopiladi',
    async (_name, cfg) => {
      const next = rng(cfg.level.length * 7919);
      let n = 0;
      const sale = (amount: number) => ({
        order_id: `${cfg.level}-${++n}`,
        ...cfg.row(amount),
      });
      // Bitta kredit qatori (manfiy oyoq: bekor qilingan buyurtma xarajati).
      const l = makeLedger([
        ...Array.from({ length: 6 }, () => sale(som(next, 20000, 500000))),
        sale(-som(next, 5000, 30000)),
      ]);

      let cashMoved = 0;
      for (let k = 1; k <= 15; k++) {
        const amount = som(next, 1000, 400000);
        cashMoved += amount;
        // Tezkor yo'l + outbox relay: AYNI token ikki marta keladi.
        await l.pay(cfg.level, cfg.party, amount, `${cfg.level}-pay-${k}`);
        await l.pay(cfg.level, cfg.party, amount, `${cfg.level}-pay-${k}`);

        const carry = l.carryOf(cfg.level, cfg.party);
        // Saqlanish: har bir so'm yo yopilgan oyoqda, yo qoldiqda.
        expect(cashMoved).toBe(
          l.closedLegSum(cfg.level, cfg.partyColumn, cfg.party) + carry,
        );
        expect(carry).toBeGreaterThanOrEqual(0);

        // Qat'iy FIFO: qoldiq (+ ochiq kreditlar) eng eski ochiq buyurtmani
        // yopishga yetmaydi — aks holda FIFO to'xtamasligi kerak edi.
        const open = l.store.filter(
          (row) => row[cfg.partyColumn] === cfg.party && !row[STAMP[cfg.level]],
        );
        const leg = (row: Row) => Number(row[AMOUNT[cfg.level]] ?? 0);
        const oldestOpen = open.find((row) => leg(row) > 0);
        const openCredits = open
          .filter((row) => leg(row) < 0)
          .reduce((sum, row) => sum - leg(row), 0);
        if (oldestOpen) {
          expect(carry + openCredits).toBeLessThan(leg(oldestOpen));
        }

        if (k % 4 === 0) {
          l.addRows([
            sale(som(next, 20000, 300000)),
            sale(som(next, 20000, 300000)),
          ]);
        }
      }

      // Qolgan qarzni AYNAN to'lash — barcha musbat qatorlar yopiladi.
      const openRows = () =>
        l.store.filter(
          (row) => row[cfg.partyColumn] === cfg.party && !row[STAMP[cfg.level]],
        );
      const legOf = (row: Row) => Number(row[AMOUNT[cfg.level]] ?? 0);
      const due =
        openRows().reduce((sum, row) => sum + legOf(row), 0) -
        l.carryOf(cfg.level, cfg.party);
      if (due > 0) {
        cashMoved += due;
        await l.pay(cfg.level, cfg.party, due, `${cfg.level}-final`);
      }
      expect(openRows().filter((row) => legOf(row) > 0)).toHaveLength(0);
      const carry = l.carryOf(cfg.level, cfg.party);
      expect(cashMoved).toBe(
        l.closedLegSum(cfg.level, cfg.partyColumn, cfg.party) + carry,
      );
      if (due > 0) {
        // Qarz AYNAN to'landi: kreditlar ham tortildi, qoldiq 0, jami kassa
        // harakati jami oyoqlarga teng.
        expect(openRows()).toHaveLength(0);
        expect(carry).toBe(0);
        expect(cashMoved).toBe(
          l.store.reduce((sum, row) => sum + legOf(row), 0),
        );
      } else if (!openRows().length) {
        // Tasodifiy to'lovlar qarzdan oshib ketdi — ortig'i oldindan
        // to'langan qoldiq bo'lib turadi (yo'qolmaydi).
        expect(carry).toBe(
          cashMoved - l.store.reduce((sum, row) => sum + legOf(row), 0),
        );
      }
    },
  );

  it('⭐ zanjir: kuryer → filial va filial → HQ to`lovlari aralash (kaskad bilan) — har bo`g`in alohida saqlanadi', async () => {
    const next = rng(4242);
    let n = 0;
    const sale = () => {
      const courier = som(next, 50000, 400000);
      // Filial ulushi: kuryer topshirganidan kamroq HQ'ga boradi.
      const branch = courier - som(next, 5000, 20000);
      return {
        order_id: `S${++n}`,
        courier_id: '7',
        branch_id: '10',
        market_id: '191',
        courier_amount: courier,
        branch_amount: branch,
      };
    };
    const l = makeLedger(Array.from({ length: 8 }, sale));

    let courierCash = 0;
    let branchCash = 0;
    for (let k = 1; k <= 12; k++) {
      if (k % 2) {
        const amount = som(next, 10000, 350000);
        courierCash += amount;
        await l.pay('courier_to_branch', '7', amount, `c-${k}`);
      } else {
        const amount = som(next, 10000, 300000);
        branchCash += amount;
        await l.pay('branch_to_hq', '10', amount, `b-${k}`);
      }

      expect(courierCash).toBe(
        l.closedLegSum('courier_to_branch', 'courier_id', '7') +
          l.carryOf('courier_to_branch', '7'),
      );
      expect(branchCash).toBe(
        l.closedLegSum('branch_to_hq', 'branch_id', '10') +
          l.carryOf('branch_to_hq', '10'),
      );
      // Filial bo'g'inida faqat kuryer bo'g'ini yopgan qatorlar yopiladi.
      for (const row of l.store) {
        if (row.branch_to_hq_at) {
          expect(row.courier_to_branch_at).toBeTruthy();
        }
      }
    }
  });
});

describe('znD3KaZL — /financial-balance "taqsimlanmagan qoldiq" ko`rsatkichi', () => {
  const makeQb = (rows: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  });

  it('⭐ bo`g`in bo`yicha jami + tomonlar; mavjud yig`indilar o`zgarmaydi; HQ o`z qoldig`i (C10) kirmaydi', async () => {
    const l = makeLedger([], {
      carries: [
        {
          level: 'courier_to_branch',
          party_id: '7',
          branch_id: '10',
          amount: 250000,
        },
        {
          level: 'courier_to_branch',
          party_id: '8',
          branch_id: null,
          amount: 40000,
        },
        { level: 'branch_to_hq', party_id: '14', amount: 95000 },
        // C10 — HQ nomidagi eski qoldiq: haqiqiy naqd emas.
        { level: 'branch_to_hq', party_id: '1', amount: 30000 },
        { level: 'hq_to_market', party_id: '191', amount: 20000 },
        // Nol qoldiq — ko'rsatilmaydi.
        { level: 'courier_to_branch', party_id: '9', amount: 0 },
      ],
      lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
    });
    l.settlementRepo.createQueryBuilder
      .mockReturnValueOnce(
        makeQb([
          { branch_id: '14', amount: '235000' },
          { branch_id: null, amount: '90000' },
        ]),
      )
      .mockReturnValueOnce(makeQb([{ market_id: '191', amount: '220000' }]));

    const response =
      (await l.service.getFinancialBalanceSettlementSummary()) as {
        data: Record<string, unknown>;
      };

    // Mavjud maydonlar — qoldiq mexanizmi bilan avvalgidek.
    expect(response.data.branches).toEqual([
      { branch_id: '14', amount: 140000 },
    ]);
    expect(response.data.hq_receivable).toBe(50000);
    expect(response.data.chain_receivable).toBe(190000);
    expect(response.data.market_payable).toBe(200000);
    // Yangi ko'rsatkich.
    expect(response.data.unapplied_carry).toEqual({
      total: 405000,
      courier_to_branch: 290000,
      branch_to_hq: 95000,
      hq_to_market: 20000,
      count: 4,
      items: [
        {
          level: 'courier_to_branch',
          party_id: '7',
          branch_id: '10',
          amount: 250000,
        },
        {
          level: 'branch_to_hq',
          party_id: '14',
          branch_id: null,
          amount: 95000,
        },
        {
          level: 'courier_to_branch',
          party_id: '8',
          branch_id: null,
          amount: 40000,
        },
        {
          level: 'hq_to_market',
          party_id: '191',
          branch_id: null,
          amount: 20000,
        },
      ],
    });
  });

  it('qoldiq yo`q — `unapplied_carry` kaliti qo`shilmaydi (javob shakli avvalgidek)', async () => {
    const l = makeLedger();
    l.settlementRepo.createQueryBuilder
      .mockReturnValueOnce(makeQb([{ branch_id: '14', amount: '100000' }]))
      .mockReturnValueOnce(makeQb([]));

    const response =
      (await l.service.getFinancialBalanceSettlementSummary()) as {
        data: Record<string, unknown>;
      };

    expect(response.data).not.toHaveProperty('unapplied_carry');
    expect(response.data.chain_receivable).toBe(100000);
  });
});

describe('znD3KaZL — finance_settlement_unapplied hodisasi (sekin yo`l: outbox, FIFO tranzaksiyasi ichida)', () => {
  const UNAPPLIED = 'finance.settlement.unapplied_recorded';
  const unappliedEvents = (l: ReturnType<typeof makeLedger>) =>
    l.outboxCommitted.filter((event) => event.pattern === UNAPPLIED);

  it('⭐ leftover > 0 → AYNAN shu tranzaksiyada FINANCE ga bitta hodisa (level, actor_id, amount, dedup_epoch)', async () => {
    const l = makeLedger(courierRows(), { outbox: true });

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(unappliedEvents(l)).toEqual([
      {
        target: 'FINANCE',
        pattern: UNAPPLIED,
        payload: {
          level: 'courier_to_branch',
          actor_id: '7',
          amount: 250000,
          dedup_epoch: 'pay-1',
          lump_sum: 550000,
          allocated: 300000,
          carry_persisted: true,
          settled_count: 2,
        },
      },
    ]);
    // Tranzaksiya ICHIDA: enqueue commit'dan oldin, bitta tranzaksiya.
    expect(l.outbox!.enqueue).toHaveBeenCalledTimes(1);
    expect(l.outbox!.enqueue.mock.calls[0][3]).toEqual({
      manager: l.queryRunner.manager,
    });
    expect(l.outbox!.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      l.queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
    expect(l.queryRunner.startTransaction).toHaveBeenCalledTimes(1);
  });

  it('leftover = 0 → hodisa yo`q', async () => {
    const l = makeLedger(courierRows(), { outbox: true });

    const res = await l.pay('courier_to_branch', '7', 300000, 'pay-1');

    expect(res.leftover).toBe(0);
    expect(l.outbox!.enqueue).not.toHaveBeenCalled();
    expect(l.outboxCommitted).toHaveLength(0);
  });

  it('⭐ takroriy yetkazish (tezkor yo`l + relay, AYNI token) → hodisa BIR marta', async () => {
    const l = makeLedger(courierRows(), { outbox: true });

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    const replay = await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(replay.replayed).toBe(true);
    expect(unappliedEvents(l)).toHaveLength(1);
  });

  it('har to`lov o`z tokeni bilan — keyingi to`lovdagi qoldiq alohida hodisa', async () => {
    const l = makeLedger(courierRows(), { outbox: true });

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    await l.pay('courier_to_branch', '7', 300000, 'pay-2');

    expect(
      unappliedEvents(l).map((event) => [
        event.payload.dedup_epoch,
        event.payload.amount,
      ]),
    ).toEqual([
      ['pay-1', 250000],
      ['pay-2', 250000],
    ]);
  });

  it('⭐ outbox yozuvi yiqilsa FIFO ham qaytariladi (atomik): xato, hech narsa o`zgarmaydi; qayta urinishda hodisa bitta', async () => {
    const l = makeLedger(courierRows(), { outbox: true });
    l.outbox!.enqueue.mockRejectedValueOnce(new Error('outbox insert failed'));

    const error = await l
      .pay('courier_to_branch', '7', 550000, 'pay-1')
      .catch((e: unknown) => e);

    // Xato yutilmaydi (M8 kaliti `failed` → finance outbox advance'ni qayta
    // yuboradi) — xuddi boshqa baza xatolari kabi.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('outbox insert failed');
    expect(l.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(l.committed.size).toBe(0);
    expect(l.carryOf('courier_to_branch', '7')).toBe(0);
    expect(l.statusOf('A')).toBe(SettlementStatus.PENDING);
    expect(l.outboxCommitted).toHaveLength(0);

    const retry = await l.pay('courier_to_branch', '7', 550000, 'pay-1');
    expect(retry.leftover).toBe(250000);
    expect(l.carryOf('courier_to_branch', '7')).toBe(250000);
    expect(unappliedEvents(l)).toHaveLength(1);
  });

  it('C10 HQ tomoni (qoldiq saqlanmaydi) — javobda qoldiq bor, hodisa ham bor (carry_persisted=false)', async () => {
    const l = makeLedger(
      [
        {
          order_id: 'H1',
          branch_id: '1',
          status: SettlementStatus.COURIER_SETTLED,
          branch_amount: 100000,
        },
      ],
      {
        outbox: true,
        lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
      },
    );

    await l.pay('branch_to_hq', '1', 150000, 'hq-1');

    expect(unappliedEvents(l)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          level: 'branch_to_hq',
          actor_id: '1',
          amount: 50000,
          dedup_epoch: 'hq-1',
          carry_persisted: false,
        }),
      }),
    ]);
    expect(l.carryStore).toHaveLength(0);
  });

  it('jadval yo`q (migratsiya 048 ishlamagan) — qoldiq saqlanmaydi, lekin hodisa yoziladi', async () => {
    const l = makeLedger(courierRows(), { carryTable: false, outbox: true });

    await l.pay('courier_to_branch', '7', 550000, 'pay-1');

    expect(unappliedEvents(l)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          amount: 250000,
          carry_persisted: false,
        }),
      }),
    ]);
  });

  it('kaskad (lump-sum 0, qoldiqni qo`llash) hodisa YOZMAYDI — u kassa to`lovi emas', async () => {
    const l = makeLedger(
      [
        {
          order_id: 'A',
          courier_id: '7',
          branch_id: '10',
          courier_amount: 100000,
          branch_amount: 300000,
        },
      ],
      {
        outbox: true,
        carries: [{ level: 'branch_to_hq', party_id: '10', amount: 50000 }],
      },
    );

    await l.pay('courier_to_branch', '7', 100000, 'pay-1');

    // Kuryer bo'g'ini to'liq yopildi; filial kaskadi qoldiqqa sig'madi.
    expect(l.statusOf('A')).toBe(SettlementStatus.COURIER_SETTLED);
    expect(l.carryOf('branch_to_hq', '10')).toBe(50000);
    expect(l.outbox!.enqueue).not.toHaveBeenCalled();
  });

  it('tokensiz eski chaqiruvchi — bir martalik `no-token:` kaliti bilan', async () => {
    const l = makeLedger(courierRows(), { outbox: true });

    await l.service.advanceSettlement({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 550000,
      requester_id: '1',
    });

    const [event] = unappliedEvents(l);
    expect(String(event.payload.dedup_epoch)).toMatch(/^no-token:/);
    expect(event.payload.amount).toBe(250000);
  });

  it('⭐ qoldiq mexanizmi va javob O`ZGARMAYDI: outbox bilan va outboxsiz natija bir xil', async () => {
    const run = async (outbox: boolean) => {
      const l = makeLedger(courierRows(), { outbox });
      const answers = [
        await l.pay('courier_to_branch', '7', 550000, 'p1'),
        await l.pay('courier_to_branch', '7', 120000, 'p2'),
        await l.pay('courier_to_branch', '7', 50000, 'p3'),
      ];
      return {
        answers,
        carry: l.carryOf('courier_to_branch', '7'),
        statuses: ['A', 'B', 'C'].map((id) => l.statusOf(id)),
      };
    };

    expect(await run(true)).toEqual(await run(false));
  });
});
