import { RpcException } from '@nestjs/microservices';
import { defer, map, of, throwError, timer } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import {
  LEGACY_POST_COMMAND_DISABLED_MESSAGE,
  LogisticsServiceController,
} from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';

type Row = Record<string, unknown>;

async function expectRpc(
  promise: Promise<unknown>,
  statusCode: number,
  messagePart?: string,
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
    expect(payload.statusCode).toBe(statusCode);
    if (messagePart) {
      expect(String(payload.message ?? '')).toContain(messagePart);
    }
  }
}

/**
 * FIX3 CODE-11 — assign-to-courier: tashqi manbadan kelgan, hali skan
 * qilinmagan (NEW) posilka avto-qabul qilinmaydi; faol bo'lmagan kuryerga
 * buyurtma berilmaydi. Ikkalasi ham HECH NARSA yozilmasdan oldin.
 */
describe('FIX3 CODE-11 — assignOrdersToCourier qo‘shimcha to‘siqlar', () => {
  function setup(options: { orders: Row[]; courierRows?: Row[] | 'error' }) {
    const ordersMap = new Map(
      options.orders.map((order) => [String(order.id), { ...order }]),
    );
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of(ordersMap.get(String(payload.id)));
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: '10', role: 'MANAGER' } });
        }
        if (pattern.cmd === 'branch.user.find_by_branch') {
          return of({ data: [{ user_id: '44', role: 'COURIER' }] });
        }
        return of({ data: null });
      }),
    };
    const identityClient = {
      send: jest.fn(() =>
        options.courierRows === 'error'
          ? throwError(() => new Error('identity down'))
          : of({ data: options.courierRows ?? [] }),
      ),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'p-open',
        courier_id: '44',
        status: Post_status.SENT,
        order_quantity: 0,
        post_total_price: 0,
      }),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const updateCalls = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      );
    return { service, postRepo, updateCalls };
  }

  const order = (overrides: Row): Row => ({
    branch_id: '10',
    courier_id: null,
    post_id: null,
    total_price: 100_000,
    region_id: '1',
    ...overrides,
  });

  const assign = (service: LogisticsServiceService) =>
    service.assignOrdersToCourier(
      { id: '77', roles: ['manager'] },
      { order_ids: ['101', '102'], courier_id: '44' },
    );

  it('NEW + source external — 400, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED }),
        order({ id: '102', status: Order_status.NEW, source: 'external' }),
      ],
      courierRows: [{ id: '44', status: 'active' }],
    });

    await expectRpc(assign(ctx.service), 400, 'tashqi manbadan');
    expect(ctx.updateCalls()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('qabul qilingan (RECEIVED) tashqi posilka — odatdagidek biriktiriladi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED, source: 'external' }),
        order({ id: '102', status: Order_status.NEW, source: 'internal' }),
      ],
      courierRows: [{ id: '44', status: 'active' }],
    });

    const result: any = await assign(ctx.service);

    expect(result.data.assigned_count).toBe(2);
  });

  it('faol bo‘lmagan kuryer — 400, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED }),
        order({ id: '102', status: Order_status.WAITING }),
      ],
      courierRows: [{ id: '44', status: 'inactive' }],
    });

    await expectRpc(assign(ctx.service), 400, 'Kuryer faol emas');
    expect(ctx.updateCalls()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('o‘chirilgan kuryer (identity qatori yo‘q, branch_users qatori qolgan) — 400, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED }),
        order({ id: '102', status: Order_status.WAITING }),
      ],
      courierRows: [],
    });

    await expectRpc(assign(ctx.service), 400, 'Kuryer topilmadi');
    expect(ctx.updateCalls()).toHaveLength(0);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('identity javob bermadi — to‘siq o‘tkazib yuboriladi (filial a’zoligi tekshirilgan)', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED }),
        order({ id: '102', status: Order_status.WAITING }),
      ],
      courierRows: 'error',
    });

    const result: any = await assign(ctx.service);

    expect(result.data.assigned_count).toBe(2);
  });

  it('faol kuryer — odatdagidek biriktiriladi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101', status: Order_status.RECEIVED }),
        order({ id: '102', status: Order_status.WAITING }),
      ],
      courierRows: [{ id: 44, status: 'ACTIVE' }],
    });

    const result: any = await assign(ctx.service);

    expect(result.data.assigned_count).toBe(2);
  });
});

/**
 * FIX3 CODE-25 — scan-assign qoldiqlari: idempotent qayta skan bo'sh SENT
 * pochta yaratmaydi; buyurtma HQ hudud NEW pochtasidan chiqqanda uning
 * hisobi kamayadi (SENT/RECEIVED pochta hisobi — tarix, tegilmaydi).
 */
