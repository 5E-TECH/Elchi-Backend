/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- `any` mock'lar (fayldagi naqsh) */
import { RmqContext, RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { FindOperator } from 'typeorm';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';
import { LogisticsServiceController } from './logistics-service.controller';

/**
 * Tuman boshqa (xizmat) viloyatiga o'tkazilgach HQ NEW pochtasida qotib
 * qolgan ochiq buyurtmalarni ko'chirish — `rehomeOpenDistrictOrders`
 * (`logistics.district.rehome_open_orders`) va PATCH /district/:id dagi
 * ixtiyoriy `rehome_open_orders`.
 *
 * Pochtalar va buyurtmalar xotirada: `order.update` buyurtmani o'zgartiradi,
 * `order.find_all` (post_ids / district_id) shu holatdan o'qiydi — hisoblagich
 * qayta hisobi va idempotentlik haqiqiy holat bo'yicha sinaladi.
 */
type Row = Record<string, unknown>;
type PostRow = {
  id: string;
  courier_id: string;
  region_id: string | null;
  branch_id: string | null;
  status: Post_status;
  order_quantity: number;
  post_total_price: number;
  qr_code_token?: string | null;
};
type OrderState = {
  id: string;
  district_id: string | null;
  region_id: string | null;
  post_id: string | null;
  status: Order_status;
  total_price: number;
  current_batch_id?: string | null;
  courier_id?: string | null;
  holder_courier_id?: string | null;
  holder_type?: string | null;
  holder_branch_id?: string | null;
  branch_id?: string | null;
  isDeleted?: boolean;
};
type RehomeData = {
  district_id: string;
  target_region_id: string;
  moved: number;
  order_ids: string[];
  from_post_ids: string[];
  to_post_id: string | null;
  to_post_ids: string[];
  deleted_post_ids: string[];
  skipped: Array<{ order_id: string; reason: string }>;
};

const ADMIN = { id: '1', roles: ['admin'] };
/** `branch.find_hq` javobidagi HQ filial id'si. */
const HQ = '1';

const matches = (value: unknown, cond: unknown): boolean => {
  if (cond instanceof FindOperator) {
    if (cond.type === 'isNull') {
      return value === null || value === undefined;
    }
    throw new Error(`Kutilmagan FindOperator: ${cond.type}`);
  }
  return value === cond;
};

function setup(options: {
  district?: Row | null;
  posts: PostRow[];
  orders: OrderState[];
  /** `order.update` shu buyurtma uchun (post_id yozishda) yiqiladi. */
  failUpdateFor?: string;
  /**
   * Shu buyurtmaning birinchi post_id yozuvi QO'LLANADI, lekin javob xato
   * (5 s timeout'dan keyin kechikib qo'llangan); keyingilari yiqiladi.
   */
  lateApplyFor?: string;
  /** `branch.find_hq` javobi; `null` — HQ topilmadi. */
  hqBranchId?: string | null;
  /** `order.find_by_id` (ko'chirishdan oldingi qayta o'qish) oldidan. */
  beforeFindById?: (
    id: string,
    state: { orders: OrderState[]; posts: Map<string, PostRow> },
  ) => void;
  /** Muvaffaqiyatli `order.update` dan keyin. */
  afterUpdate?: (
    id: string,
    state: { orders: OrderState[]; posts: Map<string, PostRow> },
  ) => void;
}) {
  const posts = new Map<string, PostRow>(
    options.posts.map((post) => [post.id, { ...post }]),
  );
  const orders = options.orders.map((order) => ({ ...order }));
  const state = { orders, posts };
  const lateApplied = new Set<string>();
  let createdSeq = 0;

  const orderClient = {
    send: jest.fn(
      (
        pattern: { cmd: string },
        payload: { id?: string; dto?: Row; query?: Row },
      ) => {
        if (pattern.cmd === 'order.find_all') {
          const query = payload.query ?? {};
          const postIds = query.post_ids as string[] | undefined;
          const rows = orders.filter(
            (order) =>
              !order.isDeleted &&
              (!postIds || postIds.includes(String(order.post_id))) &&
              (!query.district_id || order.district_id === query.district_id),
          );
          return of({
            statusCode: 200,
            data: { data: rows.map((row) => ({ ...row })) },
          });
        }
        if (pattern.cmd === 'order.find_by_id') {
          options.beforeFindById?.(String(payload.id), state);
          const row = orders.find((order) => order.id === payload.id);
          return row
            ? of({ ...row })
            : throwError(() => ({ statusCode: 404, message: 'yo‘q' }));
        }
        if (pattern.cmd === 'order.update') {
          const order = orders.find((row) => row.id === payload.id);
          const writesPost = !!payload.dto && 'post_id' in payload.dto;
          if (options.failUpdateFor === payload.id && writesPost) {
            return throwError(() => ({ statusCode: 500, message: 'boom' }));
          }
          if (options.lateApplyFor === payload.id && writesPost) {
            if (!lateApplied.has(String(payload.id)) && order) {
              lateApplied.add(String(payload.id));
              Object.assign(order, payload.dto);
            }
            return throwError(() => ({ statusCode: 502, message: 'timeout' }));
          }
          if (order) {
            Object.assign(order, payload.dto);
          }
          options.afterUpdate?.(String(payload.id), state);
          return of({ statusCode: 200 });
        }
        return of({});
      },
    ),
  };

  const postRepo = {
    find: jest.fn((query?: { where?: Row }) =>
      Promise.resolve(
        Array.from(posts.values()).filter(
          (post) => !query?.where?.status || post.status === query.where.status,
        ),
      ),
    ),
    findOne: jest.fn((query: { where: Row }) =>
      Promise.resolve(
        Array.from(posts.values()).find((post) =>
          Object.entries(query.where).every(([key, cond]) =>
            matches((post as unknown as Row)[key], cond),
          ),
        ) ?? null,
      ),
    ),
    create: jest.fn((payload: Row) => ({ ...payload })),
    save: jest.fn((entity: PostRow) => {
      if (!entity.id) {
        createdSeq += 1;
        entity.id = `90${createdSeq}`;
      }
      posts.set(entity.id, entity);
      return Promise.resolve(entity);
    }),
    remove: jest.fn((entity: PostRow) => {
      posts.delete(entity.id);
      return Promise.resolve(entity);
    }),
    update: jest.fn((where: Row, patch: Partial<PostRow>) => {
      const hit = Array.from(posts.values()).filter((post) =>
        Object.entries(where).every(([key, cond]) =>
          matches((post as unknown as Row)[key], cond),
        ),
      );
      hit.forEach((post) => Object.assign(post, patch));
      return Promise.resolve({ affected: hit.length });
    }),
    delete: jest.fn((where: Row) => {
      const hit = Array.from(posts.values()).filter((post) =>
        Object.entries(where).every(([key, cond]) =>
          matches((post as unknown as Row)[key], cond),
        ),
      );
      hit.forEach((post) => posts.delete(post.id));
      return Promise.resolve({ affected: hit.length });
    }),
  };

  const baseDistrict = {
    id: '12',
    name: 'Chilonzor',
    region_id: '1',
    assigned_region: '7',
    serving_branch_id: null,
  };
  const districtRepo = {
    findOne: jest.fn(() =>
      Promise.resolve(
        options.district === null
          ? null
          : { ...baseDistrict, ...(options.district ?? {}) },
      ),
    ),
    save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
  };
  const regionRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '7', name: 'Namangan' }),
  };
  const searchClient = { send: jest.fn(() => of({})) };
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.find_hq'
        ? of(
            options.hqBranchId === null
              ? { statusCode: 404, data: null }
              : { statusCode: 200, data: { id: options.hqBranchId ?? HQ } },
          )
        : of({}),
    ),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new LogisticsServiceService(
    postRepo as any,
    regionRepo as any,
    districtRepo as any,
    orderClient as any,
    branchClient as any,
    { send: jest.fn(() => of({})) } as any,
    searchClient as any,
    activityLog as any,
  );

  const orderUpdates = () =>
    orderClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'order.update')
      .map(([, payload]) => payload as { id: string; dto: Row });

  return {
    service,
    posts,
    orders,
    postRepo,
    districtRepo,
    orderClient,
    branchClient,
    searchClient,
    activityLog,
    orderUpdates,
  };
}

