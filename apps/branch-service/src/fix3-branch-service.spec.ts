import { RpcException } from '@nestjs/microservices';
import { NEVER, Observable, of, throwError, TimeoutError } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    Status: {
      ...(actual.Status ?? {}),
      ACTIVE: 'active',
      INACTIVE: 'inactive',
    },
    BranchType: {
      HQ: 'HQ',
      PICKUP: 'PICKUP',
      REGIONAL: 'REGIONAL',
      HYBRID: 'HYBRID',
    },
  };
});

/**
 * fix3 (A6) — branch-service:
 *   C3  (M7/RBAC-07)      menejer kassa doirasi FAQAT o'z filiali;
 *   C12 (CODE-13)         boshqa servis 4xx'i saqlanadi, o'zbekcha matnlar;
 *   C9  (CODE-23)         panelda `stats_unavailable`;
 *   CODE-20               updateBranch kuryer/ochiq ish to'sig'i;
 *   E2E-DISPATCH-SKIP     pochtada yo'q tanlangan id — 409;
 *   LC-13                 hududsiz buyurtma jo'natishi;
 *   LC-02                 pochta faqat bo'sh bo'lsa o'chiriladi;
 *   CODE-07               faol (identity) menejer — jo'natish va ro'yxat.
 */
describe('fix3 — branch-service', () => {
  let service: BranchServiceService;
  let branchRepo: any;
  let branchUserRepo: any;
  let identityClient: { send: jest.Mock };
  let logisticsClient: { send: jest.Mock };
  let orderClient: { send: jest.Mock };
  let fileClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };
  let activityLog: any;

  beforeEach(() => {
    branchRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        };
        return qb;
      }),
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };
    branchUserRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
    };
    identityClient = { send: jest.fn().mockReturnValue(of({ data: null })) };
    logisticsClient = { send: jest.fn().mockReturnValue(of({ data: [] })) };
    orderClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    fileClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    financeClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };

    service = new BranchServiceService(
      branchRepo,
      branchUserRepo,
      {} as any,
      identityClient as any,
      logisticsClient as any,
      orderClient as any,
      fileClient as any,
      financeClient as any,
      { get: jest.fn((_key: string, fallback?: string) => fallback) } as any,
      activityLog,
    );
  });

  const rpcErrorOf = async (
    promise: Promise<unknown>,
  ): Promise<{ statusCode?: number; message?: string; data?: any }> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
        data?: any;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  const cmdsOf = (client: { send: jest.Mock }) =>
    client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

  const ADMIN = { id: '1', roles: ['admin'] };

  // ---------------------------------------------------------------- C3
  describe('C3 — resolveCashboxBranchForManager: FAQAT menejerning o`z filiali', () => {
    const MANAGER = { id: '300', roles: ['manager'] };
    /** user_id → faol branch_users qatorining filiali. */
    let rowsByUser: Record<string, string | undefined>;

    beforeEach(() => {
      rowsByUser = {
        '300': '15', // menejer — Samarqand
        '263': '15', // o'z filiali kuryeri
        '179': '1', // HQ kuryeri
        '400': '5', // ota filial kuryeri
        '501': '25', // bola filial kuryeri
        '15': '1', // id'si filial #15 bilan to'qnashgan HQ kuryeri
      };
      const branches: Record<string, Record<string, unknown>> = {
        '1': { id: '1', type: 'HQ', parent_id: null, isDeleted: false },
        '5': { id: '5', type: 'HYBRID', parent_id: '1', isDeleted: false },
        '15': { id: '15', type: 'REGIONAL', parent_id: '5', isDeleted: false },
        '25': { id: '25', type: 'PICKUP', parent_id: '15', isDeleted: false },
      };
      branchUserRepo.findOne.mockImplementation(({ where }: any) => {
        const branchId = rowsByUser[String(where?.user_id)];
        return Promise.resolve(
          branchId
            ? { user_id: String(where.user_id), branch_id: branchId }
            : null,
        );
      });
      branchRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(branches[String(where?.id)] ?? null),
      );
    });

    const resolve = (requestedId: string, requester: object = MANAGER) =>
      service.resolveCashboxBranchForManager(requestedId, requester);

    it.each([
      ['HQ kuryeri', '179'],
      ['ota filial kuryeri', '400'],
      ['bola filial kuryeri', '501'],
      ['HQ filial id`si', '1'],
      ['ota filial id`si', '5'],
      ['id`si filial #15 ga teng HQ kuryeri (to`qnashuv)', '15'],
      ['biriktirilmagan foydalanuvchi', '999'],
    ])('%s → null (ruxsat yo`q)', async (_label, requestedId) => {
      const res: any = await resolve(requestedId);

      expect(res.statusCode).toBe(200);
      expect(res.data).toBeNull();
    });

    it.each([
      ['o`zi', '300'],
      ['o`z filiali kuryeri', '263'],
    ])('%s → o`z filiali', async (_label, requestedId) => {
      const res: any = await resolve(requestedId);

      expect(res.data).toEqual({ branch_id: '15' });
    });

    it("o'z filial id'si (bunday foydalanuvchi yo'q) → o'z filiali", async () => {
      delete rowsByUser['15'];

      const res: any = await resolve('15');

      expect(res.data).toEqual({ branch_id: '15' });
    });

    it("ota filiallar zanjiri o'qilmaydi (faqat menejer filiali)", async () => {
      await resolve('179');

      const branchLookups = branchRepo.findOne.mock.calls.map(
        ([options]: [{ where: { id: string } }]) => options.where.id,
      );
      expect(branchLookups).toEqual(['15']);
    });

    it('menejer emas → 403 o`zbekcha', async () => {
      const err = await rpcErrorOf(
        resolve('263', { id: '269', roles: ['registrator'] }),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: "So'rovchi filial menejeri emas",
        }),
      );
    });
  });

  // ---------------------------------------------------------------- C12
  describe('C12 — boshqa servis xatolari va o`zbekcha matnlar', () => {
    const findBatch = () => service.findTransferBatchById('601', ADMIN);
    const UNAVAILABLE =
      "Buyurtmalar xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";

    it.each([
      [
        'yuqori darajadagi 404 (RabbitMQ shakli)',
        { statusCode: 404, message: 'Transfer batch not found', data: null },
        404,
        'Transfer batch not found',
      ],
      [
        'yuqori darajadagi 409',
        { statusCode: 409, message: 'Partiya allaqachon qabul qilingan' },
        409,
        'Partiya allaqachon qabul qilingan',
      ],
      [
        'ichki (eski) shakl 403',
        { error: { statusCode: 403, message: ['a', 'b'] } },
        403,
        'a. b',
      ],
      [
        '5xx saqlanadi',
        { statusCode: 503, message: 'db band' },
        503,
        'db band',
      ],
    ])('%s → %s', async (_label, failure, status, message) => {
      orderClient.send.mockReturnValue(throwError(() => failure));

      const err = await rpcErrorOf(findBatch());

      expect(err).toEqual(
        expect.objectContaining({ statusCode: status, message }),
      );
    });

    it.each([
      ['timeout', new TimeoutError()],
      ['mahalliy Error', new Error('socket hang up')],
      [
        "statusCode'siz javob (no matching handler)",
        {
          status: 'error',
          message:
            'There is no matching message handler defined in the remote service.',
        },
      ],
      ['200 statusli "xato"', { statusCode: 200, message: 'ok' }],
    ])(
      '%s → 502 o`zbekcha "xizmati javob bermadi"',
      async (_label, failure) => {
        orderClient.send.mockReturnValue(throwError(() => failure));

        const err = await rpcErrorOf(findBatch());

        expect(err).toEqual(
          expect.objectContaining({ statusCode: 502, message: UNAVAILABLE }),
        );
      },
    );

    it('findTransferBatchByToken: 4xx endi xom qayta otilmaydi (RpcException, status saqlanadi)', async () => {
      orderClient.send.mockReturnValue(
        throwError(() => ({ statusCode: 404, message: 'QR topilmadi' })),
      );

      const err = await rpcErrorOf(
        service.findTransferBatchByToken('BTB-x', ADMIN),
      );

      expect(err).toEqual(
        expect.objectContaining({ statusCode: 404, message: 'QR topilmadi' }),
      );
    });

    it("filial topilmasa — 404 'Filial topilmadi'", async () => {
      const err = await rpcErrorOf(service.findBranchById('77', ADMIN));

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Filial topilmadi',
        }),
      );
    });

    it("ota filial topilmasa — 404 'Ota filial topilmadi'", async () => {
      const err = await rpcErrorOf(
        service.createBranch(
          { name: 'Yangi', type: 'REGIONAL', code: 'NEW', parent_id: '77' },
          ADMIN,
        ),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Ota filial topilmadi',
        }),
      );
    });

    it("aylanma ota filial — FE 'aylanma' bo'yicha ota filial maydoniga bog'laydi", async () => {
      branchRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.id === '20'
            ? {
                id: '20',
                type: 'REGIONAL',
                status: 'active',
                parent_id: '1',
                region_id: null,
                isDeleted: false,
              }
            : where?.id === '30'
              ? { id: '30', parent_id: '20', isDeleted: false }
              : null,
        ),
      );

      const err = await rpcErrorOf(
        service.updateBranch('20', { parent_id: '30' }, ADMIN),
      );

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('aylanma');
    });

    it.each([['MANAGER', 'Foydalanuvchi boshqa filialga biriktirilgan']])(
      'boshqa filialdagi %s → 409 o`zbekcha',
      async (_role, message) => {
        branchRepo.findOne.mockResolvedValue({
          id: '20',
          type: 'REGIONAL',
          status: 'active',
          isDeleted: false,
        });
        identityClient.send.mockReturnValue(
          of({ data: { id: '9', role: 'manager' } }),
        );
        branchUserRepo.findOne.mockResolvedValue({
          id: 'bu',
          branch_id: '30',
          user_id: '9',
        });

        const err = await rpcErrorOf(
          service.assignUserToBranch({ branch_id: '20', user_id: '9' }, ADMIN),
        );

        expect(err.statusCode).toBe(409);
        expect(err.message).toContain(message);
      },
    );
  });

  // ---------------------------------------------------------------- C9
  describe('C9 — filial paneli: stats_unavailable', () => {
    const stats = () => ({
      today_orders_count: 3,
      week_orders_count: 5,
      selected_orders_count: 3,
      active_batches_count: 0,
      orders_card: {
        total: 3,
        new: 1,
        on_the_road: 1,
        delivered: 1,
        returned: 0,
        cancelled: 0,
      },
      markets: [],
      packages: { on_the_way: 0, waiting_for_acceptance: 0 },
      active_couriers: 1,
    });

    beforeEach(() => {
      branchRepo.findOne.mockResolvedValue({ id: '15', isDeleted: false });
      branchRepo.manager.query.mockResolvedValue([{ id: '15' }]);
      identityClient.send.mockReturnValue(of({ data: { items: [] } }));
    });

    const dashboardCalls = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) =>
          (pattern as { cmd: string }).cmd ===
          'order.analytics.branch_dashboard',
      );

    it("muvaffaqiyat — stats_unavailable: false, raqamlar o'zgarmaydi", async () => {
      orderClient.send.mockReturnValue(of(stats()));

      const res: any = await service.getBranchStats('15', ADMIN);

      expect(res.data.stats_unavailable).toBe(false);
      expect(res.data.today_orders_count).toBe(3);
      expect(dashboardCalls()).toHaveLength(1);
    });

    it.each([
      ['order-service xatosi', () => throwError(() => new Error('down'))],
      ['4xx', () => throwError(() => ({ statusCode: 400, message: 'x' }))],
      ['buzuq javob', () => of({ data: { foo: 1 } })],
      ['data null', () => of({ data: null })],
    ])(
      '%s — stats_unavailable: true, nol shakl saqlanadi',
      async (_label, reply) => {
        orderClient.send.mockImplementation(reply);

        const res: any = await service.getBranchStats('15', ADMIN);

        expect(res.statusCode).toBe(200);
        expect(res.data.stats_unavailable).toBe(true);
        expect(res.data.today_orders_count).toBe(0);
        expect(res.data.cards.orders).toEqual({
          total: 0,
          new: 0,
          on_the_road: 0,
          delivered: 0,
          returned: 0,
          cancelled: 0,
        });
        expect(res.data.cards.markets).toEqual([]);
      },
    );

    it('order-service javob bermasa — 4 s da (analytics 5 s budjetidan oldin) stats_unavailable', async () => {
      jest.useFakeTimers();
      try {
        orderClient.send.mockReturnValue(NEVER as Observable<unknown>);
        let settled: any = null;
        const pending = service.getBranchStats('15', ADMIN).then((res) => {
          settled = res;
          return res;
        });

        await jest.advanceTimersByTimeAsync(3999);
        expect(settled).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        const res: any = await pending;

        expect(res.data.stats_unavailable).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------- CODE-20
  describe('CODE-20 — updateBranch: kuryer va ochiq ishlar to`sig`i', () => {
    let couriers: number;
    let openWork: unknown;

    beforeEach(() => {
      couriers = 0;
      openWork = of({ data: { active_orders: 0, active_batches: 0 } });
      branchRepo.findOne.mockImplementation(({ where }: any) => {
        if (where?.id === '20') {
          return Promise.resolve({
            id: '20',
            name: 'Samarqand',
            type: 'REGIONAL',
            status: 'active',
            region_id: '7',
            parent_id: '1',
            level: 1,
            isDeleted: false,
          });
        }
        if (where?.id === '1') {
          return Promise.resolve({
            id: '1',
            type: 'HQ',
            parent_id: null,
            level: 0,
            isDeleted: false,
          });
        }
        return Promise.resolve(null);
      });
      branchUserRepo.count.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.role === 'COURIER' ? couriers : 0),
      );
      orderClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
        cmd === 'order.branch_can_delete' ? openWork : of({ data: {} }),
      );
    });

    const update = (dto: Record<string, unknown>) =>
      service.updateBranch('20', dto, ADMIN);

    it.each([
      [
        "turini PICKUP'ga",
        { type: 'PICKUP' },
        "filial turini PICKUP ga o'zgartirib bo'lmaydi",
      ],
      [
        'nofaol qilish',
        { status: 'inactive' },
        "filialni nofaol qilib bo'lmaydi",
      ],
      ['hududini', { region_id: '9' }, "filial hududini o'zgartirib bo'lmaydi"],
    ])(
      'kuryer bor — %s o`zgartirish 409, saqlanmaydi',
      async (_label, dto, part) => {
        couriers = 2;

        const err = await rpcErrorOf(update(dto));

        expect(err.statusCode).toBe(409);
        expect(err.message).toContain('Filialga 2 ta kuryer biriktirilgan');
        expect(err.message).toContain(part);
        expect(branchRepo.save).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["turini PICKUP'ga", { type: 'PICKUP' }],
      ['nofaol qilish', { status: 'inactive' }],
    ])(
      'kuryer yo`q, lekin yakunlanmagan buyurtma bor — %s 409',
      async (_label, dto) => {
        openWork = of({ data: { active_orders: 3, active_batches: 1 } });

        const err = await rpcErrorOf(update(dto));

        expect(err.statusCode).toBe(409);
        expect(err.message).toContain(
          'Filialda 3 ta yakunlanmagan buyurtma va 1 ta faol partiya bor',
        );
        expect(branchRepo.save).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['xato', throwError(() => new Error('down'))],
      ['buzuq javob', of({ data: null })],
    ])(
      'ochiq ishlarni tekshirib bo`lmasa (%s) — 503, saqlanmaydi',
      async (_label, reply) => {
        openWork = reply;

        const err = await rpcErrorOf(update({ status: 'inactive' }));

        expect(err.statusCode).toBe(503);
        expect(branchRepo.save).not.toHaveBeenCalled();
      },
    );

    it("kuryer yo'q — hudud o'zgaradi (order-service so'ralmaydi)", async () => {
      const res: any = await update({ region_id: '9' });

      expect(res.statusCode).toBe(200);
      expect(res.data.region_id).toBe('9');
      expect(cmdsOf(orderClient)).not.toContain('order.branch_can_delete');
    });

    it.each([
      ['REGIONAL → HYBRID', { type: 'HYBRID' }],
      ['faqat nom', { name: 'Samarqand markaz' }],
      ['hudud o`sha qiymat', { region_id: '7' }],
      ['holat o`sha qiymat', { status: 'active' }],
    ])(
      'kuryer bor, lekin xavfsiz o`zgarish (%s) — saqlanadi',
      async (_label, dto) => {
        couriers = 2;

        const res: any = await update(dto);

        expect(res.statusCode).toBe(200);
        expect(branchRepo.save).toHaveBeenCalled();
        expect(cmdsOf(orderClient)).not.toContain('order.branch_can_delete');
      },
    );
  });

  // ------------------------------------------------- dispatch (bir nechta)
  describe('dispatchPostToBranch — E2E-DISPATCH-SKIP, LC-13, LC-02, CODE-07', () => {
    const branchesById: Record<string, Record<string, unknown>> = {
      '10': { id: '10', type: 'HQ', status: 'active', isDeleted: false },
      '20': {
        id: '20',
        name: 'Samarqand',
        type: 'REGIONAL',
        status: 'active',
        isDeleted: false,
      },
    };
    const hqOrder = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      branch_id: '10',
      status: 'received',
      region_id: '14',
      total_price: 100000,
      courier_id: null,
      holder_courier_id: null,
      ...extra,
    });

    let postRow: Record<string, unknown>;
    let postOrders: Array<Record<string, unknown>>;
    let managerRows: Array<Record<string, unknown>>;
    let identityUsers: Record<string, Record<string, unknown>>;
    let identityReply: ((payload: any) => Observable<unknown>) | null;
    let recheckReply: Observable<unknown>;

    beforeEach(() => {
      postRow = { id: '48', courier_id: '0', status: 'new', region_id: '14' };
      postOrders = ['56', '57', '58'].map((id) => hqOrder(id));
      managerRows = [{ branch_id: '20', user_id: '198', role: 'MANAGER' }];
      identityUsers = {
        '198': { id: '198', role: 'manager', status: 'active' },
      };
      identityReply = null;
      recheckReply = of({ data: [], total: 0 });

      branchRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(branchesById[String(where?.id)] ?? null),
      );
      branchUserRepo.find.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.role === 'MANAGER'
            ? managerRows.filter(
                (row) => row.branch_id === String(where?.branch_id),
              )
            : [],
        ),
      );
      // identity findAllAdmins kabi: o'chirilganlar chiqmaydi; role/status
      // filtrlari qo'llanadi.
      identityClient.send.mockImplementation(
        ({ cmd }: { cmd: string }, payload: any) => {
          if (cmd !== 'identity.user.find_all') {
            return of({ data: null });
          }
          if (identityReply) {
            return identityReply(payload);
          }
          const query = payload?.query ?? {};
          const items = (query.user_ids ?? [])
            .map((id: string) => identityUsers[id])
            .filter(
              (user: Record<string, unknown> | undefined) =>
                user &&
                user.isDeleted !== true &&
                (!query.role || user.role === query.role) &&
                (!query.status || user.status === query.status),
            );
          return of({ data: { items } });
        },
      );
      logisticsClient.send.mockImplementation(
        ({ cmd }: { cmd: string }, payload: any) => {
          if (cmd === 'logistics.post.find_by_ids') {
            return of({ data: [postRow] });
          }
          if (cmd === 'logistics.post.orders_by_post') {
            return of({ data: { allOrdersByPostId: postOrders } });
          }
          if (cmd === 'logistics.post.receive_orders') {
            return of({
              data: (payload?.orders ?? []).map((row: any) => ({
                order_id: row.order_id,
                post_id: '777',
              })),
            });
          }
          return of({ data: {} });
        },
      );
      orderClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
        cmd === 'order.find_all' ? recheckReply : of({ data: {} }),
      );
    });

    const dispatch = (orderIds: string[]) =>
      service.dispatchPostToBranch('10', '48', '20', orderIds, ADMIN);
    const updatedIds = () =>
      orderClient.send.mock.calls
        .filter(
          ([pattern]) => (pattern as { cmd: string }).cmd === 'order.update',
        )
        .map(([, payload]) => (payload as { id: string }).id);
    const receivePayload = () =>
      logisticsClient.send.mock.calls.find(
        ([pattern]) =>
          (pattern as { cmd: string }).cmd === 'logistics.post.receive_orders',
      )?.[1] as { orders: Array<Record<string, unknown>> } | undefined;
    const expectNothingWritten = () => {
      expect(cmdsOf(logisticsClient)).not.toContain(
        'logistics.post.receive_orders',
      );
      expect(cmdsOf(logisticsClient)).not.toContain('logistics.post.delete');
      expect(updatedIds()).toEqual([]);
    };

    // ------------------------------------------ E2E-DISPATCH-SKIP
    it('tanlangan id pochtada yo`q (jonli: 56..58 + 64) — 409, id xabarda, hech narsa ko`chmaydi', async () => {
      const err = await rpcErrorOf(dispatch(['56', '57', '58', '64']));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain(
        "Tanlangan 1 ta buyurtma bu pochtada yo'q: #64",
      );
      expect(err.message).toContain("Hech narsa jo'natilmadi");
      expect(err.message).not.toContain('#56');
      expect(err.data).toEqual(
        expect.objectContaining({ missing_order_ids: ['64'] }),
      );
      expectNothingWritten();
    });

    it("tanlanganlarning hech biri pochtada yo'q — 409 (avval nomsiz 400 edi)", async () => {
      const err = await rpcErrorOf(dispatch(['90', '91']));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('Tanlangan 2 ta buyurtma');
      expect(err.message).toContain('#90, #91');
      expectNothingWritten();
    });

    it("id'lar kanonik va takrorsiz solishtiriladi ('056' = '56')", async () => {
      const res: any = await dispatch(['056', '57', '57', '58']);

      expect(res.statusCode).toBe(200);
      expect(res.data.selected_order_ids).toEqual(['56', '57', '58']);
      expect(res.data.moved_order_ids).toEqual(['56', '57', '58']);
      expect(updatedIds()).toEqual(['56', '57', '58']);
    });

    // ------------------------------------------ LC-13
    it('hududsiz buyurtma — manba pochta hududi bilan jo`natiladi', async () => {
      postOrders = [hqOrder('56', { region_id: null }), hqOrder('57')];

      const res: any = await dispatch(['56', '57']);

      expect(res.statusCode).toBe(200);
      expect(receivePayload()?.orders).toEqual([
        expect.objectContaining({ order_id: '56', assigned_region: '14' }),
        expect.objectContaining({ order_id: '57', assigned_region: '14' }),
      ]);
    });

    it("buyurtmada ham, pochtada ham hudud yo'q — 400 id bilan, HECH NARSA yozilmaydi", async () => {
      postRow = { ...postRow, region_id: null };
      postOrders = [hqOrder('56', { region_id: null }), hqOrder('57')];

      const err = await rpcErrorOf(dispatch(['56', '57']));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain(
        '1 ta buyurtmaning hududi (viloyati) aniqlanmadi: #56',
      );
      expect(err.data.regionless_order_ids).toEqual(['56']);
      expectNothingWritten();
    });

    // ------------------------------------------ LC-09
    describe('LC-09 — pochta hududi', () => {
      afterEach(() => {
        delete branchesById['20'].region_id;
      });

      it('manzil filial boshqa hududda — 400, buyurtmalar o`qilmaydi, hech narsa yozilmaydi', async () => {
        branchesById['20'].region_id = '15';

        const err = await rpcErrorOf(dispatch(['56', '57', '58']));

        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('Pochta #48 boshqa hudud uchun');
        expect(err.message).toContain("Hech narsa jo'natilmadi");
        expect(err.data).toEqual(
          expect.objectContaining({
            post_region_id: '14',
            destination_region_id: '15',
          }),
        );
        expect(cmdsOf(logisticsClient)).not.toContain(
          'logistics.post.orders_by_post',
        );
        expectNothingWritten();
      });

      it("manzil filial pochta hududida — jo'natiladi", async () => {
        branchesById['20'].region_id = '14';

        const res: any = await dispatch(['56', '57', '58']);

        expect(res.statusCode).toBe(200);
        expect(updatedIds()).toEqual(['56', '57', '58']);
      });

      it('SENT pochta MANBA pochta hududi bo`yicha (tumani boshqa hududga o`tkazilgan buyurtma)', async () => {
        postOrders = [hqOrder('56', { region_id: '9' }), hqOrder('57')];

        const res: any = await dispatch(['56', '57']);

        expect(res.statusCode).toBe(200);
        expect(receivePayload()?.orders).toEqual([
          expect.objectContaining({ order_id: '56', assigned_region: '14' }),
          expect.objectContaining({ order_id: '57', assigned_region: '14' }),
        ]);
      });

      it("manba pochtada hudud yo'q — buyurtma hududi olinadi, hudud tekshiruvi o'tkazib yuboriladi", async () => {
        postRow = { ...postRow, region_id: null };
        branchesById['20'].region_id = '15';
        postOrders = [hqOrder('56', { region_id: '9' })];

        const res: any = await dispatch(['56']);

        expect(res.statusCode).toBe(200);
        expect(receivePayload()?.orders).toEqual([
          expect.objectContaining({ order_id: '56', assigned_region: '9' }),
        ]);
      });
    });

    // ------------------------------------------ LC-02
    it("hamma buyurtma ko'chdi va pochta bo'sh — pochta o'chiriladi (tekshiruv update'lardan KEYIN)", async () => {
      const res: any = await dispatch(['56', '57', '58']);

      expect(res.data.post_deleted).toBe(true);
      expect(cmdsOf(logisticsClient)).toContain('logistics.post.delete');
      const orderCmds = cmdsOf(orderClient);
      expect(orderCmds.indexOf('order.find_all')).toBeGreaterThan(
        orderCmds.lastIndexOf('order.update'),
      );
      expect(orderClient.send).toHaveBeenCalledWith(
        { cmd: 'order.find_all' },
        { query: { post_id: '48', page: 1, limit: 1 } },
      );
    });

    it.each([
      [
        'parallel qabul yangi buyurtma qo`shdi',
        of({ data: [{ id: '99' }], total: 1 }),
      ],
      ['qayta tekshiruv xatosi', throwError(() => new Error('down'))],
      ['tushunarsiz javob', of({ data: {} })],
    ])("%s — pochta O'CHIRILMAYDI", async (_label, reply) => {
      recheckReply = reply;

      const res: any = await dispatch(['56', '57', '58']);

      expect(res.statusCode).toBe(200);
      expect(res.data.moved_orders_count).toBe(3);
      expect(res.data.post_deleted).toBe(false);
      expect(cmdsOf(logisticsClient)).not.toContain('logistics.post.delete');
    });

    it("qisman tanlov — qayta tekshiruv ham, o'chirish ham yo'q", async () => {
      const res: any = await dispatch(['56']);

      expect(res.data.post_deleted).toBe(false);
      expect(cmdsOf(orderClient)).not.toContain('order.find_all');
    });

    // ------------------------------------------ CODE-07
    it.each([
      [
        'o`chirilgan',
        { id: '198', role: 'manager', status: 'active', isDeleted: true },
      ],
      ['bloklangan', { id: '198', role: 'manager', status: 'inactive' }],
    ])(
      'manzilning yagona menejeri %s — 400, pochta o`qilmaydi',
      async (_label, user) => {
        identityUsers['198'] = user;

        const err = await rpcErrorOf(dispatch(['56']));

        expect(err.statusCode).toBe(400);
        expect(err.message).toContain(
          "'Samarqand' filialida faol menejer yo'q",
        );
        expect(logisticsClient.send).not.toHaveBeenCalled();
      },
    );

    it("menejer qatori umuman yo'q — 400", async () => {
      managerRows = [];

      const err = await rpcErrorOf(dispatch(['56']));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('Avval bu filialga menejer biriktiring');
      expect(identityClient.send).not.toHaveBeenCalled();
    });

    it.each([
      ['xato', () => throwError(() => new Error('identity down'))],
      ['buzuq javob', () => of({ data: { items: null } })],
    ])(
      'identity (%s) — 503 fail-closed, pochta o`qilmaydi',
      async (_label, reply) => {
        identityReply = reply;

        const err = await rpcErrorOf(dispatch(['56']));

        expect(err.statusCode).toBe(503);
        expect(err.message).toContain('Manzil filial menejerini tekshirib');
        expect(logisticsClient.send).not.toHaveBeenCalled();
      },
    );

    it("birinchi menejer bloklangan, ikkinchisi faol — jo'natiladi", async () => {
      managerRows = [
        { branch_id: '20', user_id: '198', role: 'MANAGER' },
        { branch_id: '20', user_id: '199', role: 'MANAGER' },
      ];
      identityUsers['198'] = { id: '198', role: 'manager', status: 'inactive' };
      identityUsers['199'] = { id: '199', role: 'manager', status: 'active' };

      const res: any = await dispatch(['56']);

      expect(res.statusCode).toBe(200);
      expect(identityClient.send).toHaveBeenCalledWith(
        { cmd: 'identity.user.find_all' },
        {
          query: {
            user_ids: ['198', '199'],
            role: 'manager',
            status: 'active',
            page: 1,
            limit: 100,
          },
        },
      );
    });

    it("pochtada HQ'ga tegishli bo'lmagan buyurtma — xabarda id'lar bor", async () => {
      postOrders = [hqOrder('56'), hqOrder('57', { branch_id: '15' })];

      const err = await rpcErrorOf(dispatch(['56', '57']));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain(
        "manba filialga (HQ) tegishli bo'lmagan 1 ta buyurtma bor: #57",
      );
      // fix3b CODE-11: tekshiruv TANLOV bo'yicha — operatorga tanlovdan olib
      // tashlash aytiladi (pochtadan chiqarish yo'li yo'q).
      expect(err.message).toContain('Ularni tanlovdan olib tashlang');
      expect(err.message).not.toContain('pochtadan chiqaring');
      expect(err.message).not.toContain('#56');
      expectNothingWritten();
    });
  });

  // ------------------------------------------- CODE-07: dispatch-destinations
  describe('CODE-07 — dispatch-destinations has_manager faol menejerdan', () => {
    beforeEach(() => {
      branchRepo.find.mockResolvedValue([
        {
          id: '20',
          name: 'Samarqand',
          code: 'SAM',
          type: 'REGIONAL',
          status: 'active',
          phone_number: null,
          region_id: null,
          isDeleted: false,
        },
        {
          id: '21',
          name: 'Buxoro',
          code: 'BUX',
          type: 'HYBRID',
          status: 'active',
          phone_number: null,
          region_id: null,
          isDeleted: false,
        },
      ]);
      branchUserRepo.find.mockResolvedValue([
        // Samarqand: eski menejer o'chirilgan, keyingisi faol.
        { id: 'a', branch_id: '20', user_id: '198' },
        { id: 'b', branch_id: '20', user_id: '199' },
        // Buxoro: yagona menejer bloklangan.
        { id: 'c', branch_id: '21', user_id: '200' },
      ]);
      identityClient.send.mockReturnValue(
        of({
          data: {
            // identity o'chirilgan (198) ni umuman qaytarmaydi.
            items: [
              { id: '199', name: 'Faol', role: 'manager', status: 'active' },
              {
                id: '200',
                name: 'Bloklangan',
                role: 'manager',
                status: 'inactive',
              },
            ],
          },
        }),
      );
    });

    it("o'chirilgan/bloklangan menejer hisoblanmaydi, keyingi faoli ko'rsatiladi", async () => {
      const res: any = await service.findDispatchDestinations({}, ADMIN);

      const [samarqand, buxoro] = res.data.items;
      expect(samarqand).toEqual(
        expect.objectContaining({
          has_manager: true,
          manager: { id: '199', name: 'Faol', phone_number: null },
        }),
      );
      expect(buxoro).toEqual(
        expect.objectContaining({ has_manager: false, manager: null }),
      );
      // Hamma menejerlar bitta identity chaqiruvida.
      expect(identityClient.send).toHaveBeenCalledTimes(1);
      expect(identityClient.send.mock.calls[0][1]).toEqual({
        query: { user_ids: ['198', '199', '200'], page: 1, limit: 100 },
      });
    });

    it("identity buzuq javob — qatorlar bo'yicha (avvalgidek), ro'yxat yiqilmaydi", async () => {
      identityClient.send.mockReturnValue(of({ data: { items: 'x' } }));

      const res: any = await service.findDispatchDestinations({}, ADMIN);

      expect(res.data.items.map((item: any) => item.manager?.id)).toEqual([
        '198',
        '200',
      ]);
      expect(res.data.items.every((item: any) => item.has_manager)).toBe(true);
    });
  });
});