describe('FIX3 CODE-25 — scanAssignOrder qoldiqlari', () => {
  type PostRow = { id: string; courier_id: string; status: Post_status };
  type PostWhere = { id?: string; courier_id?: string; status?: Post_status };

  function setup(options: {
    order: Row;
    courierBranch: { branch_id: string; type: string };
    posts?: PostRow[];
    openPost?: Row | null;
  }) {
    const posts = new Map((options.posts ?? []).map((post) => [post.id, post]));
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_qr') {
          return of({ data: options.order });
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          return of({ data: { id: '1' } });
        }
        return of({
          data: {
            branch_id: options.courierBranch.branch_id,
            branch: {
              id: options.courierBranch.branch_id,
              type: options.courierBranch.type,
            },
          },
        });
      }),
    };
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      findOne: jest.fn((query: { where?: PostWhere }) => {
        const where: PostWhere = query?.where ?? {};
        if (where.id !== undefined) {
          const post = posts.get(where.id);
          if (!post) return Promise.resolve(null);
          if (
            where.courier_id !== undefined &&
            where.courier_id !== post.courier_id
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ ...post });
        }
        if (where.status === Post_status.SENT) {
          return Promise.resolve(
            options.openPost === undefined
              ? { id: 'p-open', courier_id: 'c1', status: Post_status.SENT }
              : options.openPost,
          );
        }
        return Promise.resolve(null);
      }),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      createQueryBuilder: jest.fn(() => postUpdateQb),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { service, orderClient, postRepo, postUpdateQb };
  }

  const scan = (service: LogisticsServiceService) =>
    service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc' },
    );

  it('o‘z ON_THE_ROAD buyurtmasini qayta skan, SENT pochta yo‘q — bo‘sh pochta YARATILMAYDI', async () => {
    const ctx = setup({
      order: {
        id: '101',
        branch_id: '10',
        status: Order_status.ON_THE_ROAD,
        courier_id: 'c1',
        post_id: 'p-old',
      },
      courierBranch: { branch_id: '10', type: 'REGIONAL' },
      openPost: null,
    });

    const result: any = await scan(ctx.service);

    expect(result.data).toEqual({
      idempotent: true,
      order_id: '101',
      post_id: 'p-old',
      post_created: false,
    });
    expect(ctx.postRepo.create).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
  });

  it('HQ kuryeri hudud NEW pochtasidagi buyurtmani oladi — NEW pochta hisobi kamayadi', async () => {
    const ctx = setup({
      order: {
        id: '101',
        branch_id: '1',
        status: Order_status.RECEIVED,
        holder_type: 'HQ',
        holder_branch_id: null,
        courier_id: null,
        post_id: 'p-region',
        total_price: 120_000,
      },
      courierBranch: { branch_id: '1', type: 'HQ' },
      posts: [{ id: 'p-region', courier_id: '0', status: Post_status.NEW }],
    });

    const result: any = await scan(ctx.service);

    expect(result.data.idempotent).toBe(false);
    const whereIds = ctx.postUpdateQb.where.mock.calls.map(
      ([, params]) => (params as { id: string }).id,
    );
    // p-open — oshirish, p-region — kamaytirish.
    expect(whereIds).toEqual(['p-open', 'p-region']);
    const decrement = ctx.postUpdateQb.set.mock.calls[1][0] as Record<
      string,
      () => string
    >;
    expect(decrement.order_quantity()).toBe('GREATEST(order_quantity - 1, 0)');
    expect(decrement.post_total_price()).toBe(
      'GREATEST(post_total_price - 120000, 0)',
    );
  });

  it('eski pochta NEW emas (tarix) — hisobiga tegilmaydi', async () => {
    const ctx = setup({
      order: {
        id: '101',
        branch_id: '10',
        status: Order_status.RECEIVED,
        courier_id: null,
        post_id: 'p-received',
        total_price: 120_000,
      },
      courierBranch: { branch_id: '10', type: 'REGIONAL' },
      posts: [
        { id: 'p-received', courier_id: '0', status: Post_status.RECEIVED },
      ],
    });

    await scan(ctx.service);

    const whereIds = ctx.postUpdateQb.where.mock.calls.map(
      ([, params]) => (params as { id: string }).id,
    );
    expect(whereIds).toEqual(['p-open']);
  });
});

/**
 * FIX3 CODE-12 — eski, tekshiruvsiz pochta RPC lari ishga tushirishda o'chiq
 * (410); servis metodlari umuman chaqirilmaydi.
 */
describe('FIX3 CODE-12 — logistics.post.create/update/reassign o‘chiq', () => {
  function setup() {
    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const logisticsService = {
      createPost: jest.fn(),
      sendPost: jest.fn(),
      reassignCourier: jest.fn(),
    };
    const controller = new LogisticsServiceController(
      rmqService as any,
      logisticsService as any,
      {} as any,
    );
    const context = { getPattern: () => 'x', getMessage: () => ({}) };
    return { controller, rmqService, logisticsService, context };
  }

  it.each(['createPost', 'updatePost', 'reassignPost'] as const)(
    '%s — 410, servis chaqirilmaydi, xabar navbatga qaytmaydi',
    async (method) => {
      const ctx = setup();

      await expectRpc(
        ctx.controller[method](ctx.context as any),
        410,
        LEGACY_POST_COMMAND_DISABLED_MESSAGE,
      );
      expect(ctx.logisticsService.createPost).not.toHaveBeenCalled();
      expect(ctx.logisticsService.sendPost).not.toHaveBeenCalled();
      expect(ctx.logisticsService.reassignCourier).not.toHaveBeenCalled();
      expect(ctx.rmqService.nackForError).toHaveBeenCalledWith(
        ctx.context,
        expect.any(RpcException),
      );
    },
  );
});