/** A viloyati (#1) NEW pochtasi; B (#7) — tuman yangi xizmat viloyati. */
const postA = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: '100',
  courier_id: '0',
  region_id: '1',
  branch_id: null,
  status: Post_status.NEW,
  order_quantity: 6,
  post_total_price: 0,
  ...overrides,
});

const order = (
  id: string,
  overrides: Partial<OrderState> = {},
): OrderState => ({
  id,
  district_id: '12',
  region_id: '1',
  post_id: '100',
  status: Order_status.RECEIVED,
  total_price: 1000,
  current_batch_id: null,
  courier_id: null,
  holder_courier_id: null,
  holder_type: 'HQ',
  ...overrides,
});

async function expectRpcStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    throw new Error('Expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect(
      ((error as RpcException).getError() as { statusCode?: number })
        .statusCode,
    ).toBe(status);
  }
}

describe('rehomeOpenDistrictOrders — HQ NEW pochtasidagi tuman buyurtmalarini ko‘chirish', () => {
  it('faqat shu tumanning RECEIVED buyurtmalari A → B (yaratiladi); hisoblagichlar qayta hisoblanadi; region_id yuborilmaydi', async () => {
    const ctx = setup({
      posts: [
        postA(),
        // Kuryerga ketgan (SENT) pochta — nomzod emas.
        {
          id: '300',
          courier_id: '55',
          region_id: '1',
          branch_id: null,
          status: Post_status.SENT,
          order_quantity: 1,
          post_total_price: 4000,
        },
      ],
      orders: [
        order('1', { total_price: 10000 }),
        order('2', { total_price: 5000 }),
        order('3', { district_id: '99', total_price: 7000 }),
        order('4', { status: Order_status.CANCELLED, total_price: 2000 }),
        order('5', { current_batch_id: '77', total_price: 3000 }),
        order('6', { courier_id: '300', total_price: 1500 }),
        order('7', {
          post_id: '300',
          status: Order_status.ON_THE_ROAD,
          total_price: 4000,
        }),
      ],
    });

    const response = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { statusCode: number; data: RehomeData };

    expect(response.statusCode).toBe(200);
    const created = Array.from(ctx.posts.values()).find(
      (post) => post.region_id === '7',
    );
    expect(created).toMatchObject({
      courier_id: '0',
      region_id: '7',
      branch_id: null,
      status: Post_status.NEW,
      order_quantity: 2,
      post_total_price: 15000,
    });
    expect(response.data).toEqual({
      district_id: '12',
      target_region_id: '7',
      moved: 2,
      order_ids: ['1', '2'],
      from_post_ids: ['100'],
      to_post_id: created!.id,
      to_post_ids: [created!.id],
      deleted_post_ids: [],
      skipped: [
        { order_id: '4', reason: 'status_not_received' },
        { order_id: '5', reason: 'in_transfer_batch' },
        { order_id: '6', reason: 'held_by_courier' },
      ],
    });

    // Ko'chirish — faqat post_id; region_id umuman yuborilmaydi.
    const updates = ctx.orderUpdates();
    expect(updates).toEqual([
      { id: '1', dto: { post_id: created!.id } },
      { id: '2', dto: { post_id: created!.id } },
    ]);
    for (const update of updates) {
      expect(update.dto).not.toHaveProperty('region_id');
    }
    expect(ctx.orders.find((row) => row.id === '1')).toMatchObject({
      post_id: created!.id,
      region_id: '1',
    });
    expect(ctx.orders.find((row) => row.id === '7')?.post_id).toBe('300');

    // Manba pochta qoladi (boshqa buyurtmalari bor) — hisoblagichi qayta hisoblangan.
    expect(ctx.posts.get('100')).toMatchObject({
      order_quantity: 4,
      post_total_price: 7000 + 2000 + 3000 + 1500,
    });
    expect(ctx.postRepo.delete).not.toHaveBeenCalled();
    expect(ctx.postRepo.remove).not.toHaveBeenCalled();

    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Post',
        entity_id: created!.id,
        action: 'logistics.post_rehome_district_orders',
        user_id: '1',
        user_role: 'admin',
        metadata: expect.objectContaining({
          district_id: '12',
          target_region_id: '7',
          order_count: 2,
          order_ids: ['1', '2'],
          from_post_ids: ['100'],
          skipped_count: 3,
        }),
      }),
    );
  });

  it('bo‘shagan manba NEW pochta o‘chiriladi; mavjud B pochtasi (shu filial o‘lchovi bilan) ishlatiladi', async () => {
    const ctx = setup({
      posts: [
        postA({ id: '101', branch_id: '1', order_quantity: 1 }),
        // B viloyatining boshqa filial o'lchovidagi pochtasi — tanlanmaydi.
        {
          id: '199',
          courier_id: '0',
          region_id: '7',
          branch_id: null,
          status: Post_status.NEW,
          order_quantity: 0,
          post_total_price: 0,
        },
        {
          id: '200',
          courier_id: '0',
          region_id: '7',
          branch_id: '1',
          status: Post_status.NEW,
          order_quantity: 1,
          post_total_price: 1000,
        },
      ],
      orders: [
        order('8', { post_id: '101', total_price: 2500 }),
        order('9', {
          post_id: '200',
          district_id: '50',
          region_id: '7',
          total_price: 1000,
        }),
      ],
    });

    const response = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { data: RehomeData };

    expect(response.data).toMatchObject({
      moved: 1,
      order_ids: ['8'],
      from_post_ids: ['101'],
      to_post_id: '200',
      deleted_post_ids: ['101'],
      skipped: [],
    });
    expect(ctx.postRepo.create).not.toHaveBeenCalled();
    expect(ctx.posts.has('101')).toBe(false);
    // Eskirgan obyekt emas — faqat hali NEW bo'lsa o'chiriladi.
    expect(ctx.postRepo.delete).toHaveBeenCalledWith({
      id: '101',
      status: Post_status.NEW,
    });
    expect(ctx.postRepo.remove).not.toHaveBeenCalled();
    expect(ctx.searchClient.send).toHaveBeenCalledWith(
      { cmd: 'search.index.remove' },
      { source: 'logistics', type: 'post', sourceId: '101' },
    );
    expect(ctx.posts.get('200')).toMatchObject({
      order_quantity: 2,
      post_total_price: 3500,
    });
    expect(ctx.posts.get('199')).toMatchObject({ order_quantity: 0 });
  });

  it('idempotent: ikkinchi chaqiruvda hech narsa ko‘chmaydi, pochta yaratilmaydi', async () => {
    const ctx = setup({
      posts: [postA()],
      orders: [
        order('1'),
        order('2'),
        order('3', { district_id: '99' }),
        order('4', { status: Order_status.CANCELLED }),
      ],
    });

    const first = (await ctx.service.rehomeOpenDistrictOrders('12', ADMIN)) as {
      data: RehomeData;
    };
    expect(first.data.moved).toBe(2);
    const updatesAfterFirst = ctx.orderUpdates().length;
    const postsAfterFirst = ctx.posts.size;
    ctx.activityLog.log.mockClear();

    const second = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { statusCode: number; data: RehomeData };

    expect(second.statusCode).toBe(200);
    expect(second.data).toMatchObject({
      moved: 0,
      order_ids: [],
      from_post_ids: [],
      to_post_id: null,
      deleted_post_ids: [],
      skipped: [{ order_id: '4', reason: 'status_not_received' }],
    });
    expect(ctx.orderUpdates()).toHaveLength(updatesAfterFirst);
    expect(ctx.posts.size).toBe(postsAfterFirst);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('yarmida yiqilsa: ko‘chganlar eski pochtaga qaytadi, yaratilgan pochta o‘chiriladi, hisoblagichlar o‘zgarmaydi', async () => {
    const ctx = setup({
      posts: [postA({ order_quantity: 2, post_total_price: 2000 })],
      orders: [order('1'), order('2')],
      failUpdateFor: '2',
    });

    await expectRpcStatus(
      ctx.service.rehomeOpenDistrictOrders('12', ADMIN),
      500,
    );

    expect(ctx.orders.map((row) => row.post_id)).toEqual(['100', '100']);
    const updates = ctx.orderUpdates();
    const createdId = updates[0].dto.post_id as string;
    // Javobi kelmagan (yiqilgan) buyurtma ham kompensatsiyaga kiradi.
    expect(
      updates.map(({ id, dto }) => `${id}->${String(dto.post_id)}`),
    ).toEqual([`1->${createdId}`, `2->${createdId}`, '2->100', '1->100']);
    expect(ctx.posts.has(createdId)).toBe(false);
    expect(ctx.posts.get('100')).toMatchObject({
      order_quantity: 2,
      post_total_price: 2000,
    });
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('LC-03: filial omboridagi (holder BRANCH, HQ emas) buyurtma ko‘chmaydi — not_in_hq_custody', async () => {
    const ctx = setup({
      posts: [postA()],
      orders: [
        order('1'),
        // Viloyat filiali (#5) qabul qilgan, hali kuryerga bermagan.
        order('2', {
          holder_type: 'BRANCH',
          holder_branch_id: '5',
          branch_id: '5',
        }),
        // HQ'ning o'zi (holder BRANCH = HQ) — ko'chadi.
        order('3', { holder_type: 'BRANCH', holder_branch_id: HQ }),
      ],
    });

    const response = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { data: RehomeData };

    expect(response.data).toMatchObject({
      moved: 2,
      order_ids: ['1', '3'],
      skipped: [{ order_id: '2', reason: 'not_in_hq_custody' }],
    });
    expect(ctx.orders.find((row) => row.id === '2')?.post_id).toBe('100');
    expect(ctx.orderUpdates().map(({ id }) => id)).toEqual(['1', '3']);
  });

  it('HQ aniqlanmasa — xato, hech narsa ko‘chmaydi (fail closed)', async () => {
    const ctx = setup({
      posts: [postA()],
      orders: [order('1')],
      hqBranchId: null,
    });

    await expectRpcStatus(
      ctx.service.rehomeOpenDistrictOrders('12', ADMIN),
      404,
    );

    expect(ctx.orderUpdates()).toEqual([]);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.orders[0].post_id).toBe('100');
  });

  it('tsikl davomida o‘zgargan buyurtma (kuryerga berilgan / boshqa pochtaga o‘tgan) ko‘chmaydi — changed_during_rehome', async () => {
    const ctx = setup({
      posts: [postA()],
      orders: [order('1'), order('2'), order('3')],
      beforeFindById: (id, state) => {
        const row = state.orders.find((o) => o.id === id)!;
        if (id === '2') {
          // HQ kuryerga jo'natdi (sendPost): yo'lda, kuryerda.
          Object.assign(row, {
            status: Order_status.ON_THE_ROAD,
            courier_id: '55',
            holder_type: 'COURIER',
          });
        }
        if (id === '3') {
          row.post_id = '555';
        }
      },
    });

    const response = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { data: RehomeData };

    expect(response.data).toMatchObject({
      moved: 1,
      order_ids: ['1'],
      skipped: [
        { order_id: '2', reason: 'changed_during_rehome' },
        { order_id: '3', reason: 'changed_during_rehome' },
      ],
    });
    expect(ctx.orderUpdates().map(({ id }) => id)).toEqual(['1']);
    expect(ctx.orders.find((row) => row.id === '2')).toMatchObject({
      post_id: '100',
      status: Order_status.ON_THE_ROAD,
    });
    expect(ctx.orders.find((row) => row.id === '3')?.post_id).toBe('555');
  });

  it('maqsad pochta tsikl davomida kuryerga jo‘natilsa: qolganlari ko‘chmaydi, SENT pochta NEW ga qaytmaydi', async () => {
    const ctx = setup({
      posts: [
        postA({ order_quantity: 2, post_total_price: 2000 }),
        {
          id: '200',
          courier_id: '0',
          region_id: '7',
          branch_id: null,
          status: Post_status.NEW,
          order_quantity: 0,
          post_total_price: 0,
        },
      ],
      orders: [order('1'), order('2')],
      afterUpdate: (id, state) => {
        if (id === '1') {
          // HQ B pochtasini to'liq kuryerga jo'natdi (sendPost).
          Object.assign(state.posts.get('200')!, {
            status: Post_status.SENT,
            courier_id: '55',
            order_quantity: 1,
            post_total_price: 1000,
          });
        }
      },
    });

    const response = (await ctx.service.rehomeOpenDistrictOrders(
      '12',
      ADMIN,
    )) as { data: RehomeData };

    expect(response.data).toMatchObject({
      moved: 1,
      order_ids: ['1'],
      to_post_id: '200',
      skipped: [{ order_id: '2', reason: 'target_post_not_new' }],
    });
    expect(ctx.orders.find((row) => row.id === '2')?.post_id).toBe('100');
    // Hisoblagich qayta hisobi eskirgan obyektni yozmaydi.
    expect(ctx.posts.get('200')).toMatchObject({
      status: Post_status.SENT,
      courier_id: '55',
    });
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.posts.get('100')).toMatchObject({
      order_quantity: 1,
      post_total_price: 1000,
    });
  });

  it('kechikib qo‘llangan yangilanish: yaratilgan pochtaga buyurtma qolsa — o‘chirilmaydi, hisoblagichi qayta hisoblanadi', async () => {
    const ctx = setup({
      posts: [postA({ order_quantity: 2, post_total_price: 2000 })],
      orders: [order('1'), order('2', { total_price: 2500 })],
      lateApplyFor: '2',
    });

    await expectRpcStatus(
      ctx.service.rehomeOpenDistrictOrders('12', ADMIN),
      502,
    );

    const createdId = ctx.orderUpdates()[0].dto.post_id as string;
    expect(ctx.orders.find((row) => row.id === '1')?.post_id).toBe('100');
    // #2: javobi kelmadi, lekin qo'llangan; qaytarish ham yiqildi.
    expect(ctx.orders.find((row) => row.id === '2')?.post_id).toBe(createdId);
    expect(ctx.posts.get(createdId)).toMatchObject({
      region_id: '7',
      status: Post_status.NEW,
      order_quantity: 1,
      post_total_price: 2500,
    });
    expect(ctx.postRepo.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['manager', { id: '198', roles: ['manager'] }],
    ['courier', { id: '179', roles: ['courier'] }],
    ['logist', { id: '50', roles: ['logist'] }],
    ['so‘rovchisiz', undefined],
  ])('%s — 403, hech narsa o‘qilmaydi', async (_label, requester) => {
    const ctx = setup({ posts: [postA()], orders: [order('1')] });

    await expectRpcStatus(
      ctx.service.rehomeOpenDistrictOrders('12', requester),
      403,
    );

    expect(ctx.districtRepo.findOne).not.toHaveBeenCalled();
    expect(ctx.postRepo.find).not.toHaveBeenCalled();
    expect(ctx.orderClient.send).not.toHaveBeenCalled();
  });

  it('id noto‘g‘ri — 400; tuman yo‘q — 404; xizmat viloyati yo‘q — 400', async () => {
    await expectRpcStatus(
      setup({ posts: [], orders: [] }).service.rehomeOpenDistrictOrders(
        'abc',
        ADMIN,
      ),
      400,
    );
    await expectRpcStatus(
      setup({
        district: null,
        posts: [],
        orders: [],
      }).service.rehomeOpenDistrictOrders('12', ADMIN),
      404,
    );
    const regionless = setup({
      district: { region_id: null, assigned_region: null },
      posts: [postA()],
      orders: [order('1')],
    });
    await expectRpcStatus(
      regionless.service.rehomeOpenDistrictOrders('12', ADMIN),
      400,
    );
    expect(regionless.postRepo.find).not.toHaveBeenCalled();
  });
});

describe('PATCH /district/:id — rehome_open_orders', () => {
  const district = { region_id: '1', assigned_region: '1' };

  it('rehome_open_orders: true — tuman saqlangach ko‘chiriladi, natija data.rehome da', async () => {
    const ctx = setup({
      district,
      posts: [postA()],
      orders: [order('1'), order('2', { district_id: '99' })],
    });

    const response = (await ctx.service.updateDistrict(
      '12',
      { assigned_region: '7', rehome_open_orders: true },
      ADMIN,
    )) as { statusCode: number; data: Row & { rehome: RehomeData } };

    expect(response.statusCode).toBe(200);
    expect(ctx.districtRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '12', assigned_region: '7' }),
    );
    expect(response.data.assigned_region).toBe('7');
    expect(response.data.rehome).toMatchObject({
      district_id: '12',
      target_region_id: '7',
      moved: 1,
      order_ids: ['1'],
      from_post_ids: ['100'],
    });
    expect(response.data.rehome.to_post_id).toEqual(expect.any(String));
    expect(response.data).not.toHaveProperty('rehome_error');
    // Saqlash ko'chirishdan OLDIN.
    expect(ctx.districtRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.postRepo.find.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['berilmagan', {}],
    ['false', { rehome_open_orders: false }],
  ])(
    'rehome_open_orders %s — ko‘chirish chaqirilmaydi, javob avvalgidek',
    async (_label, extra) => {
      const ctx = setup({ district, posts: [postA()], orders: [order('1')] });
      const rehomeSpy = jest.spyOn(
        ctx.service as unknown as { rehomeDistrictOpenOrders: () => unknown },
        'rehomeDistrictOpenOrders',
      );

      const response = (await ctx.service.updateDistrict(
        '12',
        { assigned_region: '7', ...extra },
        ADMIN,
      )) as { statusCode: number; data: Row };

      expect(response.statusCode).toBe(200);
      expect(rehomeSpy).not.toHaveBeenCalled();
      expect(response.data).not.toHaveProperty('rehome');
      expect(response.data).not.toHaveProperty('rehome_error');
      expect(ctx.postRepo.find).not.toHaveBeenCalled();
      expect(ctx.orderClient.send).not.toHaveBeenCalled();
    },
  );

  it('ko‘chirish yiqilsa — tuman saqlangan, PATCH 200, xato data.rehome_error da', async () => {
    const ctx = setup({
      district,
      posts: [postA()],
      orders: [order('1')],
      failUpdateFor: '1',
    });

    const response = (await ctx.service.updateDistrict(
      '12',
      { assigned_region: '7', rehome_open_orders: true },
      ADMIN,
    )) as { statusCode: number; data: Row };

    expect(response.statusCode).toBe(200);
    expect(ctx.districtRepo.save).toHaveBeenCalled();
    expect(response.data.rehome).toBeNull();
    expect(response.data.rehome_error).toEqual({
      statusCode: 500,
      message: 'boom',
    });
    expect(ctx.orders[0].post_id).toBe('100');
  });
});

describe('logistics.district.rehome_open_orders — controller', () => {
  it('id va normallashtirilgan so‘rovchini servisga uzatadi', async () => {
    const rmqService = { ack: jest.fn() };
    const logisticsService = {
      rehomeOpenDistrictOrders: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new LogisticsServiceController(
      rmqService as any,
      logisticsService as any,
      {} as any,
    );
    const context = {
      getPattern: () => 'x',
      getMessage: () => ({}),
    } as unknown as RmqContext;

    await controller.rehomeOpenDistrictOrders(
      {
        id: '12',
        requester: { id: 1 as unknown as string, roles: ['superadmin'] },
      },
      context,
    );

    expect(logisticsService.rehomeOpenDistrictOrders).toHaveBeenCalledWith(
      '12',
      { id: '1', roles: ['superadmin'] },
    );
  });
});
