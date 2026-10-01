import { RpcException } from '@nestjs/microservices';
import { TimeoutError, of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * ITEM 8 — Pochta → Qaytarish (kuryer qaytarish so'rovlari), filial doirasida.
 *
 * HQ = '1'. Menejer/registrator faqat o'z filiali kuryerlarining so'rovlarini
 * ko'radi va ko'rib chiqadi; superadmin/admin va HQ registratori — HQ
 * kuryerlarini. Tasdiqlash buyurtmani custody filiali omboriga WAITING qilib
 * qaytaradi (RECEIVED ham, hudud NEW pochtasi ham EMAS).
 */
describe('LogisticsServiceService — qaytarish so‘rovlari', () => {
  type Row = Record<string, unknown>;

  const flagged = (overrides: Row): Row => ({
    status: Order_status.ON_THE_ROAD,
    return_requested: true,
    holder_type: 'COURIER',
    total_price: 120000,
    ...overrides,
  });

  function setup(options?: {
    listRows?: Row[];
    orders?: Row[];
    // branch.user.find_by_user javobi (JWT da branch_id bo'lmaganda)
    assignment?: Row | null;
    hqBranchId?: string;
    posts?: Row[];
    // manba pochtada hali qolgan ON_THE_ROAD buyurtmalar
    remainingOnTheRoad?: Row[];
    couriers?: Row[];
    updateErrors?: Record<string, Error>;
    postCounterError?: Error;
    // pochta id → shu pochta hisoblagichi UPDATE xatosi
    postCounterErrors?: Record<string, Error>;
    // pochta id → shu pochtaning qolgan ON_THE_ROAD so'rovi (order.find_all) xatosi
    remainingErrors?: Record<string, Error>;
    postFindError?: Error;
  }) {
    const orderById = new Map(
      (options?.orders ?? []).map((order) => [String(order.id), order]),
    );

    const orderClient = {
      send: jest.fn(
        (
          pattern: { cmd: string },
          payload: { id?: string; query?: Row; dto?: Row },
        ) => {
          if (pattern.cmd === 'order.find_all') {
            if (payload.query?.post_id) {
              const error =
                options?.remainingErrors?.[payload.query.post_id as string];
              if (error) {
                return throwError(() => error);
              }
              return of({ data: { data: options?.remainingOnTheRoad ?? [] } });
            }
            return of({ data: { data: options?.listRows ?? [] } });
          }
          if (pattern.cmd === 'order.find_by_id') {
            const order = orderById.get(String(payload.id));
            if (!order) {
              return throwError(
                () =>
                  new RpcException({
                    statusCode: 404,
                    message: 'Order not found',
                  }),
              );
            }
            return of(order);
          }
          if (pattern.cmd === 'order.update') {
            const error = options?.updateErrors?.[String(payload.id)];
            if (error) {
              return throwError(() => error);
            }
            return of({ statusCode: 200 });
          }
          return of({});
        },
      ),
    };

    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          return of({ data: { id: options?.hqBranchId ?? '1' } });
        }
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({ data: options?.assignment ?? null });
        }
        return of({});
      }),
    };

    const identityClient = {
      send: jest.fn(() =>
        of({
          data: options?.couriers ?? [
            { id: '209', name: 'Ali', phone_number: '+998903009003' },
            { id: '210', name: 'Vali', phone_number: '+998903009004' },
            { id: '211', name: 'Sobir', phone_number: '+998903009005' },
          ],
        }),
      ),
    };

    // execute() qaysi pochta uchun ekanini oldingi where('id = :id', { id }) dan
    // biladi — xatoni bitta pochtaga berish uchun.
    let counterPostId = '';
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(function (
        this: unknown,
        _sql: string,
        params?: { id?: string },
      ) {
        counterPostId = String(params?.id ?? '');
        return this;
      }),
      execute: jest.fn(() => {
        const error =
          options?.postCounterErrors?.[counterPostId] ??
          options?.postCounterError;
        return error ? Promise.reject(error) : Promise.resolve({ affected: 1 });
      }),
    };

    const postById = new Map(
      (options?.posts ?? []).map((post) => [String(post.id), { ...post }]),
    );
    const postRepo = {
      createQueryBuilder: jest.fn(() => postUpdateQb),
      find: jest.fn(() =>
        options?.postFindError
          ? Promise.reject(options.postFindError)
          : Promise.resolve([...postById.values()]),
      ),
      findOne: jest.fn((query: { where?: { id?: string } }) =>
        Promise.resolve(postById.get(String(query?.where?.id)) ?? null),
      ),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
    };

    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };

    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );

    const updateCalls = () =>
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(
          ([, payload]) => payload as { id: string; dto: Row; requester: Row },
        );

    return {
      service,
      orderClient,
      branchClient,
      postRepo,
      postUpdateQb,
      activityLog,
      updateCalls,
    };
  }

  async function expectRpcError(
    promise: Promise<unknown>,
    statusCode: number,
    message?: string,
  ) {
    try {
      await promise;
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
      expect(payload?.statusCode).toBe(statusCode);
      if (message) {
        expect(payload?.message).toBe(message);
      }
    }
  }

  const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };
  const admin = { id: '2', roles: ['admin'] };

  const FOREIGN_BRANCH_MESSAGE =
    "Siz faqat o'z filialingiz kuryerlarining qaytarish so'rovlarini ko'rib chiqa olasiz";
  const BRANCH_COURIER_FOR_HQ_MESSAGE =
    "Bu buyurtma filial kuryerida — qaytarish so'rovini shu filial menejeri ko'rib chiqadi";
  const NONE_PENDING_MESSAGE =
    "Tanlangan buyurtmalarda ko'rib chiqilmagan qaytarish so'rovi topilmadi";

  describe('ro‘yxat', () => {
    const listRows = [
      flagged({
        id: '101',
        holder_courier_id: '209',
        holder_branch_id: '10',
        branch_id: '10',
        post_id: '55',
      }),
      flagged({
        id: '102',
        holder_courier_id: '210',
        holder_branch_id: '20',
        branch_id: '20',
      }),
      flagged({
        id: '103',
        holder_courier_id: '209',
        holder_branch_id: '10',
        branch_id: '10',
        status: Order_status.WAITING,
      }),
      flagged({
        id: '104',
        holder_courier_id: '211',
        holder_branch_id: '1',
        branch_id: '1',
      }),
      flagged({
        id: '105',
        holder_courier_id: '211',
        holder_branch_id: null,
        branch_id: null,
      }),
      // Kuryersiz qator (HQ → filial pochtasining filial qabul qilmagan qoldig'i)
      flagged({
        id: '106',
        holder_type: 'BRANCH',
        holder_courier_id: null,
        holder_branch_id: '10',
        branch_id: '10',
      }),
    ];

    it('L1: menejer faqat o‘z filiali (10) kuryerlarining so‘rovlarini ko‘radi', async () => {
      const { service, orderClient } = setup({ listRows });

      const result: any = await service.getReturnRequests(manager10);

      const listQuery = orderClient.send.mock.calls.find(
        ([pattern]) => pattern.cmd === 'order.find_all',
      )?.[1] as { query: Row };
      expect(listQuery.query).toEqual(
        expect.objectContaining({
          status: [Order_status.WAITING, Order_status.ON_THE_ROAD],
          return_requested: true,
          holder_type: 'COURIER',
          fetch_all: true,
        }),
      );
      expect(result.data.scope).toEqual({ type: 'BRANCH', branch_id: '10' });
      expect(result.data.total).toBe(2);
      expect(result.data.groups).toHaveLength(1);
      expect(result.data.groups[0]).toEqual(
        expect.objectContaining({
          courier_id: '209',
          courier: expect.objectContaining({ id: '209', name: 'Ali' }),
        }),
      );
      expect(result.data.groups[0].orders.map((o: Row) => o.id)).toEqual([
        '101',
        '103',
      ]);
    });

    it('L2: filial 20 registratori faqat filial 20 ni ko‘radi (sizib chiqish regressiyasi)', async () => {
      const { service } = setup({
        listRows,
        assignment: { branch_id: '20', role: 'REGISTRATOR' },
      });

      const result: any = await service.getReturnRequests({
        id: '77',
        roles: ['registrator'],
      });

      expect(result.data.scope).toEqual({ type: 'BRANCH', branch_id: '20' });
      expect(
        result.data.groups.flatMap((g: any) => g.orders.map((o: Row) => o.id)),
      ).toEqual(['102']);
    });

    it('L3: admin — HQ doirasi: holder_branch_id 1 yoki bo‘sh; filial 10 yo‘q', async () => {
      const { service, branchClient } = setup({ listRows });

      const result: any = await service.getReturnRequests(admin);

      expect(result.data.scope).toEqual({ type: 'HQ', branch_id: '1' });
      expect(
        result.data.groups.flatMap((g: any) => g.orders.map((o: Row) => o.id)),
      ).toEqual(['104', '105']);
      expect(branchClient.send).not.toHaveBeenCalledWith(
        { cmd: 'branch.user.find_by_user' },
        expect.anything(),
      );
    });

    it('L4: HQ registratori (JWT branch 1) admin kabi HQ doirasini oladi', async () => {
      const { service } = setup({ listRows });

      const result: any = await service.getReturnRequests({
        id: '5',
        roles: ['registrator'],
        branch_id: '1',
      });

      expect(result.data.scope).toEqual({ type: 'HQ', branch_id: '1' });
      expect(result.data.total).toBe(2);
    });

    it('L5: filialga biriktirilmagan so‘rovchi — 403', async () => {
      const { service } = setup({ listRows, assignment: null });

      await expectRpcError(
        service.getReturnRequests({ id: '77', roles: ['registrator'] }),
        403,
        'Foydalanuvchi branchga biriktirilmagan',
      );
    });

    it('L6: holder_courier_id yo‘q eski qator — kuryer pochta orqali topiladi', async () => {
      const { service } = setup({
        listRows: [
          flagged({
            id: '107',
            holder_courier_id: null,
            holder_branch_id: '10',
            branch_id: '10',
            post_id: '57',
          }),
        ],
        posts: [{ id: '57', courier_id: '211', status: Post_status.SENT }],
      });

      const result: any = await service.getReturnRequests(manager10);

      expect(result.data.groups[0]).toEqual(
        expect.objectContaining({
          courier_id: '211',
          courier: expect.objectContaining({ name: 'Sobir' }),
        }),
      );
    });

    it('L7: pochta so‘rovidagi xom DB xatosi RpcException ga o‘raladi (qayta navbat yo‘q)', async () => {
      const { service } = setup({
        listRows: [
          flagged({
            id: '107',
            holder_courier_id: null,
            holder_branch_id: '10',
            branch_id: '10',
            post_id: '57',
          }),
        ],
        postFindError: new Error('connection terminated'),
      });

      await expectRpcError(service.getReturnRequests(manager10), 503);
    });
  });

  describe('tasdiqlash', () => {
    const branchLeftover = flagged({
      id: '101',
      status: Order_status.WAITING,
      holder_courier_id: '209',
      holder_branch_id: '10',
      branch_id: '10',
      courier_id: '209',
      post_id: '55',
    });

    it('A1: menejer — buyurtma filial omboriga WAITING bo‘lib qaytadi (aniq DTO)', async () => {
      const { service, postRepo, updateCalls } = setup({
        orders: [branchLeftover],
        posts: [{ id: '55', courier_id: '209', status: Post_status.RECEIVED }],
      });

      const result: any = await service.approveReturnRequests(
        { order_ids: ['101'] },
        manager10,
      );

      expect(updateCalls()).toEqual([
        {
          id: '101',
          dto: {
            status: Order_status.WAITING,
            return_requested: false,
            courier_id: null,
            assigned_at: null,
            post_id: null,
            branch_id: '10',
          },
          requester: {
            id: '198',
            roles: ['manager'],
            note: "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan filial omboriga qaytarildi",
          },
        },
      ]);
      // Hudud NEW pochtasi yaratilmaydi.
      expect(postRepo.create).not.toHaveBeenCalled();
      expect(result.data).toEqual({
        approved: 1,
        order_ids: ['101'],
        skipped_order_ids: [],
      });
      expect(result.message).toBe(
        "Qaytarish so'rovlari tasdiqlandi — buyurtmalar omborga qaytarildi",
      );
    });

    it('A2: ON_THE_ROAD qoldiq — manba pochta hisobi kamayadi, bo‘shagan SENT pochta RECEIVED', async () => {
      const { service, postRepo, postUpdateQb } = setup({
        orders: [
          flagged({ ...branchLeftover, status: Order_status.ON_THE_ROAD }),
        ],
        posts: [{ id: '55', courier_id: '209', status: Post_status.SENT }],
        remainingOnTheRoad: [],
      });

      await service.approveReturnRequests({ order_ids: ['101'] }, manager10);

      expect(postUpdateQb.where).toHaveBeenCalledWith('id = :id', { id: '55' });
      expect(postUpdateQb.execute).toHaveBeenCalledTimes(1);
      const setArg = postUpdateQb.set.mock.calls[0][0] as Record<
        string,
        () => string
      >;
      expect(setArg.order_quantity()).toBe('GREATEST(order_quantity - 1, 0)');
      expect(setArg.post_total_price()).toBe(
        'GREATEST(post_total_price - 120000, 0)',
      );
      expect(postRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: '55', status: Post_status.RECEIVED }),
      );
    });

    it('A2b: pochtada hali qabul qilinadigan buyurtma bor — SENT qoladi', async () => {
      const { service, postRepo, postUpdateQb } = setup({
        orders: [
          flagged({ ...branchLeftover, status: Order_status.ON_THE_ROAD }),
        ],
        posts: [{ id: '55', courier_id: '209', status: Post_status.SENT }],
        remainingOnTheRoad: [{ id: '109', status: Order_status.ON_THE_ROAD }],
      });

      await service.approveReturnRequests({ order_ids: ['101'] }, manager10);

      expect(postUpdateQb.execute).toHaveBeenCalledTimes(1);
      expect(postRepo.save).not.toHaveBeenCalled();
    });

    it('A3: aralash tanlov (filial 10 + filial 20) — butun so‘rov 403, hech narsa yozilmaydi', async () => {
      const { service, updateCalls, postUpdateQb } = setup({
        orders: [
          branchLeftover,
          flagged({
            id: '102',
            holder_courier_id: '210',
            holder_branch_id: '20',
            branch_id: '20',
          }),
        ],
      });

      await expectRpcError(
        service.approveReturnRequests({ order_ids: ['101', '102'] }, manager10),
        403,
        FOREIGN_BRANCH_MESSAGE,
      );
      expect(updateCalls()).toHaveLength(0);
      expect(postUpdateQb.execute).not.toHaveBeenCalled();
    });

    it('A4: admin filial kuryerining so‘rovini ko‘rib chiqolmaydi (403)', async () => {
      const { service, updateCalls } = setup({ orders: [branchLeftover] });

      await expectRpcError(
        service.approveReturnRequests({ order_ids: ['101'] }, admin),
        403,
        BRANCH_COURIER_FOR_HQ_MESSAGE,
      );
      expect(updateCalls()).toHaveLength(0);
    });

    it('A4b: admin HQ kuryerining so‘rovini — branch_id 1 va HQ izohi bilan', async () => {
      const { service, updateCalls } = setup({
        orders: [
          flagged({
            id: '104',
            holder_courier_id: '211',
            holder_branch_id: '1',
            branch_id: '1',
            courier_id: '211',
          }),
        ],
      });

      await service.approveReturnRequests({ order_ids: ['104'] }, admin);

      const [call] = updateCalls();
      expect(call.dto).toEqual(expect.objectContaining({ branch_id: '1' }));
      expect(call.requester).toEqual(
        expect.objectContaining({
          note: "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan HQ omboriga qaytarildi",
        }),
      );
    });

    it('A5: kutilayotgan so‘rov yo‘q (belgisiz / sotilgan / kuryersiz) — 404', async () => {
      const { service, updateCalls } = setup({
        orders: [
          flagged({
            id: '101',
            holder_branch_id: '10',
            branch_id: '10',
            return_requested: false,
          }),
          flagged({
            id: '102',
            holder_branch_id: '10',
            branch_id: '10',
            status: Order_status.SOLD,
          }),
          flagged({
            id: '103',
            holder_branch_id: '10',
            branch_id: '10',
            holder_type: 'BRANCH',
          }),
        ],
      });

      await expectRpcError(
        service.approveReturnRequests(
          { order_ids: ['101', '102', '103'] },
          manager10,
        ),
        404,
        NONE_PENDING_MESSAGE,
      );
      expect(updateCalls()).toHaveLength(0);
    });

    it('A5b: aralash — mos keladigani tasdiqlanadi, eskirgani skipped', async () => {
      const { service, updateCalls } = setup({
        orders: [
          branchLeftover,
          flagged({
            id: '102',
            holder_branch_id: '10',
            branch_id: '10',
            return_requested: false,
          }),
        ],
      });

      const result: any = await service.approveReturnRequests(
        { order_ids: ['101', '102', '101'] },
        manager10,
      );

      expect(updateCalls().map((call) => call.id)).toEqual(['101']);
      expect(result.data).toEqual({
        approved: 1,
        order_ids: ['101'],
        skipped_order_ids: ['102'],
      });
    });

    it('A6: bo‘sh order_ids — 400', async () => {
      const { service } = setup();

      await expectRpcError(
        service.approveReturnRequests({ order_ids: [] }, manager10),
        400,
        "Qaytarish so'rovi uchun buyurtma tanlanmagan",
      );
    });

    it('A7: pochta hisoblagichidagi xom DB xatosi RpcException ga o‘raladi', async () => {
      const { service, updateCalls } = setup({
        orders: [branchLeftover],
        posts: [{ id: '55', courier_id: '209', status: Post_status.SENT }],
        postCounterError: new Error('deadlock detected'),
      });

      await expectRpcError(
        service.approveReturnRequests({ order_ids: ['101'] }, manager10),
        500,
        "Buyurtmalar omborga qaytarildi, lekin kuryer pochtasi #55 hisobini yangilab bo'lmadi — administrator tekshirishi kerak",
      );
      expect(updateCalls()).toHaveLength(1);
    });

    describe('A7b: ikki SENT manba pochta, birinchisi yiqiladi — ikkinchisi baribir yangilanadi', () => {
      const twoPostLeftovers = [
        flagged({ ...branchLeftover, status: Order_status.ON_THE_ROAD }),
        flagged({
          ...branchLeftover,
          id: '102',
          status: Order_status.ON_THE_ROAD,
          post_id: '56',
          total_price: 80000,
        }),
      ];
      const twoSentPosts = [
        { id: '55', courier_id: '209', status: Post_status.SENT },
        { id: '56', courier_id: '209', status: Post_status.SENT },
      ];
      const ONLY_55_FAILED_MESSAGE =
        "Buyurtmalar omborga qaytarildi, lekin kuryer pochtasi #55 hisobini yangilab bo'lmadi — administrator tekshirishi kerak";

      it.each([
        [
          'hisoblagichdagi xom DB xatosi',
          { postCounterErrors: { '55': new Error('deadlock detected') } },
        ],
        [
          'order.find_all RpcException',
          {
            remainingErrors: {
              '55': new RpcException({
                statusCode: 502,
                message: 'Order list request failed',
              }),
            },
          },
        ],
        [
          'order.find_all timeout',
          { remainingErrors: { '55': new TimeoutError() } },
        ],
      ])('%s', async (_label, failure) => {
        const { service, postRepo, postUpdateQb, updateCalls } = setup({
          orders: twoPostLeftovers,
          posts: twoSentPosts,
          remainingOnTheRoad: [],
          ...failure,
        });

        // Xato faqat yiqilgan #55 ni nomlaydi (inglizcha downstream matni emas).
        await expectRpcError(
          service.approveReturnRequests(
            { order_ids: ['101', '102'] },
            manager10,
          ),
          500,
          ONLY_55_FAILED_MESSAGE,
        );
        expect(updateCalls().map((call) => call.id)).toEqual(['101', '102']);
        // #56: hisoblagich kamaydi va bo'shagan SENT pochta RECEIVED bo'ldi.
        expect(postUpdateQb.where).toHaveBeenCalledWith('id = :id', {
          id: '56',
        });
        const [, [setFor56]] = postUpdateQb.set.mock.calls as Array<
          [Record<string, () => string>]
        >;
        expect(setFor56.order_quantity()).toBe(
          'GREATEST(order_quantity - 1, 0)',
        );
        expect(setFor56.post_total_price()).toBe(
          'GREATEST(post_total_price - 80000, 0)',
        );
        expect(postRepo.save).toHaveBeenCalledTimes(1);
        expect(postRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ id: '56', status: Post_status.RECEIVED }),
        );
      });

      it('ikkalasi yiqilsa — bitta xato ikkala pochtani nomlaydi', async () => {
        const { service, postRepo } = setup({
          orders: twoPostLeftovers,
          posts: twoSentPosts,
          remainingOnTheRoad: [],
          postCounterErrors: {
            '55': new Error('deadlock detected'),
            '56': new Error('connection terminated'),
          },
        });

        await expectRpcError(
          service.approveReturnRequests(
            { order_ids: ['101', '102'] },
            manager10,
          ),
          500,
          "Buyurtmalar omborga qaytarildi, lekin kuryer pochtasi #55, #56 hisobini yangilab bo'lmadi — administrator tekshirishi kerak",
        );
        expect(postRepo.save).not.toHaveBeenCalled();
      });
    });

    it('A8: o‘rtada yiqilsa — asl xato qaytadi, lekin qaytarilganining pochta hisobi yangilanadi', async () => {
      const failure = new RpcException({
        statusCode: 502,
        message: 'Order #102 update failed',
      });
      const { service, postUpdateQb, activityLog } = setup({
        orders: [
          branchLeftover,
          flagged({
            id: '102',
            holder_courier_id: '209',
            holder_branch_id: '10',
            branch_id: '10',
            post_id: '56',
          }),
        ],
        posts: [
          { id: '55', courier_id: '209', status: Post_status.RECEIVED },
          { id: '56', courier_id: '209', status: Post_status.SENT },
        ],
        updateErrors: { '102': failure },
      });

      await expectRpcError(
        service.approveReturnRequests({ order_ids: ['101', '102'] }, manager10),
        502,
        'Order #102 update failed',
      );
      // Faqat muvaffaqiyatli qaytarilgan 101 ning pochtasi (55) yangilanadi.
      expect(postUpdateQb.where).toHaveBeenCalledTimes(1);
      expect(postUpdateQb.where).toHaveBeenCalledWith('id = :id', { id: '55' });
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'logistics.return_approve',
          metadata: expect.objectContaining({ order_ids: ['101'] }),
        }),
      );
    });

    it('A8b: o‘rtada yiqilib, manba pochta ham yiqilsa — asl xato qaytadi, qolgan pochta baribir yangilanadi', async () => {
      const { service, postRepo, postUpdateQb } = setup({
        orders: [
          flagged({ ...branchLeftover, status: Order_status.ON_THE_ROAD }),
          flagged({
            ...branchLeftover,
            id: '102',
            status: Order_status.ON_THE_ROAD,
            post_id: '56',
          }),
          flagged({ ...branchLeftover, id: '103', post_id: '57' }),
        ],
        posts: [
          { id: '55', courier_id: '209', status: Post_status.SENT },
          { id: '56', courier_id: '209', status: Post_status.SENT },
          { id: '57', courier_id: '209', status: Post_status.SENT },
        ],
        remainingOnTheRoad: [],
        updateErrors: {
          '103': new RpcException({
            statusCode: 502,
            message: 'Order #103 update failed',
          }),
        },
        postCounterErrors: { '55': new Error('deadlock detected') },
      });

      await expectRpcError(
        service.approveReturnRequests(
          { order_ids: ['101', '102', '103'] },
          manager10,
        ),
        502,
        'Order #103 update failed',
      );
      // 103 qaytarilmadi — uning pochtasi (57) tegilmaydi; 55 yiqildi, 56 yangilandi.
      expect(
        postUpdateQb.where.mock.calls.map(
          ([, params]) => (params as { id: string }).id,
        ),
      ).toEqual(['55', '56']);
      expect(postRepo.save).toHaveBeenCalledTimes(1);
      expect(postRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: '56', status: Post_status.RECEIVED }),
      );
    });
  });

  describe('rad etish', () => {
    const leftover = flagged({
      id: '101',
      holder_courier_id: '209',
      holder_branch_id: '10',
      branch_id: '10',
      courier_id: '209',
      post_id: '55',
    });

    it('R1: faqat belgi olinadi — buyurtma kuryerda qoladi (aniq DTO)', async () => {
      const { service, updateCalls, postUpdateQb } = setup({
        orders: [leftover],
      });

      const result: any = await service.rejectReturnRequests(
        { order_ids: ['101'] },
        manager10,
      );

      expect(updateCalls()).toEqual([
        {
          id: '101',
          dto: { return_requested: false },
          requester: {
            id: '198',
            roles: ['manager'],
            note: "Qaytarish so'rovi rad etildi — buyurtma kuryerda qoldi",
          },
        },
      ]);
      expect(postUpdateQb.execute).not.toHaveBeenCalled();
      expect(result.data).toEqual({
        rejected: 1,
        order_ids: ['101'],
        skipped_order_ids: [],
      });
    });

    it('R2: begona filial buyurtmasi — 403, hech narsa yozilmaydi', async () => {
      const { service, updateCalls } = setup({
        orders: [
          flagged({
            id: '102',
            holder_courier_id: '210',
            holder_branch_id: '20',
            branch_id: '20',
          }),
        ],
      });

      await expectRpcError(
        service.rejectReturnRequests({ order_ids: ['102'] }, manager10),
        403,
        FOREIGN_BRANCH_MESSAGE,
      );
      expect(updateCalls()).toHaveLength(0);
    });

    it('R3: kutilayotgan so‘rov yo‘q — 404', async () => {
      const { service } = setup({
        orders: [flagged({ ...leftover, return_requested: false })],
      });

      await expectRpcError(
        service.rejectReturnRequests({ order_ids: ['101'] }, manager10),
        404,
        NONE_PENDING_MESSAGE,
      );
    });
  });
});
