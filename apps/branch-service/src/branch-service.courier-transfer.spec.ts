import { RpcException } from '@nestjs/microservices';
import { NEVER, Observable, of, Subject, throwError, TimeoutError } from 'rxjs';
import { QueryFailedError } from 'typeorm';
import { BranchServiceService } from './branch-service.service';

/**
 * R3 — kuryer filialdan filialga FAQAT qo'lida pul ham, buyurtma ham
 * qolmaganda o'tkaziladi.
 *
 * Garnitura: branch_users uchun xotiradagi jadval (find nusxa qaytaradi,
 * save id bo'yicha yozadi), tranzaksiya xatoda holatni qaytaradi (rollback).
 * RPC javoblari `cmd` bo'yicha. Qayta tekshiruvdan oldingi 1,5 s kutish stub.
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
const PICKUP = {
  id: '17',
  name: 'Chilonzor PVZ',
  code: 'PVZ',
  type: 'PICKUP',
  status: 'active',
  region_id: '1',
  isDeleted: false,
};
const INACTIVE = {
  id: '18',
  name: 'Yopilgan filial',
  code: 'OLD',
  type: 'REGIONAL',
  status: 'inactive',
  region_id: '9',
  isDeleted: false,
};
const NO_MANAGER = {
  id: '19',
  name: 'Navoiy',
  code: 'NAV',
  type: 'REGIONAL',
  status: 'active',
  region_id: '10',
  isDeleted: false,
};

const SA = { id: '1', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };
const MANAGER_REQUESTER = { id: '300', roles: ['manager'] };

const COURIER = '263';
const CLEAN_ORDER_CHECK = {
  courier_id: COURIER,
  pending_settlement_count: 0,
  pending_settlement_amount: 0,
  carry_amount: 0,
  orders_in_hand: 0,
  orders_sample: [],
  pending_extra_cost_approvals: 0,
};
const OPEN_RETURN_POSTS_CMD = 'logistics.post.open_return_posts_for_courier';
const HOLDING_CMDS = [
  'finance.cashbox.find_by_user',
  'order.courier_transfer_check',
  OPEN_RETURN_POSTS_CMD,
];
const NO_ACTIVE_MANAGER_SAMARQAND =
  "'Samarqand' filialida faol menejer yo'q — kuryer pulini qabul qiladigan odam bo'lmaydi. Avval filialga menejer biriktiring";

const UNAVAILABLE =
  "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi (xizmat javob bermadi). Birozdan so'ng qayta urinib ko'ring.";
const TRANSFER_PREFIX = "Kuryerni boshqa filialga o'tkazib bo'lmaydi: ";
const UNASSIGN_PREFIX = "Kuryerni filialdan chiqarib bo'lmaydi: ";
const REHOME_PREFIX = "Kuryerni boshqa filialga biriktirib bo'lmaydi: ";
const REVERTED_PREFIX =
  "Kuryer o'tkazilmadi — o'tkazish paytida kuryerda yangi buyurtma yoki pul paydo bo'ldi, o'zgarish bekor qilindi: ";

describe('BranchServiceService — kuryerni filialdan filialga o`tkazish (R3)', () => {
  let service: BranchServiceService;
  let calls: string[];
  let rows: Row[];
  let replies: Record<string, Reply>;
  let branchRepo: any;
  let branchUserRepo: any;
  let txRepo: any;
  let activityLog: any;
  let clients: Record<
    'identity' | 'logistics' | 'order' | 'file' | 'finance',
    { send: jest.Mock }
  >;
  /** Identity'dagi kuryer yozuvi (rol va hudud). */
  let courierUser: { role: string; region_id: string | null };
  /**
   * Identity'dagi menejerlar (identity.user.find_all javobi shundan, identity
   * filtrlari bilan: o'chirilmagan, role, status, user_ids).
   */
  let identityUsers: Record<
    string,
    { role: string; status: string; isDeleted: boolean }
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
  const setRegionCalls = () =>
    clients.identity.send.mock.calls.filter(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === 'identity.courier.set_region',
    );
  const managerLookups = () =>
    clients.identity.send.mock.calls.filter(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === 'identity.user.find_all',
    );

  /**
   * Oldindan tekshiruvda `first`, qayta tekshiruvda `next`. Tekshiruv raundi
   * finance so'rovlari soni bilan aniqlanadi: uch manba parallel yuboriladi,
   * finance birinchi.
   */
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
  /** Har pochtaning order_quantity si — o'zining CANCELLED_SENT soni. */
  const openReturnPosts = (posts: unknown) => () =>
    of({
      statusCode: 200,
      message: 'Kuryerning qabul qilinmagan bekor pochtalari',
      data: posts,
    });
  const fail = (error: unknown) => () => throwError(() => error);

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
    calls = [];
    rows = [];
    clock = 1_000;
    nextId = 100;
    courierUser = { role: 'courier', region_id: null };

    // Menejerlar: Samarqand va Buxoro'da bor, Navoiy'da yo'q.
    addRow({ branch_id: '15', user_id: '300', role: 'MANAGER' });
    addRow({ branch_id: '16', user_id: '301', role: 'MANAGER' });
    identityUsers = {
      '300': { role: 'manager', status: 'active', isDeleted: false },
      '301': { role: 'manager', status: 'active', isDeleted: false },
    };

    const branches = [HQ, SAMARQAND, BUXORO, PICKUP, INACTIVE, NO_MANAGER];
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

    txRepo = {
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
          data: {
            id,
            role: courierUser.role,
            region_id: courierUser.region_id,
          },
        }),
      // identity findAllAdmins kabi: o'chirilganlar chiqmaydi, role/status
      // va user_ids filtrlari qo'llanadi.
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
      [OPEN_RETURN_POSTS_CMD]: openReturnPosts([]),
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

    activityLog = {
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
      activityLog,
    );
    jest
      .spyOn(service as any, 'waitBeforeCourierTransferRecheck')
      .mockImplementation(() => {
        calls.push('wait');
        return Promise.resolve();
      });
  });

  const check = (requester: object = SA, userId: string = COURIER) =>
    service.courierTransferCheck({ user_id: userId }, requester);
  const transfer = (branchId: string, requester: object = SA) =>
    service.transferCourierToBranch(
      { user_id: COURIER, branch_id: branchId },
      requester,
    );

  // ------------------------------------------------------------------ HOLDINGS
  describe("kuryer qo'lidagi pul va buyurtmalar (tekshiruv)", () => {
    it("finance 404 (yuqori darajada) — kassa yo'q, sabab yo'q", async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = fail({
        statusCode: 404,
        message: 'Cashbox not found',
      });

      const res: any = await check();

      expect(res.data.has_cashbox).toBe(false);
      expect(res.data.balance).toBe(0);
      expect(res.data.reasons).toEqual([]);
      expect(res.data.can_transfer).toBe(true);
    });

    it.each([
      ['finance timeout', 'finance.cashbox.find_by_user', new TimeoutError()],
      [
        'finance 500',
        'finance.cashbox.find_by_user',
        { statusCode: 500, message: 'db down' },
      ],
      [
        'order xatosi',
        'order.courier_transfer_check',
        { statusCode: 500, message: 'x' },
      ],
      [
        "order: deploy paytida RPC yo'q",
        'order.courier_transfer_check',
        {
          status: 'error',
          message:
            'There is no matching message handler defined in the remote service.',
        },
      ],
      ['logistics xatosi', OPEN_RETURN_POSTS_CMD, new Error('socket hang up')],
      [
        'logistics 503 (bekor pochtalarni tekshirib bo`lmadi)',
        OPEN_RETURN_POSTS_CMD,
        {
          statusCode: 503,
          message:
            "Bekor qilingan pochtalarni tekshirib bo'lmadi — birozdan so'ng qayta urinib ko'ring",
        },
      ],
      [
        "logistics: deploy paytida yangi RPC hali yo'q",
        OPEN_RETURN_POSTS_CMD,
        {
          status: 'error',
          message:
            'There is no matching message handler defined in the remote service.',
        },
      ],
    ])('%s — 503, xato xabari aniq', async (_label, cmd, error) => {
      addRow({ branch_id: '15' });
      replies[cmd] = fail(error);

      const err = await rpcErrorOf(check());

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
    });

    it.each([
      [
        "finance data yo'q",
        'finance.cashbox.find_by_user',
        of({ statusCode: 200 }),
      ],
      [
        'finance balans son emas',
        'finance.cashbox.find_by_user',
        of({ data: { balance: 'abc', balance_cash: 0, balance_card: 0 } }),
      ],
      [
        "finance naqd/karta maydoni yo'q",
        'finance.cashbox.find_by_user',
        of({ data: { balance: 0 } }),
      ],
      [
        "order data yo'q",
        'order.courier_transfer_check',
        of({ statusCode: 200 }),
      ],
      [
        "order orders_in_hand yo'q",
        'order.courier_transfer_check',
        of({ data: { ...CLEAN_ORDER_CHECK, orders_in_hand: undefined } }),
      ],
      [
        'logistics massiv emas',
        OPEN_RETURN_POSTS_CMD,
        of({ data: { items: [] } }),
      ],
      [
        "logistics order_quantity yo'q",
        OPEN_RETURN_POSTS_CMD,
        of({ data: [{ id: '88' }] }),
      ],
      [
        'logistics order_quantity manfiy',
        OPEN_RETURN_POSTS_CMD,
        of({ data: [{ id: '88', branch_id: '15', order_quantity: -1 }] }),
      ],
    ])('buzuq javob (%s) — 503 (fail-closed)', async (_label, cmd, reply) => {
      addRow({ branch_id: '15' });
      replies[cmd] = () => reply;

      const err = await rpcErrorOf(check());

      expect(err.statusCode).toBe(503);
    });

    it("HQ kuryeri, 150 000 so'm — Asosiy kassaga qabul qilish", async () => {
      addRow({ branch_id: '1' });
      replies['finance.cashbox.find_by_user'] = cashbox(150000);

      const res: any = await check();

      expect(res.data.can_transfer).toBe(false);
      expect(res.data.reasons).toEqual([
        "kuryer qo'lida 150 000 so'm pul bor — avval uni Asosiy kassaga qabul qiling (To'lovlar → Qabul qilinishi kerak).",
      ]);
    });

    it("filial kuryeri — 'Samarqand' filiali menejeri qabul qiladi (Asosiy kassa EMAS)", async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox(150000);

      const res: any = await check();

      expect(res.data.reasons).toHaveLength(1);
      expect(res.data.reasons[0]).toContain("150 000 so'm");
      expect(res.data.reasons[0]).toContain("'Samarqand' filiali menejeri");
      expect(res.data.reasons[0]).not.toContain('Asosiy kassa');
    });

    it('filialsiz kuryer — administratorga murojaat', async () => {
      addRow({ branch_id: '16', isDeleted: true });
      replies['finance.cashbox.find_by_user'] = cashbox(20000);

      const res: any = await check();

      expect(res.data.current_branch).toBeNull();
      expect(res.data.reasons[0]).toContain(
        'hech qaysi filialga biriktirilmagan',
      );
    });

    it("manfiy balans — kuryerga to'lanishi kerak", async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox(-5000);

      const res: any = await check();

      expect(res.data.reasons).toEqual([
        "kuryer kassasi manfiy (-5 000 so'm) — kuryerga to'lanishi kerak bo'lgan pul bor, avval hisob-kitobni yoping.",
      ]);
    });

    it('tiyin qismi faqat noldan farq qilsa ko`rsatiladi', async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox('1234567.5');

      const res: any = await check();

      expect(res.data.balance).toBe(1234567.5);
      expect(res.data.reasons[0]).toContain("1 234 567,50 so'm");
    });

    it('sof 0 (naqd +100 / karta −100, Click) — ruxsat; naqd 100, karta 0 (sof 0 bo`lsa ham) — blok', async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox(0, 100, -100);
      const allowed: any = await check();
      expect(allowed.data.reasons).toEqual([]);
      expect(allowed.data.can_transfer).toBe(true);

      replies['finance.cashbox.find_by_user'] = cashbox(0, 100, 0);
      const blocked: any = await check();
      expect(blocked.data.can_transfer).toBe(false);
      expect(blocked.data.reasons[0]).toContain(
        "kuryer qo'lida 100 so'm pul bor",
      );
    });

    it("tiyinda solishtiriladi: '0.00' / 0.001 — nol", async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox('0.00', '0.001', 0);

      const res: any = await check();

      expect(res.data.reasons).toEqual([]);
    });

    it("PENDING savdo — '2 ta sotuvi' (summasi bilan; 0 bo'lsa summasiz, kassada pul bo'lsa)", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 2,
        pending_settlement_amount: 240000,
      });
      const withAmount: any = await check();
      expect(withAmount.data.reasons).toEqual([
        "kuryerning 2 ta sotuvi bo'yicha hisob-kitob hali yopilmagan (240 000 so'm). Pul topshirilgan bo'lsa, bir necha soniyadan so'ng qayta tekshiring.",
      ]);

      // PENDING yig'indisi 0, lekin kassada pul bor — pul topshirilsa FIFO
      // qatorlarni yopadi: eski matn (summasiz) to'g'ri.
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 2,
        pending_settlement_amount: 0,
      });
      replies['finance.cashbox.find_by_user'] = cashbox(1000);
      const withoutAmount: any = await check();
      expect(withoutAmount.data.reasons).toEqual([
        "kuryer qo'lida 1 000 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
        "kuryerning 2 ta sotuvi bo'yicha hisob-kitob hali yopilmagan. Pul topshirilgan bo'lsa, bir necha soniyadan so'ng qayta tekshiring.",
      ]);
    });

    it("sof-nol PENDING (yig'indi 0 va kassa 0) — blok qoladi, lekin 'kutib qayta tekshiring' EMAS, haqiqiy yo'l aytiladi", async () => {
      addRow({ branch_id: '15' });
      // Masalan: +25 000 (COD) va −25 000 (onlayn to'langan) qatorlari; kassa 0.
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 2,
        pending_settlement_amount: 0,
      });
      replies['finance.cashbox.find_by_user'] = cashbox('0.00', '0.00', '0.00');

      const res: any = await check();

      expect(res.data.can_transfer).toBe(false);
      // C8: haqiqiy yo'l — filialdan chiqarish/o'tkazish bu qatorlarni yopadi.
      expect(res.data.reasons).toEqual([
        "kuryerning 2 ta sotuvi bo'yicha hisob-kitob ochiq qolgan, lekin ularning jami summasi 0 so'm — kuryerni filialdan chiqarganda yoki boshqa filialga o'tkazganda bu 0 so'mlik yozuvlar avtomatik yopiladi; yopilmasa, tizim administratoriga murojaat qiling.",
      ]);
      expect(res.data.reasons[0]).not.toContain('bir necha soniyadan');
      // Tekshiruv FAQAT o'qiydi — yopish RPC'si chaqirilmaydi.
      expect(calls).not.toContain(
        'send:order.settlement.close_zero_courier_rows',
      );
    });

    it("sof-nol PENDING, kassa yo'q (finance 404) — xuddi shu maxsus sabab", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 1,
        pending_settlement_amount: 0,
      });
      replies['finance.cashbox.find_by_user'] = fail({
        statusCode: 404,
        message: 'Cashbox not found',
      });

      const res: any = await check();

      expect(res.data.reasons).toEqual([
        expect.stringContaining(
          "kuryerning 1 ta sotuvi bo'yicha hisob-kitob ochiq qolgan, lekin ularning jami summasi 0 so'm",
        ),
      ]);
    });

    it("PENDING yig'indisi 0, sof qoldiq 0, lekin oyoqlar nol emas (naqd 100, karta 0) — pul sababi + eski matn", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 1,
        pending_settlement_amount: 0,
      });
      replies['finance.cashbox.find_by_user'] = cashbox(0, 100, 0);

      const res: any = await check();

      expect(res.data.reasons).toHaveLength(2);
      expect(res.data.reasons[0]).toContain("kuryer qo'lida 100 so'm pul bor");
      expect(res.data.reasons[1]).toContain('bir necha soniyadan');
    });

    it("PENDING yig'indisi bor (+), kassa 0 (outbox krediti yo'lda) — eski matn summasi bilan", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 1,
        pending_settlement_amount: 25000,
      });

      const res: any = await check();

      expect(res.data.reasons).toEqual([
        "kuryerning 1 ta sotuvi bo'yicha hisob-kitob hali yopilmagan (25 000 so'm). Pul topshirilgan bo'lsa, bir necha soniyadan so'ng qayta tekshiring.",
      ]);
    });

    it('taqsimlanmagan qoldiq — sabab', async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        carry_amount: 5000,
      });

      const res: any = await check();

      expect(res.data.reasons).toEqual([
        "kuryerda taqsimlanmagan qoldiq bor (5 000 so'm) — hisob-kitob yakunlanmagan.",
      ]);
    });

    it("qo'lidagi 7 ta buyurtma, 5 ta namuna — '#101 … va yana 2 ta'", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        orders_in_hand: 7,
        orders_sample: ['101', '102', '103', '104', '105'].map((id) => ({
          id,
          status: 'on the road',
        })),
      });

      const res: any = await check();

      expect(res.data.orders_in_hand).toBe(7);
      expect(res.data.reasons).toEqual([
        "kuryer qo'lida 7 ta yakunlanmagan buyurtma bor (#101, #102, #103, #104, #105 va yana 2 ta) — avval ularni yetkazing yoki filialga qaytaring.",
      ]);
    });

    it("bekor pochta: order_quantity 3 — sabab; 0 (bo'sh qobiq) — sabab yo'q", async () => {
      addRow({ branch_id: '15' });
      replies[OPEN_RETURN_POSTS_CMD] = openReturnPosts([
        { id: '88', branch_id: '15', order_quantity: 3 },
        { id: '89', branch_id: '15', order_quantity: 0 },
      ]);

      const res: any = await check();

      expect(res.data.open_return_posts).toBe(1);
      expect(res.data.return_posts_sample).toEqual([
        { id: '88', branch_id: '15', order_quantity: 3 },
      ]);
      expect(res.data.reasons).toEqual([
        'kuryer topshirgan 1 ta bekor qilingan pochta hali qabul qilinmagan (#88) — avval filial ularni qabul qilsin.',
      ]);
    });

    it("har pochta O'Z soni bilan (2, 1, 0): N = buyurtmasi bor POCHTALAR (2), sonlar qo'shilmaydi", async () => {
      addRow({ branch_id: '15' });
      replies[OPEN_RETURN_POSTS_CMD] = openReturnPosts([
        { id: '90', branch_id: '15', order_quantity: 2 },
        { id: '91', branch_id: null, order_quantity: 1 },
        { id: '92', branch_id: '15', order_quantity: 0 },
      ]);

      const res: any = await check();

      expect(res.data.open_return_posts).toBe(2);
      expect(res.data.return_posts_sample).toEqual([
        { id: '90', branch_id: '15', order_quantity: 2 },
        { id: '91', branch_id: null, order_quantity: 1 },
      ]);
      expect(res.data.reasons).toEqual([
        'kuryer topshirgan 2 ta bekor qilingan pochta hali qabul qilinmagan (#90, #91) — avval filial ularni qabul qilsin.',
      ]);
      // 2 + 1 = 3 — yig'indi hech qayerda chiqmaydi.
      expect(res.data.reasons[0]).not.toContain('3 ta');
    });

    it("hamma pochta bo'sh qobiq (0) — sabab yo'q, o'tkazish mumkin", async () => {
      addRow({ branch_id: '15' });
      replies[OPEN_RETURN_POSTS_CMD] = openReturnPosts([
        { id: '93', branch_id: '15', order_quantity: 0 },
        { id: '94', branch_id: '15', order_quantity: 0 },
      ]);

      const res: any = await check();

      expect(res.data.open_return_posts).toBe(0);
      expect(res.data.return_posts_sample).toEqual([]);
      expect(res.data.reasons).toEqual([]);
      expect(res.data.can_transfer).toBe(true);
    });

    it("ko'rib chiqilmagan qo'shimcha xarajat so'rovi — sabab", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        pending_extra_cost_approvals: 1,
      });

      const res: any = await check();

      expect(res.data.reasons).toEqual([
        "kuryerning 1 ta qo'shimcha xarajat so'rovi hali ko'rib chiqilmagan.",
      ]);
    });

    it('bir nechta sabab — shartnoma tartibida', async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox(1000);
      replies['order.courier_transfer_check'] = orderCheck({
        pending_settlement_count: 1,
        pending_settlement_amount: 1000,
        carry_amount: 500,
        orders_in_hand: 1,
        orders_sample: [{ id: '101', status: 'waiting' }],
        pending_extra_cost_approvals: 1,
      });
      replies[OPEN_RETURN_POSTS_CMD] = openReturnPosts([
        { id: '88', branch_id: '15', order_quantity: 1 },
      ]);

      const res: any = await check();

      expect(res.data.reasons.map((r: string) => r.slice(0, 22))).toEqual([
        "kuryer qo'lida 1 000 s",
        'kuryerning 1 ta sotuvi',
        'kuryerda taqsimlanmaga',
        "kuryer qo'lida 1 ta ya",
        'kuryer topshirgan 1 ta',
        "kuryerning 1 ta qo'shi",
      ]);
    });

    it('logistics — yengil RPC, { courier_id } bilan (eski rejected_for_courier EMAS); finance — kuryer kassasi', async () => {
      addRow({ branch_id: '15' });

      await check();

      expect(clients.logistics.send).toHaveBeenCalledTimes(1);
      expect(clients.logistics.send).toHaveBeenCalledWith(
        { cmd: OPEN_RETURN_POSTS_CMD },
        { courier_id: COURIER },
      );
      expect(calls).not.toContain('send:logistics.post.rejected_for_courier');
      expect(clients.finance.send).toHaveBeenCalledWith(
        { cmd: 'finance.cashbox.find_by_user' },
        { user_id: COURIER, cashbox_type: 'couriers' },
      );
      expect(clients.order.send).toHaveBeenCalledWith(
        { cmd: 'order.courier_transfer_check' },
        { courier_id: COURIER },
      );
    });

    it('logistics javob bermasa — 5 s (boshqa manbalar bilan bir xil) kutiladi, keyin 503', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        addRow({ branch_id: '15' });
        replies[OPEN_RETURN_POSTS_CMD] = () => NEVER;
        let settled = false;
        const outcome = check().then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

        await jest.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        const error = await outcome;

        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toEqual(
          expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ------------------------------------------------------------------ CHECK RPC
  describe('branch.user.courier_transfer_check', () => {
    it.each([
      ['menejer', MANAGER_REQUESTER],
      ['registrator', { id: '269', roles: ['registrator'] }],
      ["so'rovchisiz", undefined],
    ])('%s — 403, hech qanday RPC yo`q', async (_label, requester) => {
      const err = await rpcErrorOf(
        service.courierTransferCheck({ user_id: COURIER }, requester as any),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message:
            "Kuryer o'tkazish tekshiruvini faqat superadmin yoki admin ko'ra oladi",
        }),
      );
      expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    });

    it("user_id noto'g'ri — 400", async () => {
      const err = await rpcErrorOf(check(SA, 'abc'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "user_id noto'g'ri",
        }),
      );
    });

    it('kuryer emas — 400', async () => {
      courierUser.role = 'manager';

      const err = await rpcErrorOf(check());

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message:
            "Bu foydalanuvchi kuryer emas — filialdan filialga faqat kuryer o'tkaziladi",
        }),
      );
      expect(holdingSends()).toEqual([]);
    });

    it("identity 404 — 'Kuryer topilmadi'; identity timeout — 503", async () => {
      replies['identity.user.find_by_id'] = fail({
        statusCode: 404,
        message: 'User topilmadi',
      });
      expect(await rpcErrorOf(check())).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Kuryer topilmadi',
        }),
      );

      replies['identity.user.find_by_id'] = fail(new TimeoutError());
      expect(await rpcErrorOf(check())).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
    });

    it('toza HQ kuryeri — 200, can_transfer true, joriy filial va HQ', async () => {
      addRow({ branch_id: '1' });

      const res: any = await check(ADMIN);

      expect(res.statusCode).toBe(200);
      expect(res.message).toBe("Kuryer o'tkazish tekshiruvi");
      expect(res.data).toEqual({
        user_id: COURIER,
        current_branch: { id: '1', name: 'HQ Toshkent', type: 'HQ' },
        hq_branch: { id: '1', name: 'HQ Toshkent' },
        has_cashbox: true,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
        pending_settlement_count: 0,
        pending_settlement_amount: 0,
        carry_amount: 0,
        orders_in_hand: 0,
        orders_sample: [],
        open_return_posts: 0,
        return_posts_sample: [],
        pending_extra_cost_approvals: 0,
        reasons: [],
        can_transfer: true,
      });
    });

    it("to'siqlar xato EMAS — 200, can_transfer false va sabablar", async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck({
        orders_in_hand: 1,
        orders_sample: [{ id: '101', status: 'on the road' }],
      });

      const res: any = await check();

      expect(res.statusCode).toBe(200);
      expect(res.data.can_transfer).toBe(false);
      expect(res.data.current_branch).toEqual({
        id: '15',
        name: 'Samarqand',
        type: 'REGIONAL',
      });
      expect(res.data.reasons).toHaveLength(1);
    });

    it('manba javob bermasa — 503', async () => {
      addRow({ branch_id: '15' });
      replies[OPEN_RETURN_POSTS_CMD] = fail(new TimeoutError());

      const err = await rpcErrorOf(check());

      expect(err.statusCode).toBe(503);
    });

    it('xom baza xatosi ham RpcException 503 (RMQ qayta navbatga qo`ymaydi)', async () => {
      branchUserRepo.findOne.mockRejectedValue(
        new Error('connection terminated'),
      );

      const err = await rpcErrorOf(check());

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
    });
  });

  // ------------------------------------------------------------------ REMOVE
  describe('removeUserFromBranch — kuryer qatori himoyalangan', () => {
    const remove = (userId = COURIER, branchId = '15') =>
      service.removeUserFromBranch(
        { branch_id: branchId, user_id: userId },
        SA,
      );

    it("toza kuryer — qator o'chiriladi, UNASSIGN yoziladi", async () => {
      const row = addRow({ branch_id: '15' });

      const res = await remove();

      expect(res.statusCode).toBe(200);
      expect(rowOf(row.id)?.isDeleted).toBe(true);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'BranchUser',
          entity_id: '15',
          action: 'unassign',
          metadata: { user_id: COURIER },
        }),
      );
      expect(holdingSends()).toEqual(HOLDING_CMDS);
    });

    it('pul bor — 409 UNASSIGN prefiksi bilan, qator saqlanmaydi', async () => {
      const row = addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = cashbox(150000);

      const err = await rpcErrorOf(remove());

      expect(err.statusCode).toBe(409);
      expect(err.message?.startsWith(UNASSIGN_PREFIX)).toBe(true);
      expect(err.message).toContain("'Samarqand' filiali menejeri");
      expect(branchUserRepo.save).not.toHaveBeenCalled();
      expect(rowOf(row.id)?.isDeleted).toBe(false);
    });

    it('finance timeout — 503, qator saqlanmaydi', async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = fail(new TimeoutError());

      const err = await rpcErrorOf(remove());

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
      expect(branchUserRepo.save).not.toHaveBeenCalled();
    });

    it.each([['REGISTRATOR'], ['MANAGER']])(
      '%s qatori — tekshiruv yo`q, avvalgidek o`chiriladi',
      async (role) => {
        const row = addRow({ branch_id: '15', user_id: '777', role });

        const res = await remove('777');

        expect(res.statusCode).toBe(200);
        expect(rowOf(row.id)?.isDeleted).toBe(true);
        expect(holdingSends()).toEqual([]);
      },
    );
  });

  // ------------------------------------------------------------------ ASSIGN
  describe('assignUserToBranch — yetim kuryerni boshqa filialga biriktirish', () => {
    const assign = (branchId = '15') =>
      service.assignUserToBranch({ branch_id: branchId, user_id: COURIER }, SA);

    it("qatori yo'q kuryer (yaratish saga'si) — tashqi tekshiruv yo'q, 201", async () => {
      const res = await assign();

      expect(res.statusCode).toBe(201);
      expect(holdingSends()).toEqual([]);
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15', role: 'COURIER' }),
      ]);
    });

    it("oldin boshqa filialda bo'lgan, pul bor — 409 REHOME prefiksi, saqlanmaydi", async () => {
      addRow({ branch_id: '16', isDeleted: true });
      replies['finance.cashbox.find_by_user'] = cashbox(150000);

      const err = await rpcErrorOf(assign());

      expect(err.statusCode).toBe(409);
      expect(err.message?.startsWith(REHOME_PREFIX)).toBe(true);
      expect(err.message).toContain('hech qaysi filialga biriktirilmagan');
      expect(branchUserRepo.save).not.toHaveBeenCalled();
    });

    it("oldin boshqa filialda bo'lgan, toza — biriktiriladi (201)", async () => {
      addRow({ branch_id: '16', isDeleted: true });

      const res = await assign();

      expect(res.statusCode).toBe(201);
      expect(holdingSends()).toEqual(HOLDING_CMDS);
    });

    it("faqat shu filialdagi o'chirilgan qator — tashqi chaqiruvsiz tiklanadi", async () => {
      const row = addRow({ branch_id: '15', isDeleted: true });

      const res = await assign();

      expect(res.statusCode).toBe(200);
      expect(rowOf(row.id)?.isDeleted).toBe(false);
      expect(holdingSends()).toEqual([]);
    });

    it('tekshiruv manbasi javob bermasa — 503, saqlanmaydi', async () => {
      addRow({ branch_id: '16', isDeleted: true });
      replies['order.courier_transfer_check'] = fail(new TimeoutError());

      const err = await rpcErrorOf(assign());

      expect(err.statusCode).toBe(503);
      expect(branchUserRepo.save).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ TRANSFER
  describe('branch.user.transfer_courier', () => {
    it("baxtli yo'l: qulf, AVVAL eski qator o'chadi, keyin yangisi; hudud; audit", async () => {
      const oldRow = addRow({ branch_id: '1' });

      const startedAt = Date.now();
      const res: any = await transfer('15');
      const finishedAt = Date.now();

      expect(res).toEqual({
        statusCode: 200,
        message: "Kuryer 'Samarqand' filialiga o'tkazildi",
        data: {
          user_id: COURIER,
          from_branch_id: '1',
          to_branch_id: '15',
          region_id: '7',
        },
      });
      expect(txRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: COURIER },
          lock: { mode: 'pessimistic_write' },
        }),
      );
      const txSaves = calls.filter((c) => c.startsWith('tx:save'));
      expect(txSaves).toHaveLength(2);
      expect(txSaves[0]).toBe(`tx:save:${oldRow.id}@1:deleted`);
      expect(txSaves[1]).toMatch(/^tx:save:\d+@15:active$/);
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15', role: 'COURIER' }),
      ]);

      expect(setRegionCalls()).toEqual([
        [
          { cmd: 'identity.courier.set_region' },
          {
            id: COURIER,
            region_id: '7',
            requester: SA,
            deadline_at: expect.any(Number),
          },
        ],
      ]);
      // deadline_at = yuborish vaqti + 5 s (set_region timeout'i).
      const { deadline_at: deadlineAt } = setRegionCalls()[0][1] as {
        deadline_at: number;
      };
      expect(deadlineAt).toBeGreaterThanOrEqual(startedAt + 5000);
      expect(deadlineAt).toBeLessThanOrEqual(finishedAt + 5000);
      // Maqsad filialning FAOL menejeri — bitta identity so'rovida.
      expect(managerLookups()).toEqual([
        [
          { cmd: 'identity.user.find_all' },
          {
            query: {
              user_ids: ['300'],
              role: 'manager',
              status: 'active',
              page: 1,
              limit: 100,
            },
          },
        ],
      ]);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'BranchUser',
          entity_id: '1',
          action: 'unassign',
          metadata: expect.objectContaining({
            user_id: COURIER,
            reason: 'courier_transfer',
            to_branch_id: '15',
          }),
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'BranchUser',
          entity_id: '15',
          action: 'assign',
          metadata: expect.objectContaining({
            user_id: COURIER,
            reason: 'courier_transfer',
            from_branch_id: '1',
          }),
        }),
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_type: 'User',
          entity_id: COURIER,
          action: 'courier_transfer',
          old_value: { branch_id: '1' },
          new_value: { branch_id: '15', region_id: '7' },
          user_id: '1',
        }),
      );
    });

    it("HQ'ga o'tkazish — hudud null yuboriladi (menejer talab qilinmaydi)", async () => {
      addRow({ branch_id: '15' });

      const res: any = await transfer('1', ADMIN);

      expect(res.data).toEqual(
        expect.objectContaining({ to_branch_id: '1', region_id: null }),
      );
      expect(setRegionCalls()[0][1]).toEqual({
        id: COURIER,
        region_id: null,
        requester: ADMIN,
        deadline_at: expect.any(Number),
      });
      // HQ'da menejer bo'lmaydi — identity'dan menejer so'ralmaydi.
      expect(managerLookups()).toEqual([]);
    });

    it("maqsad filialdagi o'chirilgan qator tiklanadi (COURIER), create chaqirilmaydi", async () => {
      addRow({ branch_id: '1' });
      const oldTargetRow = addRow({
        branch_id: '15',
        isDeleted: true,
        role: 'REGISTRATOR',
      });

      await transfer('15');

      expect(txRepo.create).not.toHaveBeenCalled();
      expect(rowOf(oldTargetRow.id)).toEqual(
        expect.objectContaining({ isDeleted: false, role: 'COURIER' }),
      );
      expect(activeRowsOf()).toHaveLength(1);
    });

    it("'015' kabi id kanonik ko'rinishga keltiriladi", async () => {
      addRow({ branch_id: '1' });

      const res: any = await service.transferCourierToBranch(
        { user_id: '0263', branch_id: '015' },
        SA,
      );

      expect(res.data).toEqual(
        expect.objectContaining({ user_id: COURIER, to_branch_id: '15' }),
      );
    });

    describe("allaqachon shu filialda — 409, tranzaksiya yo'q", () => {
      it("hudud mos — set_region ham yo'q", async () => {
        addRow({ branch_id: '15' });
        courierUser.region_id = '7';

        const err = await rpcErrorOf(transfer('15'));

        expect(err).toEqual(
          expect.objectContaining({
            statusCode: 409,
            message: 'Kuryer allaqachon shu filialda',
          }),
        );
        expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
        expect(setRegionCalls()).toEqual([]);
        expect(holdingSends()).toEqual([]);
      });

      it('hudud farq qiladi (swap yozilib, set_region yetmay qolgan) — qayta moslanadi, baribir 409', async () => {
        addRow({ branch_id: '15' });
        courierUser.region_id = '3';

        const err = await rpcErrorOf(transfer('15'));

        expect(err.statusCode).toBe(409);
        expect(setRegionCalls()).toEqual([
          [
            { cmd: 'identity.courier.set_region' },
            { id: COURIER, region_id: '7', requester: SA },
          ],
        ]);
        // Qayta moslash MUDDATSIZ: yoziladigan qiymat — to'g'ri yakuniy holat.
        expect(setRegionCalls()[0][1]).not.toHaveProperty('deadline_at');
        expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
        // Hech narsa ko'chmaydi — faol menejer ham so'ralmaydi.
        expect(managerLookups()).toEqual([]);
      });

      it('qayta moslash yiqilsa ham — faqat log, javob 409', async () => {
        addRow({ branch_id: '15' });
        courierUser.region_id = null;
        replies['identity.courier.set_region'] = fail(new TimeoutError());

        const err = await rpcErrorOf(transfer('15'));

        expect(err).toEqual(
          expect.objectContaining({
            statusCode: 409,
            message: 'Kuryer allaqachon shu filialda',
          }),
        );
      });
    });

    it.each([
      [
        'menejer so`rovchi — 403',
        () => transfer('15', MANAGER_REQUESTER),
        403,
        "Kuryerni boshqa filialga faqat superadmin yoki admin o'tkaza oladi",
      ],
      [
        "user_id noto'g'ri — 400",
        () =>
          service.transferCourierToBranch(
            { user_id: '26a', branch_id: '15' },
            SA,
          ),
        400,
        "user_id noto'g'ri",
      ],
      [
        "branch_id noto'g'ri — 400",
        () =>
          service.transferCourierToBranch(
            { user_id: COURIER, branch_id: '1.5' },
            SA,
          ),
        400,
        "branch_id noto'g'ri",
      ],
      [
        "noma'lum filial — 404 o'zbekcha",
        () => transfer('404'),
        404,
        'Tanlangan filial topilmadi',
      ],
      [
        'nofaol filial — 400',
        () => transfer('18'),
        400,
        "Yangi filial faol emas — nofaol filialga kuryer o'tkazib bo'lmaydi",
      ],
      [
        'PICKUP — 400',
        () => transfer('17'),
        400,
        "Kuryer faqat HQ, REGIONAL yoki HYBRID filialga o'tkaziladi (tanlangan filial turi: PICKUP)",
      ],
      [
        'menejersiz REGIONAL — 400',
        () => transfer('19'),
        400,
        "'Navoiy' filialida menejer yo'q — kuryer pulini qabul qiladigan odam bo'lmaydi. Avval filialga menejer biriktiring",
      ],
    ])('%s', async (_label, run, statusCode, message) => {
      addRow({ branch_id: '1' });

      const err = await rpcErrorOf(run());

      expect(err).toEqual(expect.objectContaining({ statusCode, message }));
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
      expect(holdingSends()).toEqual([]);
      // Menejer qatori umuman yo'q bo'lsa ham identity'ga murojaat yo'q.
      expect(managerLookups()).toEqual([]);
    });

    // -------------------------------------------- W2-MCR-01: FAOL menejer
    describe("maqsad filialning FAOL menejeri (identity) — o'chirilgan/bloklangan menejer qatori yetarli emas", () => {
      it.each([
        [
          "o'chirilgan (DELETE /users/:id — qator qolib ketgan)",
          { isDeleted: true },
        ],
        ['bloklangan (status inactive)', { status: 'inactive' }],
      ])(
        'yagona menejer %s — 400 "faol menejer yo\'q"; tranzaksiya va hudud yo\'q',
        async (_label, change) => {
          addRow({ branch_id: '1' });
          Object.assign(identityUsers['300'], change);

          const err = await rpcErrorOf(transfer('15'));

          expect(err).toEqual(
            expect.objectContaining({
              statusCode: 400,
              message: NO_ACTIVE_MANAGER_SAMARQAND,
            }),
          );
          expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
          expect(setRegionCalls()).toEqual([]);
          expect(activeRowsOf()).toEqual([
            expect.objectContaining({ branch_id: '1' }),
          ]);
        },
      );

      it("bir nechta qator: o'chirilgan menejer + faol menejer — o'tadi; o'chirilgan branch_users qatori so'ralmaydi", async () => {
        addRow({ branch_id: '1' });
        identityUsers['300'].isDeleted = true;
        addRow({ branch_id: '15', user_id: '302', role: 'MANAGER' });
        addRow({
          branch_id: '15',
          user_id: '303',
          role: 'MANAGER',
          isDeleted: true,
        });
        identityUsers['302'] = {
          role: 'manager',
          status: 'active',
          isDeleted: false,
        };

        const res: any = await transfer('15');

        expect(res.statusCode).toBe(200);
        const [[, payload]] = managerLookups();
        expect(
          [
            ...(payload as { query: { user_ids: string[] } }).query.user_ids,
          ].sort(),
        ).toEqual(['300', '302']);
      });

      it("identity filtrni e'tiborsiz qoldirsa ham (bloklangan menejer qaytsa) — faol hisoblanmaydi, 400", async () => {
        addRow({ branch_id: '1' });
        replies['identity.user.find_all'] = () =>
          of({
            statusCode: 200,
            data: {
              items: [
                { id: '300', role: 'manager', status: 'inactive' },
                // So'ralmagan foydalanuvchi ham hisoblanmaydi.
                { id: '999', role: 'manager', status: 'active' },
              ],
            },
          });

        const err = await rpcErrorOf(transfer('15'));

        expect(err).toEqual(
          expect.objectContaining({
            statusCode: 400,
            message: NO_ACTIVE_MANAGER_SAMARQAND,
          }),
        );
        expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
      });

      it.each([
        ['timeout', fail(new TimeoutError())],
        ['500', fail({ statusCode: 500, message: 'db down' })],
        [
          "deploy paytida RPC yo'q",
          fail({
            status: 'error',
            message:
              'There is no matching message handler defined in the remote service.',
          }),
        ],
        [
          'buzuq javob (items massiv emas)',
          () => of({ data: { items: null } }),
        ],
        ["buzuq javob (data yo'q)", () => of({ statusCode: 200 })],
      ])(
        'identity %s — 503 CHECK_UNAVAILABLE (soxta "menejer yo\'q" 400 EMAS); tranzaksiya yo\'q',
        async (_label, reply) => {
          addRow({ branch_id: '1' });
          replies['identity.user.find_all'] = reply;

          const err = await rpcErrorOf(transfer('15'));

          expect(err).toEqual(
            expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
          );
          expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
          expect(setRegionCalls()).toEqual([]);
        },
      );

      it("menejer tekshiruvi oldindan tekshiruv bilan PARALLEL: identity javob bermay turganda uch manba allaqachon so'ralgan", async () => {
        addRow({ branch_id: '1' });
        const managers = new Subject<unknown>();
        replies['identity.user.find_all'] = () => managers;

        const pending = transfer('15');
        for (let i = 0; i < 10; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        expect(managerLookups()).toHaveLength(1);
        expect(holdingSends()).toEqual(HOLDING_CMDS);
        expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();

        managers.next({
          statusCode: 200,
          data: { items: [{ id: '300', role: 'manager', status: 'active' }] },
        });
        managers.complete();
        const res: any = await pending;

        expect(res.statusCode).toBe(200);
      });

      it("xato ustuvorligi: faol menejer yo'q (400) kuryer to'sig'idan (409) oldin", async () => {
        addRow({ branch_id: '1' });
        identityUsers['300'].status = 'inactive';
        replies['finance.cashbox.find_by_user'] = cashbox(150000);

        const err = await rpcErrorOf(transfer('15'));

        expect(err).toEqual(
          expect.objectContaining({
            statusCode: 400,
            message: NO_ACTIVE_MANAGER_SAMARQAND,
          }),
        );
      });

      it("faol menejer bor, kuryerda pul bor — 409 TRANSFER (menejer tekshiruvi to'siqni yashirmaydi)", async () => {
        addRow({ branch_id: '1' });
        replies['finance.cashbox.find_by_user'] = cashbox(150000);

        const err = await rpcErrorOf(transfer('15'));

        expect(err.statusCode).toBe(409);
        expect(err.message?.startsWith(TRANSFER_PREFIX)).toBe(true);
        expect(managerLookups()).toHaveLength(1);
      });
    });

    it('kuryer emas — 400; tranzaksiya yo`q', async () => {
      courierUser.role = 'registrator';

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(400);
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it("oldindan tekshiruvda to'siq — 409 TRANSFER prefiksi, tranzaksiya yo'q", async () => {
      addRow({ branch_id: '1' });
      replies['finance.cashbox.find_by_user'] = cashbox(150000);

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(
        TRANSFER_PREFIX +
          "kuryer qo'lida 150 000 so'm pul bor — avval uni Asosiy kassaga qabul qiling (To'lovlar → Qabul qilinishi kerak).",
      );
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
      expect(setRegionCalls()).toEqual([]);
    });

    it("oldindan tekshiruv manbasi javob bermasa — 503, tranzaksiya yo'q", async () => {
      addRow({ branch_id: '1' });
      replies[OPEN_RETURN_POSTS_CMD] = fail(new TimeoutError());

      const err = await rpcErrorOf(transfer('15'));

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it("tranzaksiya ichida faol qator o'zgargan — 409 ROW_CHANGED, hech narsa saqlanmaydi", async () => {
      const oldRow = addRow({ branch_id: '1' });
      txRepo.find.mockImplementationOnce(() =>
        Promise.resolve([
          { ...oldRow, isDeleted: true },
          { ...oldRow, id: '777', branch_id: '16', isDeleted: false },
        ]),
      );

      const err = await rpcErrorOf(transfer('15'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 409,
          message:
            "Kuryerning filiali shu paytda o'zgardi — sahifani yangilab, qayta urinib ko'ring",
        }),
      );
      expect(txRepo.save).not.toHaveBeenCalled();
      expect(setRegionCalls()).toEqual([]);
    });

    it("qayta tekshiruvda yangi buyurtma — qaytariladi (AVVAL yangi qator o'chadi, keyin eski tiklanadi), 409 REVERTED, set_region YO'Q", async () => {
      const oldRow = addRow({ branch_id: '1' });
      replies['order.courier_transfer_check'] = firstThen(
        orderCheck(),
        orderCheck({
          orders_in_hand: 1,
          orders_sample: [{ id: '5001', status: 'on the road' }],
        }),
      );

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(
        REVERTED_PREFIX +
          "kuryer qo'lida 1 ta yakunlanmagan buyurtma bor (#5001) — avval ularni yetkazing yoki filialga qaytaring.",
      );
      const txSaves = calls.filter((c) => c.startsWith('tx:save'));
      expect(txSaves).toHaveLength(4);
      expect(txSaves[0]).toBe(`tx:save:${oldRow.id}@1:deleted`);
      expect(txSaves[1]).toMatch(/^tx:save:(\d+)@15:active$/);
      const newRowId = /^tx:save:(\d+)@15/.exec(txSaves[1])?.[1];
      expect(txSaves[2]).toBe(`tx:save:${newRowId}@15:deleted`);
      expect(txSaves[3]).toBe(`tx:save:${oldRow.id}@1:active`);
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ id: oldRow.id, branch_id: '1' }),
      ]);
      expect(setRegionCalls()).toEqual([]);
      expect(calls).toContain(`log:courier_transfer_reverted:${COURIER}`);
      expect(calls).not.toContain(`log:courier_transfer:${COURIER}`);
    });

    it('qayta tekshiruvda pul paydo bo`ldi — sabab ESKI filial bo`yicha (pulni eski filial oladi)', async () => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = firstThen(
        cashbox(0),
        cashbox(50000),
      );

      const err = await rpcErrorOf(transfer('16'));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("'Samarqand' filiali menejeri");
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15' }),
      ]);
    });

    it('qayta tekshiruv manbasi javob bermasa — qaytariladi, 503', async () => {
      const oldRow = addRow({ branch_id: '1' });
      replies['finance.cashbox.find_by_user'] = firstThen(
        cashbox(0),
        fail(new TimeoutError()),
      );

      const err = await rpcErrorOf(transfer('15'));

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 503, message: UNAVAILABLE }),
      );
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ id: oldRow.id, branch_id: '1' }),
      ]);
      expect(setRegionCalls()).toEqual([]);
    });

    it('hudud yangilanmasa — qaytariladi, eski filial hududi tiklashga urinadi, 503 REGION_SYNC_FAILED', async () => {
      const oldRow = addRow({ branch_id: '15' });
      replies['identity.courier.set_region'] = fail(new TimeoutError());

      const err = await rpcErrorOf(transfer('16'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Kuryer hududini yangilab bo'lmadi — o'tkazish bekor qilindi. Birozdan so'ng qayta urinib ko'ring",
        }),
      );
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ id: oldRow.id, branch_id: '15' }),
      ]);
      const [forward, restorePayload] = setRegionCalls().map(
        ([, payload]) => payload as Record<string, unknown>,
      );
      expect(setRegionCalls()).toHaveLength(2);
      // Oldinga: muddat bilan (identity muddatdan keyin yozmaydi).
      expect(forward).toEqual({
        id: COURIER,
        region_id: '8',
        requester: SA,
        deadline_at: expect.any(Number),
      });
      // Tiklash: eski filial hududi, MUDDATSIZ.
      expect(restorePayload).toEqual({
        id: COURIER,
        region_id: '7',
        requester: SA,
      });
      expect(restorePayload).not.toHaveProperty('deadline_at');
      // Tartib: yangi hudud → qaytarish tranzaksiyasi → eski hudud.
      const firstSetRegion = calls.indexOf('send:identity.courier.set_region');
      const revertCommit = calls.lastIndexOf('tx:commit');
      const restore = calls.lastIndexOf('send:identity.courier.set_region');
      expect(firstSetRegion).toBeLessThan(revertCommit);
      expect(revertCommit).toBeLessThan(restore);
    });

    it("tiklash identity'dagi kuryer hududiga EMAS, eski filial hududiga (hudud filialga ergashadi); HQ'dan — null", async () => {
      // Identity'da eski ma'lumot: kuryer HQ'da, lekin hududi '5'.
      addRow({ branch_id: '1' });
      courierUser.region_id = '5';
      // Birinchi (oldinga) set_region yiqiladi, tiklash o'tadi.
      let setRegionAttempts = 0;
      replies['identity.courier.set_region'] = (payload: any) => {
        setRegionAttempts += 1;
        return setRegionAttempts === 1
          ? throwError(() => new TimeoutError())
          : of({ statusCode: 200, data: payload });
      };

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(503);
      expect(setRegionCalls()[1][1]).toEqual({
        id: COURIER,
        region_id: null,
        requester: SA,
      });
    });

    it("filialsiz kuryer — o'tkaziladi (from_branch_id null)", async () => {
      addRow({ branch_id: '16', isDeleted: true });

      const res: any = await transfer('15');

      expect(res.data.from_branch_id).toBeNull();
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15' }),
      ]);
      expect(calls).not.toContain('log:unassign:16');
    });

    it("filialsiz kuryer qaytarilsa — faqat yangi qator o'chadi; hudud identity'da o'tkazishdan OLDIN o'qilgan qiymatga tiklanadi (muddatsiz)", async () => {
      const oldRow = addRow({ branch_id: '16', isDeleted: true });
      // Filialsiz kuryerning identity'dagi hududi (o'chirilgan filialdan qolgan).
      courierUser.region_id = '8';
      replies['identity.courier.set_region'] = fail(new TimeoutError());

      const err = await rpcErrorOf(transfer('15'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Kuryer hududini yangilab bo'lmadi — o'tkazish bekor qilindi. Birozdan so'ng qayta urinib ko'ring",
        }),
      );
      expect(activeRowsOf()).toEqual([]);
      expect(rowOf(oldRow.id)?.isDeleted).toBe(true);
      // Ikki set_region: yiqilgan oldinga (7, muddat bilan) va tiklash (8).
      expect(setRegionCalls().map(([, payload]) => payload)).toEqual([
        {
          id: COURIER,
          region_id: '7',
          requester: SA,
          deadline_at: expect.any(Number),
        },
        { id: COURIER, region_id: '8', requester: SA },
      ]);
      expect(setRegionCalls()[1][1]).not.toHaveProperty('deadline_at');
    });

    it('filialsiz, hududsiz kuryer — tiklash null yuboradi', async () => {
      addRow({ branch_id: '16', isDeleted: true });
      courierUser.region_id = null;
      replies['identity.courier.set_region'] = fail(new TimeoutError());

      await rpcErrorOf(transfer('15'));

      expect(setRegionCalls()).toHaveLength(2);
      expect(setRegionCalls()[1][1]).toEqual({
        id: COURIER,
        region_id: null,
        requester: SA,
      });
    });

    it("tiklashning o'zi yiqilsa ham — faqat log, javob baribir 503 REGION_SYNC_FAILED", async () => {
      addRow({ branch_id: '15' });
      replies['identity.courier.set_region'] = fail({
        statusCode: 409,
        message: "Kuryer hududini yangilash muddati o'tdi — hudud o'zgarmadi",
      });

      const err = await rpcErrorOf(transfer('16'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Kuryer hududini yangilab bo'lmadi — o'tkazish bekor qilindi. Birozdan so'ng qayta urinib ko'ring",
        }),
      );
      expect(setRegionCalls()).toHaveLength(2);
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15' }),
      ]);
    });

    it('tartib: commit → kutish → qayta tekshiruv → hudud', async () => {
      addRow({ branch_id: '1' });

      await transfer('15');

      const commit = calls.indexOf('tx:commit');
      const wait = calls.indexOf('wait');
      const recheck = calls.lastIndexOf('send:finance.cashbox.find_by_user');
      const firstCheck = calls.indexOf('send:finance.cashbox.find_by_user');
      const setRegion = calls.indexOf('send:identity.courier.set_region');
      expect(firstCheck).toBeLessThan(calls.indexOf('tx:begin'));
      expect(commit).toBeGreaterThan(-1);
      expect(commit).toBeLessThan(wait);
      expect(wait).toBeLessThan(recheck);
      expect(recheck).toBeLessThan(setRegion);
    });

    it('tranzaksiyadagi 23505 (QueryFailedError) — RpcException 503, qator holati qaytadi', async () => {
      const oldRow = addRow({ branch_id: '1' });
      let saves = 0;
      txRepo.save.mockImplementation((entity: Partial<Row>) => {
        saves += 1;
        if (saves === 2) {
          return Promise.reject(
            new QueryFailedError(
              'INSERT INTO branch_users ...',
              [],
              Object.assign(
                new Error(
                  'duplicate key value violates unique constraint "IDX_BRANCH_USER_USER_UNIQUE_ACTIVE"',
                ),
                { code: '23505' },
              ),
            ),
          );
        }
        return Promise.resolve(persist(entity, 'tx'));
      });

      const err = await rpcErrorOf(transfer('15'));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Kuryerni o'tkazishda ma'lumotlar bazasi xatosi — o'tkazish bajarilmadi. Qayta urinib ko'ring",
        }),
      );
      expect(calls).toContain('tx:rollback');
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ id: oldRow.id, branch_id: '1' }),
      ]);
      expect(calls).not.toContain('wait');
    });

    it("qaytarishning o'zi yiqilsa — 500 'administrator tekshirishi kerak'", async () => {
      addRow({ branch_id: '1' });
      replies['order.courier_transfer_check'] = firstThen(
        orderCheck(),
        orderCheck({ orders_in_hand: 1, orders_sample: [{ id: '5001' }] }),
      );
      const realTransaction = branchUserRepo.manager.transaction;
      let transactions = 0;
      branchUserRepo.manager.transaction = jest.fn((work: any) => {
        transactions += 1;
        if (transactions === 2) {
          return Promise.reject(
            new Error('connection terminated unexpectedly'),
          );
        }
        return realTransaction(work);
      });

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(500);
      expect(err.message).toBe(
        `Kuryerni oldingi filialiga qaytarib bo'lmadi — administrator tekshirishi kerak (kuryer #${COURIER})`,
      );
      expect(calls).toContain(`log:courier_transfer_revert_failed:${COURIER}`);
    });

    it("swap'dan oldingi xom baza xatosi — RpcException 503 (qayta navbat yo'q)", async () => {
      addRow({ branch_id: '1' });
      branchRepo.findOne.mockRejectedValueOnce(new Error('connection reset'));

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(503);
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------ C8 (CODE-06)
  /**
   * fix3 C8 — sof-nol PENDING qatorlar (yig'indi, kassa va qoldiq aynan 0)
   * o'tkazish va filialdan chiqarishni abadiy to'smaydi: branch-service
   * `order.settlement.close_zero_courier_rows` ni best-effort chaqiradi va
   * tekshiruvni qayta bajaradi. RPC'ni A4 parallel quradi — bu yerda mock.
   */
  describe("C8 — sof-nol PENDING qatorlarni yopish (o'tkazish / chiqarish)", () => {
    const CLOSE_CMD = 'order.settlement.close_zero_courier_rows';
    const NET_ZERO = {
      pending_settlement_count: 2,
      pending_settlement_amount: 0,
    };
    const closeCalls = () =>
      clients.order.send.mock.calls.filter(
        ([pattern]) => (pattern as { cmd: string }).cmd === CLOSE_CMD,
      );
    const remove = (requester: object = SA) =>
      service.removeUserFromBranch(
        { branch_id: '15', user_id: COURIER },
        requester,
      );
    /** Birinchi tekshiruvda sof-nol, keyingilarida — toza. */
    const netZeroThenClean = () => {
      replies['order.courier_transfer_check'] = firstThen(
        orderCheck(NET_ZERO),
        orderCheck(),
      );
    };

    it('chiqarish: yopiladi → qayta tekshiruv toza → qator o`chiriladi (200)', async () => {
      const row = addRow({ branch_id: '15' });
      netZeroThenClean();
      replies[CLOSE_CMD] = () =>
        of({ statusCode: 200, message: 'ok', data: { closed_count: 2 } });

      const res = await remove();

      expect(res.statusCode).toBe(200);
      expect(rowOf(row.id)?.isDeleted).toBe(true);
      expect(closeCalls()).toEqual([
        [
          { cmd: CLOSE_CMD },
          {
            courier_id: COURIER,
            requester: { id: '1', roles: ['superadmin'] },
          },
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

    it.each([
      [
        'RPC xatosi (deploy paytida yo`q)',
        () =>
          throwError(() => ({
            status: 'error',
            message:
              'There is no matching message handler defined in the remote service.',
          })),
      ],
      [
        'RPC 409 (qatorlar sof-nol emas)',
        () => throwError(() => ({ statusCode: 409, message: 'not zero' })),
      ],
      ['timeout', () => throwError(() => new TimeoutError())],
    ])(
      'chiqarish: yopish muvaffaqiyatsiz (%s) — avvalgi 409, qator saqlanadi, qayta tekshiruv yo`q',
      async (_label, reply) => {
        const row = addRow({ branch_id: '15' });
        replies['order.courier_transfer_check'] = orderCheck(NET_ZERO);
        replies[CLOSE_CMD] = reply;

        const err = await rpcErrorOf(remove());

        expect(err.statusCode).toBe(409);
        expect(err.message?.startsWith(UNASSIGN_PREFIX)).toBe(true);
        expect(err.message).toContain("jami summasi 0 so'm");
        expect(rowOf(row.id)?.isDeleted).toBe(false);
        expect(closeCalls()).toHaveLength(1);
        expect(holdingSends()).toEqual(HOLDING_CMDS);
      },
    );

    it('chiqarish: closed_count 0 — qayta tekshiruvsiz 409', async () => {
      addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck(NET_ZERO);
      replies[CLOSE_CMD] = () =>
        of({ statusCode: 200, data: { closed_count: 0 } });

      const err = await rpcErrorOf(remove());

      expect(err.statusCode).toBe(409);
      expect(holdingSends()).toEqual(HOLDING_CMDS);
    });

    it('chiqarish: yopilgandan keyin ham qator qolsa — 409 (to`siq zaiflashmaydi)', async () => {
      const row = addRow({ branch_id: '15' });
      replies['order.courier_transfer_check'] = orderCheck(NET_ZERO);
      replies[CLOSE_CMD] = () =>
        of({ statusCode: 200, data: { closed_count: 1 } });

      const err = await rpcErrorOf(remove());

      expect(err.statusCode).toBe(409);
      expect(rowOf(row.id)?.isDeleted).toBe(false);
      expect([...holdingSends()].sort()).toEqual(
        [...HOLDING_CMDS, ...HOLDING_CMDS].sort(),
      );
    });

    it.each([
      [
        'kassada pul bor',
        { cashbox: cashbox(1000), check: orderCheck(NET_ZERO) },
      ],
      [
        'PENDING yig`indisi 0 emas',
        {
          cashbox: cashbox(0),
          check: orderCheck({
            pending_settlement_count: 1,
            pending_settlement_amount: 25000,
          }),
        },
      ],
      [
        'taqsimlanmagan qoldiq bor',
        {
          cashbox: cashbox(0),
          check: orderCheck({ ...NET_ZERO, carry_amount: 5000 }),
        },
      ],
      [
        'oyoqlar nol emas (naqd 100)',
        { cashbox: cashbox(0, 100, 0), check: orderCheck(NET_ZERO) },
      ],
      [
        'PENDING qator yo`q',
        {
          cashbox: cashbox(0),
          check: orderCheck({
            orders_in_hand: 1,
            orders_sample: [{ id: '7' }],
          }),
        },
      ],
    ])('sof-nol emas (%s) — yopish chaqirilmaydi', async (_label, setup) => {
      addRow({ branch_id: '15' });
      replies['finance.cashbox.find_by_user'] = setup.cashbox;
      replies['order.courier_transfer_check'] = setup.check;

      await rpcErrorOf(remove());

      expect(closeCalls()).toEqual([]);
    });

    it("o'tkazish: oldindan tekshiruvda yopiladi va o'tkazish bajariladi", async () => {
      addRow({ branch_id: '1' });
      netZeroThenClean();
      replies[CLOSE_CMD] = () =>
        of({ statusCode: 200, data: { closed_count: 2 } });

      const res: any = await transfer('15');

      expect(res.statusCode).toBe(200);
      expect(res.data.to_branch_id).toBe('15');
      expect(closeCalls()).toHaveLength(1);
      expect(closeCalls()[0][1]).toEqual({
        courier_id: COURIER,
        requester: { id: '1', roles: ['superadmin'] },
      });
      // Yopish swap'dan (tranzaksiyadan) OLDIN.
      expect(calls.indexOf(`send:${CLOSE_CMD}`)).toBeLessThan(
        calls.indexOf('tx:begin'),
      );
      expect(activeRowsOf()).toEqual([
        expect.objectContaining({ branch_id: '15', role: 'COURIER' }),
      ]);
    });

    it("o'tkazish: yopish yiqilsa — 409 TRANSFER prefiksi, tranzaksiya yo'q", async () => {
      addRow({ branch_id: '1' });
      replies['order.courier_transfer_check'] = orderCheck(NET_ZERO);
      replies[CLOSE_CMD] = () =>
        throwError(() => ({ statusCode: 500, message: 'db' }));

      const err = await rpcErrorOf(transfer('15'));

      expect(err.statusCode).toBe(409);
      expect(err.message?.startsWith(TRANSFER_PREFIX)).toBe(true);
      expect(branchUserRepo.manager.transaction).not.toHaveBeenCalled();
    });

    it('yetim kuryerni biriktirish (rehome) va tekshiruv — yopish chaqirilmaydi', async () => {
      addRow({ branch_id: '16', isDeleted: true });
      replies['order.courier_transfer_check'] = orderCheck(NET_ZERO);
      replies[CLOSE_CMD] = () =>
        of({ statusCode: 200, data: { closed_count: 2 } });

      const err = await rpcErrorOf(
        service.assignUserToBranch({ branch_id: '15', user_id: COURIER }, SA),
      );
      await check();

      expect(err.statusCode).toBe(409);
      expect(closeCalls()).toEqual([]);
    });
  });
});