/**
 * FIX3 CODE-10 — Qaytarish tasdiqlash/rad etish order.update larni 5 tadan
 * parallel yuboradi (ketma-ket 100+ buyurtma gateway 8 s dan oshib 504
 * berardi). Xato bo'lsa — shu bo'lakdan keyin to'xtaydi, muvaffaqiyatlilar
 * hisobga olinadi.
 */
describe('FIX3 CODE-10 — qaytarish so‘rovlari bo‘laklab parallel yangilanadi', () => {
  const flagged = (id: string): Row => ({
    id,
    status: Order_status.ON_THE_ROAD,
    return_requested: true,
    holder_type: 'COURIER',
    holder_courier_id: '209',
    holder_branch_id: '10',
    branch_id: '10',
    courier_id: '209',
    post_id: '55',
    total_price: 10_000,
  });

  function setup(options: { ids: string[]; failIds?: string[] }) {
    const orders = new Map(options.ids.map((id) => [id, flagged(id)]));
    let inFlight = 0;
    let maxInFlight = 0;
    const attempted: string[] = [];
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: { id?: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of(orders.get(String(payload.id)));
        }
        if (pattern.cmd === 'order.find_all') {
          return of({ data: { data: [] } });
        }
        if (pattern.cmd === 'order.update') {
          return defer(() => {
            attempted.push(String(payload.id));
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return timer(5).pipe(
              map(() => {
                inFlight -= 1;
                if (options.failIds?.includes(String(payload.id))) {
                  throw new RpcException({
                    statusCode: 502,
                    message: `Order #${payload.id} update failed`,
                  });
                }
                return { statusCode: 200 };
              }),
            );
          });
        }
        return of({});
      }),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1' } })),
    };
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      createQueryBuilder: jest.fn(() => postUpdateQb),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: '55', courier_id: '209', status: 'sent' }),
      save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    return {
      service,
      postUpdateQb,
      activityLog,
      attempted,
      maxInFlight: () => maxInFlight,
    };
  }

  const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };
  const sevenIds = ['101', '102', '103', '104', '105', '106', '107'];

  it('tasdiqlash: 7 ta buyurtma — hammasi, bir vaqtda ko‘pi bilan 5 ta', async () => {
    const ctx = setup({ ids: sevenIds });

    const result: any = await ctx.service.approveReturnRequests(
      { order_ids: sevenIds },
      manager10,
    );

    expect(result.data.approved).toBe(7);
    expect(result.data.order_ids).toEqual(sevenIds);
    expect(ctx.maxInFlight()).toBeGreaterThan(1);
    expect(ctx.maxInFlight()).toBeLessThanOrEqual(5);
    const setArg = ctx.postUpdateQb.set.mock.calls[0][0] as Record<
      string,
      () => string
    >;
    expect(setArg.order_quantity()).toBe('GREATEST(order_quantity - 7, 0)');
  });

  it('tasdiqlash: 3-buyurtma yiqilsa — birinchi bo‘lak tugaydi, keyingisi boshlanmaydi, asl xato qaytadi', async () => {
    const ctx = setup({ ids: sevenIds, failIds: ['103'] });

    await expectRpc(
      ctx.service.approveReturnRequests({ order_ids: sevenIds }, manager10),
      502,
      'Order #103 update failed',
    );

    expect([...ctx.attempted].sort()).toEqual([
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logistics.return_approve',
        metadata: expect.objectContaining({
          order_ids: ['101', '102', '104', '105'],
        }),
      }),
    );
    // Faqat qaytarilgan 4 tasi pochta hisobidan ayiriladi.
    const setArg = ctx.postUpdateQb.set.mock.calls[0][0] as Record<
      string,
      () => string
    >;
    expect(setArg.order_quantity()).toBe('GREATEST(order_quantity - 4, 0)');
  });

  it('rad etish: 7 ta — hammasi, bir vaqtda ko‘pi bilan 5 ta', async () => {
    const ctx = setup({ ids: sevenIds });

    const result: any = await ctx.service.rejectReturnRequests(
      { order_ids: sevenIds },
      manager10,
    );

    expect(result.data.rejected).toBe(7);
    expect(ctx.maxInFlight()).toBeGreaterThan(1);
    expect(ctx.maxInFlight()).toBeLessThanOrEqual(5);
  });

  it('rad etish: 6-buyurtma yiqilsa — asl xato qaytadi, log yozilmaydi', async () => {
    const ctx = setup({ ids: sevenIds, failIds: ['106'] });

    await expectRpc(
      ctx.service.rejectReturnRequests({ order_ids: sevenIds }, manager10),
      502,
      'Order #106 update failed',
    );
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });
});
