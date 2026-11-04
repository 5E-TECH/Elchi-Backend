import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { NEVER, Observable, of, throwError, TimeoutError } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * Buyurtma ↔ filial qamrovi — branch-service. Viloyat qoidasi (ega qarori,
 * Trello anKpzwxk, 2026-11-03; #617 dagi tuman → filial qoidasi o'rniga):
 *   - HQ → filial pochta jo'natishda (dispatchPostToBranch) HAR BIR buyurtma
 *     manzil filial qamrovida bo'lishi shart (`isOrderServedByBranch`):
 *     buyurtmaning xizmat viloyati (tuman assigned_region ?? region_id;
 *     tumansiz — buyurtma viloyati) filial viloyatiga teng. Viloyatdagi
 *     istalgan faol filial — to'g'ri manzil; `serving_branch_id` HISOBGA
 *     OLINMAYDI. Mos kelmasa — 409 «Boshqa viloyat buyurtmasi», hech narsa
 *     yozilmaydi; logistika javob bermasa — 503 (fail-closed).
 *   - LC-09: pochta yoki manzil filial viloyati bo'sh — 400
 *     `branch_region_missing` (endi o'tkazib yuborilmaydi).
 *   - Filial o'chirilgach / nofaol qilingach / viloyati yoki turi
 *     (REGIONAL/HYBRID'dan boshqasiga) o'zgargach
 *     `logistics.district.clear_serving_branch` (best-effort, filial amalini
 *     to'smaydi; endi faqat ustunni toza saqlaydi).
 */
type RepoMock = {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  createQueryBuilder?: jest.Mock;
  manager?: unknown;
  metadata?: unknown;
};
type WhereArg = {
  where?: { id?: unknown; role?: unknown; branch_id?: unknown };
};
type RpcPayload = {
  ids?: string[];
  orders?: Array<{ order_id: string }>;
  query?: { user_ids?: string[] };
};
type RpcError = {
  statusCode?: number;
  message?: string;
  data?: Record<string, unknown>;
};

describe('Tuman ↔ filial qamrovi — branch-service', () => {
  let service: BranchServiceService;
  let branchRepo: RepoMock;
  let branchUserRepo: RepoMock;
  let identityClient: { send: jest.Mock };
  let logisticsClient: { send: jest.Mock };
  let orderClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let warnSpy: jest.SpyInstance;

  const ADMIN = { id: '1', roles: ['admin'] };

  beforeEach(() => {
    branchRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
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
    logisticsClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    orderClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    financeClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };

    service = new BranchServiceService(
      branchRepo as never,
      branchUserRepo as never,
      {} as never,
      identityClient as never,
      logisticsClient as never,
      orderClient as never,
      { send: jest.fn().mockReturnValue(of({ data: {} })) } as never,
      financeClient as never,
      { get: jest.fn((_key: string, fallback?: string) => fallback) } as never,
      activityLog as never,
    );
    warnSpy = jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const rpcErrorOf = async (promise: Promise<unknown>): Promise<RpcError> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as RpcError;
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  const cmdsOf = (client: { send: jest.Mock }) =>
    client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

  /** Fon (kutilmaydigan) va'dalarini tugatish. */
  const flushBackground = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  // ------------------------------------------------------------ dispatch
  describe('dispatchPostToBranch — buyurtma manzil filial qamrovida (viloyat qoidasi)', () => {
    let branchesById: Record<string, Record<string, unknown>>;
    let postRow: Record<string, unknown>;
    let postOrders: Array<Record<string, unknown>>;
    let districtsById: Record<string, Record<string, unknown>>;
    let districtReply: ((payload: RpcPayload) => Observable<unknown>) | null;

    const district = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      region_id: '14',
      assigned_region: null,
      serving_branch_id: null,
      ...extra,
    });

    /** HQ'da qabul qilingan buyurtma (tumani #1401, viloyati #14). */
    const hqOrder = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      branch_id: '10',
      status: 'received',
      region_id: '14',
      district_id: '1401',
      total_price: 100000,
      courier_id: null,
      holder_courier_id: null,
      ...extra,
    });

    beforeEach(() => {
      branchesById = {
        '10': { id: '10', type: 'HQ', status: 'active', isDeleted: false },
        '20': {
          id: '20',
          name: 'Samarqand',
          type: 'REGIONAL',
          status: 'active',
          region_id: '14',
          isDeleted: false,
        },
        // Viloyati belgilanmagan (eski) filial.
        '21': {
          id: '21',
          name: 'Eski',
          type: 'REGIONAL',
          status: 'active',
          region_id: null,
          isDeleted: false,
        },
        // Shu viloyatdagi (#14) ikkinchi filial.
        '22': {
          id: '22',
          name: 'Urgut',
          type: 'HYBRID',
          status: 'active',
          region_id: '14',
          isDeleted: false,
        },
        // Boshqa viloyat (#6) filiali.
        '30': {
          id: '30',
          name: 'Buxoro',
          type: 'REGIONAL',
          status: 'active',
          region_id: '6',
          isDeleted: false,
        },
      };
      postRow = { id: '900', courier_id: '0', status: 'new', region_id: '14' };
      postOrders = [hqOrder('1001')];
      districtsById = { '1401': district('1401') };
      districtReply = null;

      branchRepo.findOne.mockImplementation(({ where }: WhereArg) =>
        Promise.resolve(branchesById[String(where?.id)] ?? null),
      );
      // Manzil filial menejeri (CODE-07).
      branchUserRepo.find.mockImplementation(({ where }: WhereArg) =>
        Promise.resolve(
          where?.role === 'MANAGER'
            ? [
                {
                  branch_id: String(where?.branch_id),
                  user_id: '198',
                  role: 'MANAGER',
                },
              ]
            : [],
        ),
      );
      identityClient.send.mockImplementation(
        ({ cmd }: { cmd: string }, payload: RpcPayload) =>
          cmd === 'identity.user.find_all'
            ? of({
                data: {
                  items: (payload?.query?.user_ids ?? []).map((id: string) => ({
                    id,
                    role: 'manager',
                    status: 'active',
                  })),
                },
              })
            : of({ data: null }),
      );
      logisticsClient.send.mockImplementation(
        ({ cmd }: { cmd: string }, payload: RpcPayload) => {
          if (cmd === 'logistics.post.find_by_ids') {
            return of({ data: [postRow] });
          }
          if (cmd === 'logistics.post.orders_by_post') {
            return of({ data: postOrders });
          }
          if (cmd === 'logistics.district.find_by_ids') {
            if (districtReply) {
              return districtReply(payload);
            }
            return of({
              data: (payload?.ids ?? [])
                .map((id: string) => districtsById[id])
                .filter(Boolean),
            });
          }
          if (cmd === 'logistics.post.receive_orders') {
            return of({
              data: (payload?.orders ?? []).map((row) => ({
                order_id: row.order_id,
                post_id: '777',
              })),
            });
          }
          return of({ data: {} });
        },
      );
      orderClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
        cmd === 'order.find_all'
          ? of({ data: [], total: 0 })
          : of({ data: {} }),
      );
    });

    const dispatch = (orderIds: string[], destinationId = '20') =>
      service.dispatchPostToBranch('10', '900', destinationId, orderIds, ADMIN);
    const updatedIds = () =>
      orderClient.send.mock.calls
        .filter(
          ([pattern]) => (pattern as { cmd: string }).cmd === 'order.update',
        )
        .map(([, payload]) => (payload as { id: string }).id);
    const districtLookups = () =>
      (logisticsClient.send.mock.calls as unknown[][]).filter(
        ([pattern]) =>
          (pattern as { cmd: string }).cmd === 'logistics.district.find_by_ids',
      );
    const expectNothingWritten = () => {
      expect(cmdsOf(logisticsClient)).not.toContain(
        'logistics.post.receive_orders',
      );
      expect(cmdsOf(logisticsClient)).not.toContain('logistics.post.delete');
      expect(updatedIds()).toEqual([]);
      expect(activityLog.log).not.toHaveBeenCalled();
    };

    // 2026-11-04 — HQ «Qaytarish» tasdig'i filialga kelmagan o'tkazma
    // buyurtmasini dispatch oldidagi holatiga qaytaradi (logistics
    // `approveReturnRequests`: RECEIVED, branch_id HQ, kuryersiz, holder HQ,
    // o'tkazma pochtasi hududining NEW pochtasida) — u o'sha filialga qayta
    // jo'natiladi. Avvalgi tasdiq holati (WAITING, pochtasiz) bilan bo'lmasdi.
    it("HQ «Qaytarish» tasdig'idan qaytgan o'tkazma buyurtmasi — o'sha filialga qayta jo'natiladi", async () => {
      postOrders = [
        hqOrder('1001', {
          post_id: '900',
          holder_type: 'HQ',
          holder_branch_id: null,
          return_requested: false,
          assigned_at: null,
        }),
      ];

      const res = await dispatch(['1001']);

      expect(res.statusCode).toBe(200);
      const [update] = orderClient.send.mock.calls.filter(
        ([pattern]) => (pattern as { cmd: string }).cmd === 'order.update',
      );
      expect(update[1]).toEqual(
        expect.objectContaining({
          id: '1001',
          dto: expect.objectContaining({
            status: 'on the road',
            branch_id: '20',
            holder_branch_id: '20',
            post_id: '777',
          }),
        }),
      );
    });

    it("tasdiqdan qaytgan buyurtma WAITING bo'lganda jo'natib bo'lmasdi — 400 (shuning uchun tasdiq RECEIVED yozadi)", async () => {
      postOrders = [hqOrder('1001', { status: 'waiting', holder_type: 'HQ' })];

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(400);
      expectNothingWritten();
    });

    it("⭐ tuman BOSHQA filialga biriktirilgan (serving_branch_id), viloyati mos — jo'natiladi (avval 409 edi)", async () => {
      districtsById['1401'] = district('1401', { serving_branch_id: '30' });

      const res = await dispatch(['1001']);

      expect(res.statusCode).toBe(200);
      expect(updatedIds()).toEqual(['1001']);
    });

    it('buyurtma tumanining xizmat viloyati boshqa — 409 «Boshqa viloyat buyurtmasi», id xabarda, hech narsa yozilmaydi', async () => {
      districtsById['1401'] = district('1401', { assigned_region: '6' });

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain(
        "Boshqa viloyat buyurtmasi — bu filialga jo'natilmaydi: #1001",
      );
      expect(err.message).toContain("Hech narsa jo'natilmadi");
      // Admin rehome'ni qaysi tuman uchun chaqirishini bilsin.
      expect(err.message).toContain('Tuman(lar): #1401');
      expect(err.data).toEqual({
        reason: 'district_not_served_by_branch',
        order_ids: ['1001'],
        district_ids: ['1401'],
        // Gateway faqat reason/usage/details ni chiqaradi — ro'yxatlar shu yerda.
        details: { order_ids: ['1001'], district_ids: ['1401'] },
        post_id: '900',
        source_branch_id: '10',
        destination_branch_id: '20',
      });
      expect(districtLookups()).toEqual([
        [{ cmd: 'logistics.district.find_by_ids' }, { ids: ['1401'] }],
      ]);
      expectNothingWritten();
    });

    it("aralash tanlov: bittasi qamrovda, bittasi boshqa viloyatniki — BUTUN so'rov 409, faqat mos kelmagan id", async () => {
      districtsById['1402'] = district('1402', { assigned_region: '6' });
      postOrders = [hqOrder('1001'), hqOrder('1002', { district_id: '1402' })];

      const err = await rpcErrorOf(dispatch(['1001', '1002']));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain('#1002');
      expect(err.message).not.toContain('#1001');
      expect(err.data?.order_ids).toEqual(['1002']);
      expectNothingWritten();
    });

    it("⭐ tuman AYNAN manzil filialga biriktirilgan, lekin viloyati boshqa — 409 (avval jo'natilardi)", async () => {
      districtsById['1401'] = district('1401', {
        region_id: '9',
        serving_branch_id: '20',
      });

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(409);
      expect(err.data?.reason).toBe('district_not_served_by_branch');
      expectNothingWritten();
    });

    it('qamrov tekshiruvi har qanday yozuvdan OLDIN', async () => {
      const res = await dispatch(['1001']);

      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual(
        expect.objectContaining({ moved_order_ids: ['1001'] }),
      );
      const cmds = cmdsOf(logisticsClient);
      expect(cmds.indexOf('logistics.district.find_by_ids')).toBeLessThan(
        cmds.indexOf('logistics.post.receive_orders'),
      );
    });

    it("tumanning xizmat viloyati (assigned_region) bo'yicha jo'natiladi — geografik viloyat boshqa bo'lsa ham", async () => {
      districtsById['1401'] = district('1401', {
        region_id: '9',
        assigned_region: '14',
      });

      const res = await dispatch(['1001']);

      expect(res.statusCode).toBe(200);
      expect(updatedIds()).toEqual(['1001']);
    });

    it("xizmat viloyati boshqa (tuman o'tkazilgan) — 409", async () => {
      districtsById['1401'] = district('1401', {
        region_id: '14',
        assigned_region: '9',
      });

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(409);
      expect(err.data?.reason).toBe('district_not_served_by_branch');
      expectNothingWritten();
    });

    it('tuman logistikada topilmadi — 409 (fail-closed)', async () => {
      districtsById = {};

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(409);
      expect(err.data?.order_ids).toEqual(['1001']);
      expectNothingWritten();
    });

    it("⭐ manzil filialda viloyat yo'q — 400 branch_region_missing (tuman unga biriktirilgan bo'lsa ham), buyurtmalar o'qilmaydi", async () => {
      districtsById['1401'] = district('1401', { serving_branch_id: '21' });

      const err = await rpcErrorOf(dispatch(['1001'], '21'));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain(
        'manzil filial («Eski») viloyati belgilanmagan',
      );
      expect(err.message).toContain("Hech narsa jo'natilmadi");
      expect(err.data).toEqual({
        reason: 'branch_region_missing',
        details: {
          missing: ['destination_branch_region'],
          post_id: '900',
          destination_branch_id: '21',
          post_region_id: '14',
          destination_region_id: null,
        },
        post_id: '900',
        source_branch_id: '10',
        destination_branch_id: '21',
      });
      expect(cmdsOf(logisticsClient)).not.toContain(
        'logistics.post.orders_by_post',
      );
      expect(districtLookups()).toEqual([]);
      expectNothingWritten();
    });

    it("⭐ pochtada viloyat yo'q — 400 branch_region_missing (LC-09 endi o'tkazib yuborilmaydi)", async () => {
      postRow = { ...postRow, region_id: null };

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain(
        'pochta #900 viloyati (hududi) belgilanmagan',
      );
      expect(err.data?.reason).toBe('branch_region_missing');
      expect(err.data?.details).toEqual(
        expect.objectContaining({
          missing: ['post_region'],
          post_region_id: null,
          destination_region_id: '14',
        }),
      );
      expect(cmdsOf(logisticsClient)).not.toContain(
        'logistics.post.orders_by_post',
      );
      expectNothingWritten();
    });

    it("pochtada ham, manzil filialda ham viloyat yo'q — 400, ikkalasi details.missing da", async () => {
      postRow = { ...postRow, region_id: '0' };

      const err = await rpcErrorOf(dispatch(['1001'], '21'));

      expect(err.statusCode).toBe(400);
      expect(err.data?.reason).toBe('branch_region_missing');
      expect(err.data?.details).toEqual(
        expect.objectContaining({
          missing: ['destination_branch_region', 'post_region'],
        }),
      );
      expectNothingWritten();
    });

    it("buyurtmada tuman yo'q — buyurtma viloyati bo'yicha, tumanlar so'ralmaydi", async () => {
      postOrders = [hqOrder('1001', { district_id: null })];

      const res = await dispatch(['1001']);

      expect(res.statusCode).toBe(200);
      expect(districtLookups()).toEqual([]);
    });

    it("buyurtmada tuman yo'q, viloyati boshqa — 409", async () => {
      postOrders = [hqOrder('1001', { district_id: null, region_id: '9' })];

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(409);
      expect(err.data?.order_ids).toEqual(['1001']);
      expect(districtLookups()).toEqual([]);
      expectNothingWritten();
    });

    it("tumanlar BITTA so'rovda, takrorsiz va kanonik id bilan o'qiladi", async () => {
      postOrders = [
        hqOrder('1001'),
        hqOrder('1002', { district_id: '01401' }),
        hqOrder('1003'),
      ];

      const res = await dispatch(['1001', '1002', '1003']);

      expect(res.statusCode).toBe(200);
      expect(districtLookups()).toEqual([
        [{ cmd: 'logistics.district.find_by_ids' }, { ids: ['1401'] }],
      ]);
    });

    it.each([
      ['timeout', () => throwError(() => new TimeoutError())],
      ['xato', () => throwError(() => new Error('logistics down'))],
      ['buzuq javob', () => of({ data: null })],
    ])(
      'tumanlarni o`qib bo`lmasa (%s) — 503, hech narsa yozilmaydi',
      async (_label, reply) => {
        districtReply = reply;

        const err = await rpcErrorOf(dispatch(['1001']));

        expect(err.statusCode).toBe(503);
        expect(err.message).toContain(
          "Buyurtmalar tumanini tekshirib bo'lmadi",
        );
        expectNothingWritten();
        expect(warnSpy).toHaveBeenCalled();
      },
    );

    it('logistika javob bermasa — 5 s dan keyin 503, hech narsa yozilmaydi', async () => {
      jest.useFakeTimers();
      districtReply = () => NEVER;

      const pending = rpcErrorOf(dispatch(['1001']));
      await jest.advanceTimersByTimeAsync(5000);
      const err = await pending;

      expect(err.statusCode).toBe(503);
      expectNothingWritten();
    });

    it("LC-09 saqlanadi: pochta hududi manzil filialnikidan farq qilsa — avvalgidek 400, tumanlar so'ralmaydi", async () => {
      postRow = { ...postRow, region_id: '15' };

      const err = await rpcErrorOf(dispatch(['1001']));

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('Pochta #900 boshqa hudud uchun');
      expect(districtLookups()).toEqual([]);
      expectNothingWritten();
    });

    // Kartadagi qabul mezoni 1: Urgut tumani (Samarqand viloyati, #14)
    // buyurtmasi «Samarqand filiali» ga ham, «Urgut filiali» ga ham
    // jo'natiladi, Buxoro filialiga — yo'q.
    describe('AC1 — Urgut tumani buyurtmasi (Samarqand viloyati)', () => {
      beforeEach(() => {
        // Urgut tumani: Samarqand viloyati; Urgut filialiga «biriktirilgan»
        // (serving_branch_id endi ahamiyatsiz).
        districtsById['1405'] = district('1405', { serving_branch_id: '22' });
        postOrders = [hqOrder('1001', { district_id: '1405' })];
      });

      it.each([
        ['Samarqand filiali', '20'],
        ['Urgut filiali', '22'],
      ])("%s ga jo'natiladi", async (_label, destinationId) => {
        const res = await dispatch(['1001'], destinationId);

        expect(res.statusCode).toBe(200);
        expect(updatedIds()).toEqual(['1001']);
        const receive = (logisticsClient.send.mock.calls as unknown[][]).find(
          ([pattern]) =>
            (pattern as { cmd: string }).cmd ===
            'logistics.post.receive_orders',
        )?.[1] as { orders: Array<Record<string, unknown>> };
        expect(receive.orders).toEqual([
          expect.objectContaining({
            order_id: '1001',
            assigned_region: '14',
            assigned_branch: destinationId,
          }),
        ]);
      });

      it('Buxoro filialiga — Samarqand pochtasi 400 `region_mismatch` (LC-09), hech narsa yozilmaydi', async () => {
        const err = await rpcErrorOf(dispatch(['1001'], '30'));

        expect(err.statusCode).toBe(400);
        // Gateway faqat reason/usage/details ni o'tkazadi — mashina kodi bor.
        expect(err.data?.reason).toBe('region_mismatch');
        expect(err.data?.details).toEqual({
          post_id: '900',
          destination_branch_id: '30',
          post_region_id: '14',
          destination_region_id: '6',
        });
        expect(err.data?.reasons).toEqual({ region_mismatch: true });
        expectNothingWritten();
      });

      it("Buxoro filialiga — pochta Buxoroniki bo'lsa ham buyurtma o'zi 409 «Boshqa viloyat buyurtmasi»", async () => {
        postRow = { ...postRow, region_id: '6' };

        const err = await rpcErrorOf(dispatch(['1001'], '30'));

        expect(err.statusCode).toBe(409);
        expect(err.message).toContain('Boshqa viloyat buyurtmasi');
        expect(err.data?.reason).toBe('district_not_served_by_branch');
        expect(err.data?.details).toEqual({
          order_ids: ['1001'],
          district_ids: ['1405'],
        });
        expectNothingWritten();
      });
    });
  });

  // --------------------------------------- filial o'chirilishi / nofaollashuvi
  describe('clear_serving_branch — filial o`chirilgach / nofaol qilingach / viloyati yoki turi o`zgargach', () => {
    let couriers: number;
    let activeUsers: number;
    let branchRow: Record<string, unknown>;
    let clearReply: () => Observable<unknown>;

    beforeEach(() => {
      couriers = 0;
      activeUsers = 0;
      branchRow = {
        id: '20',
        name: 'Samarqand',
        code: 'SAM',
        type: 'REGIONAL',
        status: 'active',
        region_id: '14',
        parent_id: '1',
        level: 1,
        isDeleted: false,
      };
      clearReply = () => of({ data: { cleared: 3 } });

      branchRepo.findOne.mockImplementation(({ where }: WhereArg) => {
        if (String(where?.id) === '20') {
          return Promise.resolve(branchRow);
        }
        if (String(where?.id) === '1') {
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
      branchUserRepo.count.mockImplementation(({ where }: WhereArg) =>
        Promise.resolve(where?.role === 'COURIER' ? couriers : activeUsers),
      );
      orderClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'order.branch_can_delete') {
          return of({ data: { active_orders: 0, active_batches: 0 } });
        }
        if (cmd === 'order.settlement.branch_summary') {
          return of({ data: { branch_payable: 0 } });
        }
        return of({ data: {} });
      });
      financeClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
        cmd === 'finance.cashbox.find_by_user'
          ? of({ data: { balance: 0, balance_cash: 0, balance_card: 0 } })
          : of({ data: {} }),
      );
      logisticsClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
        cmd === 'logistics.district.clear_serving_branch'
          ? clearReply()
          : of({ data: {} }),
      );
    });

    const clearCalls = () =>
      (logisticsClient.send.mock.calls as unknown[][]).filter(
        ([pattern]) =>
          (pattern as { cmd: string }).cmd ===
          'logistics.district.clear_serving_branch',
      );

    it("deleteBranch — filial saqlangandan KEYIN tumanlari bo'shatiladi", async () => {
      const res = await service.deleteBranch('20', ADMIN);

      expect(res.statusCode).toBe(200);
      expect(clearCalls()).toEqual([
        [
          { cmd: 'logistics.district.clear_serving_branch' },
          { branch_id: '20' },
        ],
      ]);
      const clearIndex = logisticsClient.send.mock.calls.findIndex(
        ([pattern]) =>
          (pattern as { cmd: string }).cmd ===
          'logistics.district.clear_serving_branch',
      );
      expect(branchRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
        logisticsClient.send.mock.invocationCallOrder[clearIndex],
      );
    });

    it("deleteBranch rad etilsa (faol xodim bor) — tumanlar bo'shatilmaydi", async () => {
      activeUsers = 2;

      const err = await rpcErrorOf(service.deleteBranch('20', ADMIN));

      expect(err.statusCode).toBe(400);
      expect(clearCalls()).toEqual([]);
    });

    it("bo'shatish xatosi o'chirishni to'smaydi — faqat ogohlantirish", async () => {
      clearReply = () => throwError(() => new Error('logistics down'));

      const res = await service.deleteBranch('20', ADMIN);
      await flushBackground();

      expect(res.statusCode).toBe(200);
      expect(branchRepo.save).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('logistics.district.clear_serving_branch'),
      );
    });

    it('logistika javob bermasa ham deleteBranch KUTMAYDI (timeout fonda log qilinadi)', async () => {
      jest.useFakeTimers();
      clearReply = () => NEVER;

      const res = await service.deleteBranch('20', ADMIN);

      expect(res.statusCode).toBe(200);
      expect(warnSpy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('filial #20 tumanlarini'),
      );
    });

    it("updateBranch: faol → nofaol — saqlangandan keyin tumanlari bo'shatiladi", async () => {
      const res = await service.updateBranch(
        '20',
        { status: 'inactive' },
        ADMIN,
      );

      expect(res.statusCode).toBe(200);
      expect(clearCalls()).toEqual([
        [
          { cmd: 'logistics.district.clear_serving_branch' },
          { branch_id: '20' },
        ],
      ]);
    });

    // Viloyati yoki turi o'zgargan filialning tumanlari bo'shatiladi. Viloyat
    // qoidasidan beri `serving_branch_id` qamrovga ta'sir qilmaydi — bu faqat
    // ustunni toza saqlash (keyin olib tashlanadi).
    it.each([
      ['hudud boshqa viloyatga', { region_id: '9' }],
      ['hudud olib tashlandi', { region_id: null }],
      ['tur → PICKUP', { type: 'PICKUP' }],
    ])(
      "updateBranch: %s — saqlangandan keyin tumanlari bo'shatiladi",
      async (_label, dto) => {
        const res = await service.updateBranch('20', dto, ADMIN);

        expect(res.statusCode).toBe(200);
        expect(clearCalls()).toEqual([
          [
            { cmd: 'logistics.district.clear_serving_branch' },
            { branch_id: '20' },
          ],
        ]);
        const clearIndex = logisticsClient.send.mock.calls.findIndex(
          ([pattern]) =>
            (pattern as { cmd: string }).cmd ===
            'logistics.district.clear_serving_branch',
        );
        expect(branchRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
          logisticsClient.send.mock.invocationCallOrder[clearIndex],
        );
      },
    );

    it("updateBranch: hudud o'zgarishi rad etilsa (kuryer bor) — bo'shatilmaydi", async () => {
      couriers = 1;

      const err = await rpcErrorOf(
        service.updateBranch('20', { region_id: '9' }, ADMIN),
      );

      expect(err.statusCode).toBe(409);
      expect(branchRepo.save).not.toHaveBeenCalled();
      expect(clearCalls()).toEqual([]);
    });

    it.each([
      ['faqat nom', { name: 'Samarqand markaz' }],
      ['holat o`sha (active)', { status: 'active' }],
      ['hudud o`sha', { region_id: '14' }],
      ['tur REGIONAL → HYBRID', { type: 'HYBRID' }],
    ])(
      "updateBranch: qamrovga ta'sir qilmaydigan o'zgarish (%s) — bo'shatilmaydi",
      async (_label, dto) => {
        // ensureBranchNameUnique: nom band emas.
        branchRepo.createQueryBuilder = jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        }));

        const res = await service.updateBranch('20', dto, ADMIN);

        expect(res.statusCode).toBe(200);
        expect(clearCalls()).toEqual([]);
      },
    );

    it("updateBranch: allaqachon nofaol filial yana 'inactive' — bo'shatilmaydi", async () => {
      branchRow.status = 'inactive';

      const res = await service.updateBranch(
        '20',
        { status: 'inactive' },
        ADMIN,
      );

      expect(res.statusCode).toBe(200);
      expect(clearCalls()).toEqual([]);
    });

    it("updateBranch: nofaollashtirish rad etilsa (kuryer bor) — bo'shatilmaydi", async () => {
      couriers = 1;

      const err = await rpcErrorOf(
        service.updateBranch('20', { status: 'inactive' }, ADMIN),
      );

      expect(err.statusCode).toBe(409);
      expect(branchRepo.save).not.toHaveBeenCalled();
      expect(clearCalls()).toEqual([]);
    });
  });
});
