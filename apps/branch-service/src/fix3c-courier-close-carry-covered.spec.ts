import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * fix3c (MONEY-02) — kuryerni o'tkazish / filialdan chiqarish tekshiruvi
 * `order.settlement.close_zero_courier_rows` ni endi kassa 0 va PENDING
 * yig'indisi taqsimlanmagan qoldiqqa AYNAN teng (tiyin) bo'lganda ham
 * chaqiradi.
 *
 * Holat: superadmin kuryer topshirgan sotuvni qaytardi (summa kuryer
 * qoldig'iga kredit), kuryer uni AYNI summaga qayta sotdi — kassa 0, PENDING
 * 140 000 = qoldiq 140 000. Ilgari yopish faqat yig'indi ham, qoldiq ham 0
 * bo'lganda chaqirilardi, ya'ni kuryer keyingi to'lovigacha 409 da qolardi.
 * Boshqa barcha 409 sabablari va C8 (0 / 0) xatti-harakati o'zgarmagan.
 *
 * Garnitura — `branch-service.courier-transfer.spec.ts` dagining qisqa
 * nusxasi: branch_users xotiradagi jadval, tranzaksiya xatoda qaytariladi,
 * RPC javoblari `cmd` bo'yicha, qayta tekshiruvdan oldingi kutish stub.
 */
type Row = {
  id: string;
  branch_id: string;
  user_id: string;
  role: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type Reply = (payload: any) => Observable<unknown>;

const HQ = {
  id: '1',
  name: 'HQ Toshkent',
  code: 'HQ-TSHKNT',
  type: 'HQ',
  status: 'active',
  region_id: null,
  isDeleted: false,
};
const SAMARQAND = {
  id: '15',
  name: 'Samarqand',
  code: 'SAM',
  type: 'REGIONAL',
  status: 'active',
  region_id: '7',
  isDeleted: false,
};
const BUXORO = {
  id: '16',
  name: 'Buxoro',
  code: 'BUX',
  type: 'HYBRID',
  status: 'active',
  region_id: '8',
  isDeleted: false,
};

const SA = { id: '1', roles: ['superadmin'] };

const COURIER = '263';
const CLOSE_CMD = 'order.settlement.close_zero_courier_rows';
const OPEN_RETURN_POSTS_CMD = 'logistics.post.open_return_posts_for_courier';
const HOLDING_CMDS = [
  'finance.cashbox.find_by_user',
  'order.courier_transfer_check',
  OPEN_RETURN_POSTS_CMD,
];
const CLEAN_ORDER_CHECK = {
  courier_id: COURIER,
  pending_settlement_count: 0,
  pending_settlement_amount: 0,
  carry_amount: 0,
  orders_in_hand: 0,
  orders_sample: [],
  pending_extra_cost_approvals: 0,
};
/** SA krediti + AYNI summaga qayta sotuv: PENDING 140 000 = qoldiq 140 000. */
const CARRY_COVERED = {
  pending_settlement_count: 1,
  pending_settlement_amount: 140000,
  carry_amount: 140000,
};

const TRANSFER_PREFIX = "Kuryerni boshqa filialga o'tkazib bo'lmaydi: ";
const UNASSIGN_PREFIX = "Kuryerni filialdan chiqarib bo'lmaydi: ";
/** Yopilmasa — avvalgi (o'zgarmagan) ikki sabab. */
const pendingReason = (amount: string) =>
  `kuryerning 1 ta sotuvi bo'yicha hisob-kitob hali yopilmagan (${amount} so'm). Pul topshirilgan bo'lsa, bir necha soniyadan so'ng qayta tekshiring.`;
const carryReason = (amount: string) =>
  `kuryerda taqsimlanmagan qoldiq bor (${amount} so'm) — hisob-kitob yakunlanmagan.`;

describe('fix3c MONEY-02 — o`tkazish/chiqarish: PENDING = qoldiq bo`lsa ham sof-nol yopish chaqiriladi', () => {
  let service: BranchServiceService;
  let calls: string[];
  let rows: Row[];
  let replies: Record<string, Reply>;
  let branchRepo: any;
  let branchUserRepo: any;
  let clients: Record<
    'identity' | 'logistics' | 'order' | 'file' | 'finance',
    { send: jest.Mock }
  >;
  let clock: number;
  let nextId: number;

  const matches = (row: Record<string, unknown>, where: object = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const sortRows = (list: Row[], order?: Record<string, string>) => {
    const [key, direction] = Object.entries(order ?? {})[0] ?? [];
    if (!key) {
      return list;
    }
    const sign = direction === 'DESC' ? -1 : 1;
    return [...list].sort(
      (a, b) =>
        sign *
        ((a as any)[key].getTime() - (b as any)[key].getTime() ||
          Number(a.id) - Number(b.id)),
    );
  };

  const addRow = (row: Partial<Row>): Row => {
    clock += 1;
    const created: Row = {
      id: String(nextId++),
      branch_id: '1',
      user_id: COURIER,
      role: 'COURIER',
      isDeleted: false,
      createdAt: new Date(clock),
      updatedAt: new Date(clock),
      ...row,
    };
    rows.push(created);
    return created;
  };

  const persist = (entity: Partial<Row>, tag: string): Row => {
    clock += 1;
    let row = entity.id
      ? rows.find((item) => item.id === entity.id)
      : undefined;
    if (!row) {
      row = {
        id: String(nextId++),
        createdAt: new Date(clock),
        ...entity,
      } as Row;
      rows.push(row);
    }
    Object.assign(row, entity, { updatedAt: new Date(clock) });
    calls.push(
      `${tag}:save:${row.id}@${row.branch_id}:${row.isDeleted ? 'deleted' : 'active'}`,
    );
    return { ...row };
  };

  const findRows = (options: any) =>
    sortRows(
      rows.filter((row) => matches(row, options?.where)),
      options?.order,
    ).map((row) => ({ ...row }));

  const rowOf = (id: string) => rows.find((row) => row.id === id);
  const activeRowsOf = (userId = COURIER) =>
    rows.filter((row) => row.user_id === userId && !row.isDeleted);

  const holdingSends = () =>
    [clients.finance, clients.order, clients.logistics]
      .flatMap((client) => client.send.mock.calls)
      .map(([pattern]) => (pattern as { cmd: string }).cmd)
      .filter((cmd) => HOLDING_CMDS.includes(cmd));
  const closeCalls = () =>
    clients.order.send.mock.calls.filter(
      ([pattern]) => (pattern as { cmd: string }).cmd === CLOSE_CMD,
    );

  /** Oldindan tekshiruvda `first`, qayta tekshiruvda `next`. */
  const firstThen =
    (first: Reply, next: Reply): Reply =>
    (payload) => {
      const round = calls.filter(
        (c) => c === 'send:finance.cashbox.find_by_user',
      ).length;
      return round <= 1 ? first(payload) : next(payload);
    };
  const cashbox =
    (balance: unknown, cash: unknown = balance, card: unknown = 0) =>
    () =>
      of({
        statusCode: 200,
        message: 'Cashbox found',
        data: { balance, balance_cash: cash, balance_card: card },
      });
  const orderCheck =
    (overrides: Record<string, unknown> = {}) =>
    () =>
      of({
        statusCode: 200,
        message: 'Courier transfer check',
        data: { ...CLEAN_ORDER_CHECK, ...overrides },
      });
  const closed = (count: number) => () =>
    of({ statusCode: 200, message: 'ok', data: { closed_count: count } });

  const rpcErrorOf = async (
    promise: Promise<unknown>,
  ): Promise<{ statusCode?: number; message?: string }> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    calls = [];
    rows = [];
    clock = 1_000;
    nextId = 100;

    // Samarqand'da faol menejer bor (o'tkazish maqsadi).
    addRow({ branch_id: '15', user_id: '300', role: 'MANAGER' });
    const identityUsers: Record<
      string,
      { role: string; status: string; isDeleted: boolean }
    > = { '300': { role: 'manager', status: 'active', isDeleted: false } };

    const branches = [HQ, SAMARQAND, BUXORO];
    branchRepo = {
      findOne: jest.fn((options: any) => {
        const branch = branches.find((item) => matches(item, options?.where));
        return Promise.resolve(branch ? { ...branch } : null);
      }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      create: jest.fn((value: unknown) => value),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };

    const txRepo = {
      find: jest.fn((options: any) => {
        calls.push('tx:find');
        return Promise.resolve(findRows(options));
      }),
      save: jest.fn((entity: Partial<Row>) =>
        Promise.resolve(persist(entity, 'tx')),
      ),
      create: jest.fn((value: Partial<Row>) => ({
        isDeleted: false,
        ...value,
      })),
    };
    const entityManager = { getRepository: jest.fn(() => txRepo) };
    branchUserRepo = {
      findOne: jest.fn((options: any) =>
        Promise.resolve(findRows(options)[0] ?? null),
      ),
      find: jest.fn((options: any) => Promise.resolve(findRows(options))),
      save: jest.fn((entity: Partial<Row>) =>
        Promise.resolve(persist(entity, 'repo')),
      ),
      create: jest.fn((value: Partial<Row>) => ({
        isDeleted: false,
        ...value,
      })),
      count: jest.fn().mockResolvedValue(0),
      manager: {
        transaction: jest.fn(
          async (work: (em: unknown) => Promise<unknown>) => {
            calls.push('tx:begin');
            const snapshot = rows.map((row) => ({ ...row }));
            try {
              const result = await work(entityManager);
              calls.push('tx:commit');
              return result;
            } catch (error) {
              rows.splice(0, rows.length, ...snapshot);
              calls.push('tx:rollback');
              throw error;
            }
          },
        ),
      },
    };

    replies = {
      'identity.user.find_by_id': ({ id }: { id: string }) =>
        of({
          statusCode: 200,
          data: { id, role: 'courier', region_id: null },
        }),
      'identity.user.find_all': ({ query }: { query: any }) => {
        const ids: string[] = query?.user_ids ?? [];
        const items = ids
          .filter((id) => {
            const user = identityUsers[id];
            return (
              user &&
              !user.isDeleted &&
              (!query?.role || user.role === query.role) &&
              (!query?.status || user.status === query.status)
            );
          })
          .map((id) => ({ id, name: `Menejer ${id}`, ...identityUsers[id] }));
        return of({
          statusCode: 200,
          message: 'success',
          data: { items, meta: { page: 1, limit: 100, total: items.length } },
        });
      },
      'finance.cashbox.find_by_user': cashbox(0),
      'order.courier_transfer_check': orderCheck(),
      [OPEN_RETURN_POSTS_CMD]: () =>
        of({
          statusCode: 200,
          message: 'Kuryerning qabul qilinmagan bekor pochtalari',
          data: [],
        }),
      'identity.courier.set_region': (payload: any) =>
        of({
          statusCode: 200,
          message: 'Kuryer hududi yangilandi',
          data: {
            id: payload.id,
            region_id: payload.region_id,
            previous_region_id: null,
            district_id: null,
          },
        }),
    };
    const makeClient = () => ({
      send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
        calls.push(`send:${pattern.cmd}`);
        const reply = replies[pattern.cmd];
        return reply
          ? reply(payload)
          : throwError(() => ({
              statusCode: 500,
              message: `kutilmagan RPC: ${pattern.cmd}`,
            }));
      }),
    });
    clients = {
      identity: makeClient(),
      logistics: makeClient(),
      order: makeClient(),
      file: makeClient(),
      finance: makeClient(),
    };

    const activityLog = {
      log: jest.fn((entry: { action: string; entity_id: string }) => {
        calls.push(`log:${entry.action}:${entry.entity_id}`);
        return Promise.resolve();
      }),
      logChange: jest.fn().mockResolvedValue(undefined),
    };

    service = new BranchServiceService(
      branchRepo,
      branchUserRepo,
      {} as any,
      clients.identity as any,
      clients.logistics as any,
      clients.order as any,
      clients.file as any,
      clients.finance as any,
      { get: jest.fn((_key: string, fallback?: string) => fallback) } as any,
      activityLog as any,
    );
    jest
      .spyOn(service as any, 'waitBeforeCourierTransferRecheck')
      .mockImplementation(() => {
        calls.push('wait');
        return Promise.resolve();
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const remove = () =>
    service.removeUserFromBranch({ branch_id: '15', user_id: COURIER }, SA);
  const transfer = (branchId: string) =>
    service.transferCourierToBranch(
      { user_id: COURIER, branch_id: branchId },
      SA,
    );
  const check = () => service.courierTransferCheck({ user_id: COURIER }, SA);
  /** Birinchi tekshiruvda PENDING = qoldiq, yopilgandan keyin — toza. */
  const carryCoveredThenClean = () => {
    replies['order.courier_transfer_check'] = firstThen(
      orderCheck(CARRY_COVERED),
      orderCheck(),
    );
  };

  it('⭐ chiqarish: PENDING 140 000 = qoldiq 140 000, kassa 0 — yopiladi → qayta tekshiruv toza → qator o`chiriladi (200)', async () => {
    const row = addRow({ branch_id: '15' });
    carryCoveredThenClean();
    replies[CLOSE_CMD] = closed(1);

    const res = await remove();

    expect(res.statusCode).toBe(200);
    expect(rowOf(row.id)?.isDeleted).toBe(true);
    expect(closeCalls()).toEqual([
      [
        { cmd: CLOSE_CMD },
        { courier_id: COURIER, requester: { id: '1', roles: ['superadmin'] } },
      ],
    ]);
    // Tekshiruv ikki marta: yopishdan oldin va keyin.
    expect([...holdingSends()].sort()).toEqual(
      [...HOLDING_CMDS, ...HOLDING_CMDS].sort(),
    );
    const closeAt = calls.indexOf(`send:${CLOSE_CMD}`);
    expect(calls.indexOf('send:order.courier_transfer_check')).toBeLessThan(
      closeAt,
    );
    expect(
      calls.lastIndexOf('send:order.courier_transfer_check'),
    ).toBeGreaterThan(closeAt);
  });

  it("⭐ o'tkazish: oldindan tekshiruvda yopiladi va o'tkazish bajariladi (yopish tranzaksiyadan OLDIN)", async () => {
    addRow({ branch_id: '1' });
    carryCoveredThenClean();
    replies[CLOSE_CMD] = closed(1);

    const res: any = await transfer('15');

    expect(res.statusCode).toBe(200);
    expect(res.data.to_branch_id).toBe('15');
    expect(closeCalls()).toHaveLength(1);
    expect(calls.indexOf(`send:${CLOSE_CMD}`)).toBeLessThan(
      calls.indexOf('tx:begin'),
    );
    expect(activeRowsOf()).toEqual([
      expect.objectContaining({ branch_id: '15', role: 'COURIER' }),
    ]);
  });

  it('tiyinda solishtiriladi: PENDING 140000.004 ≈ qoldiq 140000 (bir xil tiyin) — yopish chaqiriladi', async () => {
    addRow({ branch_id: '15' });
    replies['order.courier_transfer_check'] = firstThen(
      orderCheck({ ...CARRY_COVERED, pending_settlement_amount: 140000.004 }),
      orderCheck(),
    );
    replies[CLOSE_CMD] = closed(1);

    const res = await remove();

    expect(res.statusCode).toBe(200);
    expect(closeCalls()).toHaveLength(1);
  });

  it.each([
    ['yopish rad etildi (closed_count 0, masalan filial mos emas)', closed(0)],
    [
      'RPC xatosi (deploy paytida yo`q)',
      () =>
        throwError(() => ({
          status: 'error',
          message:
            'There is no matching message handler defined in the remote service.',
        })),
    ],
    ['timeout', () => throwError(() => new TimeoutError())],
  ])(
    'chiqarish: %s — AVVALGI 409 (sabablar o`zgarmagan), qayta tekshiruv yo`q, qator saqlanadi',
    async (_label, reply) => {
      const row = addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck(CARRY_COVERED);
      replies[CLOSE_CMD] = reply;

      const err = await rpcErrorOf(remove());

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 409,
          message:
            UNASSIGN_PREFIX +
            [pendingReason('140 000'), carryReason('140 000')].join(' '),
        }),
      );
      expect(rowOf(row.id)?.isDeleted).toBe(false);
      expect(closeCalls()).toHaveLength(1);
      expect(holdingSends()).toEqual(HOLDING_CMDS);
    },
  );

  it("o'tkazish: yopish natija bermasa — 409 TRANSFER prefiksi, tranzaksiya yo'q", async () => {
    addRow({ branch_id: '1' });
    replies['order.courier_transfer_check'] = orderCheck(CARRY_COVERED);
    replies[CLOSE_CMD] = closed(0);

    const err = await rpcErrorOf(transfer('15'));

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(
      TRANSFER_PREFIX +
        [pendingReason('140 000'), carryReason('140 000')].join(' '),
    );
    expect(closeCalls()).toHaveLength(1);
    expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
  });

  it('yopilgandan keyin ham PENDING qolsa (parallel yangi sotuv) — 409, to`siq zaiflashmaydi', async () => {
    const row = addRow({ branch_id: '15' });
    replies['order.courier_transfer_check'] = firstThen(
      orderCheck(CARRY_COVERED),
      orderCheck({
        pending_settlement_count: 1,
        pending_settlement_amount: 75000,
      }),
    );
    replies['finance.cashbox.find_by_user'] = firstThen(
      cashbox(0),
      cashbox(75000),
    );
    replies[CLOSE_CMD] = closed(1);

    const err = await rpcErrorOf(remove());

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(
      UNASSIGN_PREFIX +
        [
          "kuryer qo'lida 75 000 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
          pendingReason('75 000'),
        ].join(' '),
    );
    expect(rowOf(row.id)?.isDeleted).toBe(false);
  });

  it.each([
    [
      'PENDING ≠ qoldiq (140 000 / 135 000)',
      cashbox(0),
      { ...CARRY_COVERED, carry_amount: 135000 },
      [pendingReason('140 000'), carryReason('135 000')],
    ],
    [
      'PENDING ≠ qoldiq 1 tiyinga (140 000 / 139 999,99)',
      cashbox(0),
      { ...CARRY_COVERED, carry_amount: 139999.99 },
      [pendingReason('140 000'), carryReason('139 999,99')],
    ],
    [
      'PENDING = qoldiq, lekin kassada pul bor (5 000)',
      cashbox(5000),
      CARRY_COVERED,
      [
        "kuryer qo'lida 5 000 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
        pendingReason('140 000'),
        carryReason('140 000'),
      ],
    ],
    [
      'PENDING = qoldiq, sof qoldiq 0, lekin naqd 100 / karta 0',
      cashbox(0, 100, 0),
      CARRY_COVERED,
      [
        "kuryer qo'lida 100 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
        pendingReason('140 000'),
        carryReason('140 000'),
      ],
    ],
    [
      'PENDING = qoldiq = manfiy (−5 000)',
      cashbox(0),
      {
        pending_settlement_count: 1,
        pending_settlement_amount: -5000,
        carry_amount: -5000,
      },
      [pendingReason('-5 000')],
    ],
  ])(
    'chiqarish: %s — yopish CHAQIRILMAYDI, 409 sabablari avvalgidek',
    async (_label, cashboxReply, orderOverrides, reasons) => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashboxReply;
      replies['order.courier_transfer_check'] = orderCheck(orderOverrides);

      const err = await rpcErrorOf(remove());

      expect(closeCalls()).toEqual([]);
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(UNASSIGN_PREFIX + reasons.join(' '));
      expect(holdingSends()).toEqual(HOLDING_CMDS);
    },
  );

  it('tekshiruv (GET transfer-check) FAQAT o`qiydi — yopish chaqirilmaydi, sabablar avvalgidek', async () => {
    addRow({ branch_id: '15' });
    replies['order.courier_transfer_check'] = orderCheck(CARRY_COVERED);
    replies[CLOSE_CMD] = closed(1);

    const res: any = await check();

    expect(res.data.can_transfer).toBe(false);
    expect(res.data.reasons).toEqual([
      pendingReason('140 000'),
      carryReason('140 000'),
    ]);
    expect(closeCalls()).toEqual([]);
  });

  it('yetim kuryerni biriktirish (rehome) — yopish chaqirilmaydi (avvalgidek)', async () => {
    addRow({ branch_id: '16', isDeleted: true });
    replies['order.courier_transfer_check'] = orderCheck(CARRY_COVERED);
    replies[CLOSE_CMD] = closed(1);

    const err = await rpcErrorOf(
      service.assignUserToBranch({ branch_id: '15', user_id: COURIER }, SA),
    );

    expect(err.statusCode).toBe(409);
    expect(closeCalls()).toEqual([]);
  });

  it('C8 regressiya: PENDING 0 = qoldiq 0 (sof-nol) — avvalgidek yopiladi', async () => {
    const row = addRow({ branch_id: '15' });
    replies['order.courier_transfer_check'] = firstThen(
      orderCheck({ pending_settlement_count: 2, pending_settlement_amount: 0 }),
      orderCheck(),
    );
    replies[CLOSE_CMD] = closed(2);

    const res = await remove();

    expect(res.statusCode).toBe(200);
    expect(rowOf(row.id)?.isDeleted).toBe(true);
    expect(closeCalls()).toHaveLength(1);
  });
});
