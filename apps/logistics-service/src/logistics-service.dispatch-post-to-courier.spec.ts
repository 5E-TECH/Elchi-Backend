import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { of, throwError, type Observable } from 'rxjs';
import { Order_status, Post_status, publicErrorData } from '@app/common';
import {
  LogisticsServiceService,
  NEW_POSTS_HQ_ONLY_MESSAGE,
  POST_COURIER_MESSAGES,
} from './logistics-service.service';

/**
 * POCHTA → HQ KURYERI (ega qarori 2026-11-15):
 *  - «Pochta jo'natishda ham agar HQ ning shu viloyatda o'z kurieri bo'lsa u
 *    ham ro'yxatda chiqib kelishi kerak»;
 *  - ro'yxat (`listPostCourierDestinations`) va yozuv
 *    (`dispatchPostToCourier`) BITTA `resolveHqCouriersForRegion` dan o'tadi;
 *  - 6-band qarorining (HQ kuryeri faqat HQ viloyati) istisnosi FAQAT shu
 *    yo'lda: `assignOrdersToCourier` (/dispatch) va skan o'zgarmaydi.
 *
 * Viloyatlar: 14 — Toshkent (HQ), 8 — Samarqand, 3 — Buxoro.
 * Filiallar: 1 — HQ (Toshkent), 10 — «Samarqand filiali».
 * HQ kuryerlari: 91 — oddiy (o'z viloyati Toshkent), 93 — super-kuryer
 * («Xizmat viloyatlari»: Samarqand), 94 — `serves_all_regions`, 95 — faol
 * emas, 96 — o'z viloyati Samarqand (`home`). Filial kuryerlari: 44
 * (Samarqand filiali, Samarqand), 45 (Samarqand filiali, Toshkent viloyati).
 *
 * Rad javoblari gateway orqali ham tekshiriladi (`publicErrorData`): faqat
 * reason/details o'tadi — id'lar `details` ichida bo'lishi shart.
 */
type Row = Record<string, unknown>;

const TOSHKENT = '14';
const SAMARQAND = '8';
const BUXORO = '3';

const BRANCHES: Record<string, Row> = {
  '1': { id: '1', type: 'HQ', region_id: TOSHKENT, status: 'active' },
  '10': { id: '10', type: 'REGIONAL', region_id: SAMARQAND, status: 'active' },
};

const ASSIGNMENTS: Record<string, { branch_id: string; role: string }> = {
  '90': { branch_id: '1', role: 'REGISTRATOR' },
  '78': { branch_id: '10', role: 'REGISTRATOR' },
  '91': { branch_id: '1', role: 'COURIER' },
  '93': { branch_id: '1', role: 'COURIER' },
  '94': { branch_id: '1', role: 'COURIER' },
  '95': { branch_id: '1', role: 'COURIER' },
  '96': { branch_id: '1', role: 'COURIER' },
  '44': { branch_id: '10', role: 'COURIER' },
  '45': { branch_id: '10', role: 'COURIER' },
};

/** identity `admins` (kuryerlar) + `courier_regions`. */
const COURIERS: Record<string, Row & { regions?: string[] }> = {
  '91': { name: 'Bobur Oddiy', region_id: TOSHKENT, status: 'active' },
  '93': {
    name: 'Anvar Super',
    region_id: TOSHKENT,
    status: 'active',
    is_super_courier: true,
    serves_all_regions: false,
    regions: [SAMARQAND],
  },
  '94': {
    name: 'Dilshod Hammasi',
    region_id: TOSHKENT,
    status: 'active',
    is_super_courier: true,
    serves_all_regions: true,
  },
  '95': {
    name: 'Erkin Bloklangan',
    region_id: TOSHKENT,
    status: 'blocked',
    is_super_courier: true,
    regions: [SAMARQAND],
  },
  '96': { name: 'Jasur Uyi', region_id: SAMARQAND, status: 'active' },
  '44': { name: 'Filial Kuryeri', region_id: SAMARQAND, status: 'active' },
  '45': { name: 'Filial Toshkent', region_id: TOSHKENT, status: 'active' },
};

const USERS = {
  superadmin: { id: '1', roles: ['superadmin'] },
  hqRegistrator: { id: '90', roles: ['registrator'] },
  branchRegistrator: { id: '78', roles: ['registrator'] },
};

const asText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

const matchValue = (value: unknown, cond: unknown): boolean => {
  if (cond instanceof FindOperator) {
    if (cond.type === 'in') {
      return (cond.value as unknown[]).map(String).includes(String(value));
    }
    // Sana operatorlari (createdAt) bu spec'da ahamiyatsiz.
    return true;
  }
  if (value === cond) return true;
  return asText(value) !== null && asText(value) === asText(cond);
};

const matchesWhere = (row: Row, where: Row | Row[] | undefined): boolean =>
  !where ||
  (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) => matchValue(row[key], cond)),
  );

/** identity `findAllCouriers` taqlidi (status, region_id, user_ids, sahifa). */
function identityFindAllCouriers(query: Row) {
  const userIds = Array.isArray(query.user_ids)
    ? (query.user_ids as unknown[]).map(String)
    : [];
  const regionId = asText(query.region_id);
  const rows = Object.entries(COURIERS)
    .filter(([id, courier]) => {
      if (query.status && courier.status !== query.status) return false;
      if (userIds.length && !userIds.includes(id)) return false;
      if (regionId) {
        const home = courier.region_id === regionId;
        const listed =
          courier.is_super_courier === true &&
          (courier.serves_all_regions === true ||
            (courier.regions ?? []).includes(regionId));
        if (!home && !listed) return false;
      }
      return true;
    })
    .map(([id, courier]) => {
      // `courier_regions` identity javobida yo'q (alohida jadval).
      const rest: Row = { ...courier };
      delete rest.regions;
      return {
        id,
        role: 'courier',
        phone_number: `+99890000${id.padStart(4, '0')}`,
        is_super_courier: false,
        serves_all_regions: false,
        ...rest,
      };
    });
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 10);
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    meta: {
      page,
      limit,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / limit)),
    },
  };
}

function setup(
  options: {
    orders?: Row[];
    posts?: Row[];
    /** branch-service buyrug'i → shu xato (timeout / transport). */
    branchErrors?: Record<string, unknown>;
    /** identity buyrug'i → shu xato. */
    identityErrors?: Record<string, unknown>;
    /** `order.update` → N-chi chaqiruvda xato (1 dan). */
    failOrderUpdateAt?: number;
  } = {},
) {
  const orders = new Map(
    (options.orders ?? []).map((order) => [String(order.id), { ...order }]),
  );
  const posts = new Map(
    (options.posts ?? []).map((post) => [String(post.id), { ...post }]),
  );

  let orderUpdateCount = 0;
  const orderClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        switch (pattern.cmd) {
          case 'order.find_by_id':
            return of(orders.get(String(payload.id)));
          case 'order.find_all': {
            const query = (payload.query ?? {}) as Row;
            const rows = Array.from(orders.values()).filter(
              (order) =>
                query.post_id === undefined ||
                asText(order.post_id) === asText(query.post_id),
            );
            return of({ data: { data: rows.map((row) => ({ ...row })) } });
          }
          case 'order.update': {
            orderUpdateCount += 1;
            if (orderUpdateCount === options.failOrderUpdateAt) {
              return throwError(() => ({
                statusCode: 409,
                message: 'Buyurtma holati o‘zgardi',
              }));
            }
            const current = orders.get(String(payload.id));
            if (current) Object.assign(current, payload.dto as Row);
            return of({ statusCode: 200 });
          }
          default:
            return of({ data: [] });
        }
      },
    ),
  };

  const branchClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        if (options.branchErrors && pattern.cmd in options.branchErrors) {
          return throwError(() => options.branchErrors?.[pattern.cmd]);
        }
        switch (pattern.cmd) {
          case 'branch.user.find_by_user': {
            const assignment = ASSIGNMENTS[String(payload.user_id)];
            return of({
              data: assignment
                ? { ...assignment, branch: BRANCHES[assignment.branch_id] }
                : null,
            });
          }
          case 'branch.user.find_by_branch':
            return of({
              data: Object.entries(ASSIGNMENTS)
                .filter(([, a]) => a.branch_id === String(payload.branch_id))
                .map(([userId, a]) => ({ user_id: userId, role: a.role })),
            });
          case 'branch.find_by_id': {
            const row = BRANCHES[String(payload.id)];
            return row
              ? of({ statusCode: 200, data: row })
              : throwError(() => ({ statusCode: 404, message: 'yo‘q' }));
          }
          case 'branch.find_hq':
            return of({ data: BRANCHES['1'] });
          default:
            return of({ data: null });
        }
      },
    ),
  };

  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      if (options.identityErrors && pattern.cmd in options.identityErrors) {
        return throwError(() => options.identityErrors?.[pattern.cmd]);
      }
      switch (pattern.cmd) {
        case 'identity.courier.find_all':
          return of({
            data: identityFindAllCouriers((payload.query ?? {}) as Row),
          });
        case 'identity.courier.find_by_ids':
          return of({
            data: ((payload.ids as string[]) ?? [])
              .filter((id) => COURIERS[id])
              .map((id) => ({ id, status: COURIERS[id].status })),
          });
        default:
          return of({ data: [] });
      }
    }),
  };

  // NEW pochta hisoblagichini bo'shatish (`releaseOrderFromNewRegionPost`)
  // — UPDATE ... SET GREATEST(...) taqlidi.
  const counterReleases: Array<{ id: string; delta: number }> = [];
  let pendingSet: Row = {};
  let pendingId: string | null = null;
  const qb: Record<string, jest.Mock> = {};
  for (const key of ['update', 'andWhere', 'select', 'addSelect']) {
    qb[key] = jest.fn(() => qb);
  }
  qb.set = jest.fn((values: Row) => {
    pendingSet = values;
    return qb;
  });
  qb.where = jest.fn((_sql: string, params?: Row) => {
    pendingId = asText(params?.id);
    return qb;
  });
  qb.execute = jest.fn(() => {
    const post = pendingId ? posts.get(pendingId) : undefined;
    const priceSql =
      typeof pendingSet.post_total_price === 'function'
        ? String((pendingSet.post_total_price as () => string)())
        : '';
    const delta = Number(/- (\d+(?:\.\d+)?)/.exec(priceSql)?.[1] ?? 0);
    if (post && pendingId) {
      post.order_quantity = Math.max(Number(post.order_quantity) - 1, 0);
      post.post_total_price = Math.max(
        Number(post.post_total_price) - delta,
        0,
      );
      counterReleases.push({ id: pendingId, delta });
    }
    return Promise.resolve({ affected: post ? 1 : 0 });
  });

  let nextPostId = 900;
  const postRepo = {
    rows: posts,
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        (() => {
          const found = Array.from(posts.values()).find((post) =>
            matchesWhere(post, where),
          );
          return found ? { ...found } : null;
        })(),
      ),
    ),
    find: jest.fn(({ where }: { where?: Row | Row[] } = {}) =>
      Promise.resolve(
        Array.from(posts.values()).filter((post) => matchesWhere(post, where)),
      ),
    ),
    create: jest.fn((payload: Row) => ({ ...payload })),
    save: jest.fn((entity: Row) => {
      const id = asText(entity.id) ?? String(nextPostId++);
      const saved = { createdAt: new Date(), ...entity, id };
      posts.set(id, saved);
      Object.assign(entity, { id });
      return Promise.resolve({ ...saved });
    }),
    remove: jest.fn((entity: Row) => {
      posts.delete(String(entity.id));
      return Promise.resolve(entity);
    }),
    createQueryBuilder: jest.fn(() => qb),
  };

  const districtRepo = { find: jest.fn().mockResolvedValue([]) };
  const exemptionRepo = { find: jest.fn().mockResolvedValue([]) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new LogisticsServiceService(
    postRepo as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
    districtRepo as any,
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})), emit: jest.fn(() => of({})) } as any,
    activityLog as any,
    undefined,
    exemptionRepo as any,
  );

  const orderUpdates = () =>
    orderClient.send.mock.calls.filter(
      ([pattern]) => pattern.cmd === 'order.update',
    );
  const expectNothingWritten = () => {
    expect(orderUpdates()).toHaveLength(0);
    expect(postRepo.save).not.toHaveBeenCalled();
    expect(postRepo.remove).not.toHaveBeenCalled();
    expect(qb.execute).not.toHaveBeenCalled();
    expect(activityLog.log).not.toHaveBeenCalled();
  };

  return {
    service,
    orders,
    posts,
    postRepo,
    orderClient,
    branchClient,
    identityClient,
    activityLog,
    counterReleases,
    orderUpdates,
    expectNothingWritten,
  };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
      data: Row | null;
    };
  }
  throw new Error('RpcException kutilgan edi');
}

const hqOrder = (overrides: Row): Row => ({
  branch_id: '1',
  holder_type: 'HQ',
  holder_branch_id: '1',
  holder_courier_id: null,
  status: Order_status.RECEIVED,
  courier_id: null,
  post_id: '500',
  current_batch_id: null,
  total_price: 100_000,
  region_id: SAMARQAND,
  district_id: null,
  ...overrides,
});

/** Samarqand NEW hudud pochtasi (3 ta buyurtma) va Toshkent NEW pochtasi. */
const basePosts = (): Row[] => [
  {
    id: '500',
    courier_id: '0',
    region_id: SAMARQAND,
    branch_id: null,
    status: Post_status.NEW,
    order_quantity: 3,
    post_total_price: 300_000,
  },
  {
    id: '501',
    courier_id: '0',
    region_id: TOSHKENT,
    branch_id: null,
    status: Post_status.NEW,
    order_quantity: 1,
    post_total_price: 100_000,
  },
];

const baseOrders = (): Row[] => [
  hqOrder({ id: '101' }),
  hqOrder({ id: '102', total_price: 50_000 }),
  hqOrder({ id: '103' }),
  hqOrder({ id: '201', post_id: '501', region_id: TOSHKENT }),
];

const dispatch = (
  ctx: ReturnType<typeof setup>,
  body: { post_id?: string; courier_id?: string; order_ids?: unknown },
  requester: { id: string; roles: string[] } = USERS.superadmin,
) => ctx.service.dispatchPostToCourier(requester, body);

describe('Pochta → HQ kuryeri: ro‘yxat (listPostCourierDestinations)', () => {
  const list = (
    ctx: ReturnType<typeof setup>,
    postId: string,
    requester: { id: string; roles: string[] } = USERS.superadmin,
  ) =>
    ctx.service.listPostCourierDestinations(requester, postId) as Promise<{
      statusCode: number;
      data: {
        post_id: string;
        region_id: string;
        is_hq_region: boolean;
        couriers: Array<{
          courier_user_id: string;
          name: string | null;
          phone: string | null;
          region_match: string;
        }>;
      };
    }>;

  it('⭐ boshqa viloyat (Samarqand): faqat shu viloyatga xizmat qiladigan FAOL HQ kuryerlari, nom bo‘yicha; region_match to‘g‘ri', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = await list(ctx, '500');

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      post_id: '500',
      region_id: SAMARQAND,
      is_hq_region: false,
    });
    expect(res.data.couriers).toEqual([
      {
        courier_user_id: '93',
        name: 'Anvar Super',
        phone: '+998900000093',
        region_match: 'listed',
      },
      {
        courier_user_id: '94',
        name: 'Dilshod Hammasi',
        phone: '+998900000094',
        region_match: 'all_regions',
      },
      {
        courier_user_id: '96',
        name: 'Jasur Uyi',
        phone: '+998900000096',
        region_match: 'home',
      },
    ]);
    const ids = res.data.couriers.map((c) => c.courier_user_id);
    // Oddiy HQ kuryeri (Toshkent) — yo'q; faol emas super-kuryer — yo'q;
    // filial kuryeri (viloyati Samarqand bo'lsa ham) — yo'q.
    expect(ids).not.toContain('91');
    expect(ids).not.toContain('95');
    expect(ids).not.toContain('44');
    // identity'ga faqat HQ kuryerlari, faqat faollar, viloyat filtri bilan.
    const query = ctx.identityClient.send.mock.calls.find(
      ([p]) => p.cmd === 'identity.courier.find_all',
    )?.[1] as { query: Row };
    expect(query.query).toMatchObject({
      status: 'active',
      region_id: SAMARQAND,
      limit: 100,
    });
    expect((query.query.user_ids as string[]).sort()).toEqual(
      ['91', '93', '94', '95', '96'].sort(),
    );
    ctx.expectNothingWritten();
  });

  it('⭐ HQ viloyati (Toshkent): HAR BIR faol HQ kuryeri (hq_region); filial kuryeri chiqmaydi', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = await list(ctx, '501');

    expect(res.data.is_hq_region).toBe(true);
    expect(res.data.couriers.map((c) => c.courier_user_id)).toEqual([
      '93',
      '91',
      '94',
      '96',
    ]);
    expect(res.data.couriers.every((c) => c.region_match === 'hq_region')).toBe(
      true,
    );
    // 45 — filial kuryeri, viloyati Toshkent: baribir yo'q.
    expect(res.data.couriers.map((c) => c.courier_user_id)).not.toContain('45');
    const query = ctx.identityClient.send.mock.calls.find(
      ([p]) => p.cmd === 'identity.courier.find_all',
    )?.[1] as { query: Row };
    expect(query.query).not.toHaveProperty('region_id');
  });

  it('HQ registratori ko‘radi; filial registratori — 403 new_posts_hq_only', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    await expect(list(ctx, '500', USERS.hqRegistrator)).resolves.toMatchObject({
      statusCode: 200,
    });
    const error = await rpcError(list(ctx, '500', USERS.branchRegistrator));
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(NEW_POSTS_HQ_ONLY_MESSAGE);
    expect(publicErrorData(error)?.reason).toBe('new_posts_hq_only');
  });

  it.each([
    [
      'SENT pochta',
      { id: '700', status: Post_status.SENT, courier_id: '0' },
      'sent',
    ],
    [
      'kuryerli NEW pochta',
      { id: '700', status: Post_status.NEW, courier_id: '91' },
      'new',
    ],
  ])('%s — 400 post_not_sendable', async (_label, post, status) => {
    const ctx = setup({
      posts: [{ region_id: SAMARQAND, ...post }],
    });

    const error = await rpcError(list(ctx, '700'));

    expect(error.statusCode).toBe(400);
    expect(publicErrorData(error)).toEqual({
      reason: 'post_not_sendable',
      details: {
        post_id: '700',
        post_status: status,
        post_courier_id: String(post.courier_id),
      },
    });
  });

  it('viloyatsiz pochta — 400 branch_region_missing {missing: post}; yo‘q pochta — 404', async () => {
    const ctx = setup({
      posts: [
        {
          id: '700',
          status: Post_status.NEW,
          courier_id: '0',
          region_id: null,
        },
      ],
    });

    const error = await rpcError(list(ctx, '700'));
    expect(error.statusCode).toBe(400);
    expect(publicErrorData(error)).toEqual({
      reason: 'branch_region_missing',
      details: { post_id: '700', missing: 'post' },
    });

    const missing = await rpcError(list(ctx, '999'));
    expect(missing.statusCode).toBe(404);
    expect(missing.message).toBe('Pochta topilmadi');
  });

  it.each([
    [
      'branch.user.find_by_branch',
      'branch',
      POST_COURIER_MESSAGES.BRANCH_UNAVAILABLE,
    ],
    ['branch.find_hq', 'branch', POST_COURIER_MESSAGES.BRANCH_UNAVAILABLE],
    [
      'identity.courier.find_all',
      'identity',
      POST_COURIER_MESSAGES.IDENTITY_UNAVAILABLE,
    ],
  ])(
    '⭐ %s javob bermadi — 503 (bo‘sh ro‘yxat EMAS)',
    async (cmd, side, message) => {
      const timeoutError = Object.assign(new Error('Timeout has occurred'), {
        name: 'TimeoutError',
      });
      const ctx = setup({
        posts: basePosts(),
        ...(side === 'branch'
          ? { branchErrors: { [cmd]: timeoutError } }
          : { identityErrors: { [cmd]: timeoutError } }),
      });

      const error = await rpcError(list(ctx, '500'));

      expect(error.statusCode).toBe(503);
      expect(error.message).toBe(message);
    },
  );
});

describe('Pochta → HQ kuryeri: yozuv (dispatchPostToCourier)', () => {
  it('⭐ SA, boshqa viloyat, «Xizmat viloyatlari»da shu viloyat bor super-kuryer — beriladi; kuryer pochtasi viloyati = pochta viloyati', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = await dispatch(ctx, {
      post_id: '500',
      courier_id: '93',
      order_ids: ['101', '0102'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Pochta buyurtmalari kuryerga berildi');
    expect(res.data).toEqual({
      post_id: '500',
      courier_id: '93',
      courier_post_id: '900',
      courier_post_created: true,
      moved_order_ids: ['101', '102'],
      moved_orders_count: 2,
      skipped_order_ids: [],
      post_deleted: false,
    });
    expect(ctx.posts.get('900')).toMatchObject({
      courier_id: '93',
      region_id: SAMARQAND,
      status: Post_status.SENT,
      order_quantity: 2,
      post_total_price: 150_000,
    });
    for (const id of ['101', '102']) {
      expect(ctx.orders.get(id)).toMatchObject({
        courier_id: '93',
        status: Order_status.ON_THE_ROAD,
        post_id: '900',
      });
    }
    expect(ctx.orders.get('103')).toMatchObject({ post_id: '500' });
    // NEW → RECEIVED qadami yo'q (faqat RECEIVED beriladi), izoh — pochta.
    expect(ctx.orderUpdates()).toHaveLength(2);
    expect(ctx.orderUpdates()[0][1]).toMatchObject({
      requester: { id: '1', note: 'Pochta #500 HQ kuryeriga berildi' },
    });
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Post',
        entity_id: '900',
        metadata: expect.objectContaining({
          courier_id: '93',
          source_post_id: '500',
          branch_id: '1',
          order_ids: ['101', '102'],
        }) as unknown,
      }),
    );
  });

  it('⭐ NEW pochta hisoblagichlari bo‘shatiladi; pochta qisman bo‘shasa — QOLADI', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = (await dispatch(ctx, {
      post_id: '500',
      courier_id: '93',
      order_ids: ['101', '102'],
    })) as { data: Row };

    expect(ctx.counterReleases).toEqual([
      { id: '500', delta: 100_000 },
      { id: '500', delta: 50_000 },
    ]);
    expect(ctx.posts.get('500')).toMatchObject({
      order_quantity: 1,
      post_total_price: 150_000,
    });
    expect(res.data.post_deleted).toBe(false);
    expect(ctx.postRepo.remove).not.toHaveBeenCalled();
  });

  it('⭐ pochtadagi hamma buyurtma berilsa — NEW pochta o‘chiriladi (post_deleted: true)', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = (await dispatch(ctx, {
      post_id: '500',
      courier_id: '94',
      order_ids: ['101', '102', '103'],
    })) as { data: Row };

    expect(res.data.post_deleted).toBe(true);
    expect(ctx.posts.has('500')).toBe(false);
    expect(res.data.moved_orders_count).toBe(3);
  });

  it('pochtani tozalash yiqilsa ham so‘rov muvaffaqiyatli (post_deleted: false)', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });
    ctx.postRepo.remove.mockRejectedValueOnce(new Error('db down'));

    const res = (await dispatch(ctx, {
      post_id: '500',
      courier_id: '94',
      order_ids: ['101', '102', '103'],
    })) as { statusCode: number; data: Row };

    expect(res.statusCode).toBe(200);
    expect(res.data.post_deleted).toBe(false);
    expect(ctx.orders.get('103')).toMatchObject({ courier_id: '94' });
  });

  it('⭐ kuryerning bugungi ochiq pochtasi QAYTA ishlatiladi (yangisi yaratilmaydi)', async () => {
    const ctx = setup({
      posts: [
        ...basePosts(),
        {
          id: '800',
          courier_id: '93',
          region_id: TOSHKENT,
          status: Post_status.SENT,
          order_quantity: 4,
          post_total_price: 400_000,
          createdAt: new Date(),
        },
      ],
      orders: baseOrders(),
    });

    const res = (await dispatch(ctx, {
      post_id: '500',
      courier_id: '93',
      order_ids: ['101'],
    })) as { data: Row };

    expect(res.data).toMatchObject({
      courier_post_id: '800',
      courier_post_created: false,
    });
    expect(ctx.posts.get('800')).toMatchObject({
      order_quantity: 5,
      post_total_price: 500_000,
    });
    expect(ctx.orders.get('101')).toMatchObject({ post_id: '800' });
    expect(ctx.posts.has('900')).toBe(false);
  });

  it('serves_all_regions kuryeri — istalgan viloyat pochtasini oladi', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    await expect(
      dispatch(ctx, { post_id: '500', courier_id: '94', order_ids: ['103'] }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(ctx.orders.get('103')).toMatchObject({ courier_id: '94' });
  });

  it('⭐ HQ viloyati pochtasi — ISTALGAN faol HQ kuryeri (oddiy kuryer ham) oladi', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    await expect(
      dispatch(ctx, { post_id: '501', courier_id: '91', order_ids: ['201'] }),
    ).resolves.toMatchObject({
      statusCode: 200,
      data: expect.objectContaining({ post_deleted: true }) as unknown,
    });
    expect(ctx.orders.get('201')).toMatchObject({
      courier_id: '91',
      status: Order_status.ON_THE_ROAD,
    });
  });

  it('HQ registratori bera oladi; filial registratori — 403, hech narsa yozilmaydi', async () => {
    const ok = setup({ posts: basePosts(), orders: baseOrders() });
    await expect(
      dispatch(
        ok,
        { post_id: '500', courier_id: '93', order_ids: ['101'] },
        USERS.hqRegistrator,
      ),
    ).resolves.toMatchObject({ statusCode: 200 });

    const ctx = setup({ posts: basePosts(), orders: baseOrders() });
    const error = await rpcError(
      dispatch(
        ctx,
        { post_id: '500', courier_id: '93', order_ids: ['101'] },
        USERS.branchRegistrator,
      ),
    );
    expect(error.statusCode).toBe(403);
    expect(publicErrorData(error)?.reason).toBe('new_posts_hq_only');
    ctx.expectNothingWritten();
  });

  it.each([
    ['SENT pochta', { status: Post_status.SENT, courier_id: '0' }],
    ['kuryerli NEW pochta', { status: Post_status.NEW, courier_id: '91' }],
  ])('%s — 400 post_not_sendable, hech narsa yozilmaydi', async (_l, patch) => {
    const ctx = setup({
      posts: basePosts().map((post) =>
        post.id === '500' ? { ...post, ...patch } : post,
      ),
      orders: baseOrders(),
    });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '93', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      "Pochta #500 kuryerga berilmaydi: faqat yangi ('new'), kuryersiz HQ pochtasi beriladi",
    );
    expect(publicErrorData(error)?.reason).toBe('post_not_sendable');
    ctx.expectNothingWritten();
  });

  it('viloyatsiz pochta — 400 branch_region_missing', async () => {
    const ctx = setup({
      posts: basePosts().map((post) =>
        post.id === '500' ? { ...post, region_id: null } : post,
      ),
      orders: baseOrders(),
    });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '93', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(400);
    expect(publicErrorData(error)?.reason).toBe('branch_region_missing');
    ctx.expectNothingWritten();
  });

  it('⭐ boshqa filial kuryeri (viloyati mos bo‘lsa ham) — 400 courier_not_hq', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '44', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'Kuryer #44 HQ kuryeri emas — pochtani faqat HQ kuryeriga berish mumkin',
    );
    expect(publicErrorData(error)).toEqual({
      reason: 'courier_not_hq',
      details: { courier_id: '44' },
    });
    ctx.expectNothingWritten();
  });

  it('faol emas HQ kuryeri — 400 courier_inactive', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '95', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(POST_COURIER_MESSAGES.COURIER_INACTIVE);
    expect(publicErrorData(error)).toEqual({
      reason: 'courier_inactive',
      details: { courier_id: '95' },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ boshqa viloyat, oddiy HQ kuryeri («Xizmat viloyatlari»da yo‘q) — 403 courier_region_not_served', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '91', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Kuryer bu viloyatga xizmat qilmaydi — «Xizmat viloyatlari»da belgilanmagan',
    );
    expect(publicErrorData(error)).toEqual({
      reason: 'courier_region_not_served',
      details: { courier_id: '91', post_region_id: SAMARQAND },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ tanlangan id shu pochtada yo‘q — 409 order_not_in_post (id’lar), HECH NARSA yozilmaydi', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(
      dispatch(ctx, {
        post_id: '500',
        courier_id: '93',
        order_ids: ['101', '201', '999'],
      }),
    );

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe(
      "Tanlangan 2 ta buyurtma bu pochtada yo'q: #201, #999. Sahifani yangilab, qayta tanlang. Hech narsa berilmadi",
    );
    expect(publicErrorData(error)).toEqual({
      reason: 'order_not_in_post',
      details: { order_ids: ['201', '999'] },
    });
    ctx.expectNothingWritten();
  });

  it.each([
    ['NEW holatdagi', { status: Order_status.NEW }],
    ['WAITING holatdagi', { status: Order_status.WAITING }],
    ['ushlovchi kuryeri bor', { holder_courier_id: '44' }],
    ['kuryeri bor', { courier_id: '91' }],
    ['filial qo‘lidagi', { holder_branch_id: '10', holder_type: 'BRANCH' }],
  ])(
    '%s buyurtma — 400 order_not_dispatchable, hech narsa yozilmaydi',
    async (_label, patch) => {
      const ctx = setup({
        posts: basePosts(),
        orders: baseOrders().map((order) =>
          order.id === '102' ? { ...order, ...patch } : order,
        ),
      });

      const error = await rpcError(
        dispatch(ctx, {
          post_id: '500',
          courier_id: '93',
          order_ids: ['101', '102'],
        }),
      );

      expect(error.statusCode).toBe(400);
      expect(publicErrorData(error)).toEqual({
        reason: 'order_not_dispatchable',
        details: { order_ids: ['102'] },
      });
      ctx.expectNothingWritten();
    },
  );

  it('chiquvchi partiyadagi buyurtma — 409 order_in_outgoing_batch', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders().map((order) =>
        order.id === '103' ? { ...order, current_batch_id: '77' } : order,
      ),
    });

    const error = await rpcError(
      dispatch(ctx, {
        post_id: '500',
        courier_id: '93',
        order_ids: ['101', '103'],
      }),
    );

    expect(error.statusCode).toBe(409);
    expect(publicErrorData(error)).toEqual({
      reason: 'order_in_outgoing_batch',
      details: { order_ids: ['103'] },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ buyurtma xizmat viloyati ≠ pochta viloyati — 409 order_region_mismatch', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders().map((order) =>
        order.id === '103' ? { ...order, region_id: BUXORO } : order,
      ),
    });

    const error = await rpcError(
      dispatch(ctx, {
        post_id: '500',
        courier_id: '93',
        order_ids: ['101', '103'],
      }),
    );

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe(
      '1 ta buyurtma boshqa viloyatniki: #103. Hech narsa berilmadi',
    );
    expect(publicErrorData(error)).toEqual({
      reason: 'order_region_mismatch',
      details: { order_ids: ['103'] },
    });
    ctx.expectNothingWritten();
  });

  it('HQ viloyati pochtasida boshqa viloyat buyurtmasi — mavjud 403 hq_courier_region_only', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders().map((order) =>
        order.id === '201' ? { ...order, region_id: SAMARQAND } : order,
      ),
    });

    const error = await rpcError(
      dispatch(ctx, { post_id: '501', courier_id: '91', order_ids: ['201'] }),
    );

    expect(error.statusCode).toBe(403);
    expect(publicErrorData(error)?.reason).toBe('hq_courier_region_only');
    ctx.expectNothingWritten();
  });

  it('⭐ bekor qilingan / yopilgan buyurtma jimgina o‘tkaziladi; hammasi shunday — 400 no_dispatchable_orders', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders().map((order) =>
        order.id === '102'
          ? { ...order, status: Order_status.CANCELLED }
          : order.id === '103'
            ? { ...order, status: Order_status.CLOSED }
            : order,
      ),
    });

    const res = (await dispatch(ctx, {
      post_id: '500',
      courier_id: '93',
      order_ids: ['101', '102', '103'],
    })) as { data: Row };

    expect(res.data).toMatchObject({
      moved_order_ids: ['101'],
      skipped_order_ids: ['102', '103'],
    });
    expect(ctx.orders.get('102')).toMatchObject({ courier_id: null });

    const none = setup({
      posts: basePosts(),
      orders: baseOrders().map((order) =>
        order.id === '102'
          ? { ...order, status: Order_status.CANCELLED }
          : order,
      ),
    });
    const error = await rpcError(
      dispatch(none, { post_id: '500', courier_id: '93', order_ids: ['102'] }),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(POST_COURIER_MESSAGES.NO_DISPATCHABLE_ORDERS);
    expect(publicErrorData(error)?.reason).toBe('no_dispatchable_orders');
    none.expectNothingWritten();
  });

  it('⭐ yozuv yarmida yiqilsa — yozilgan buyurtma post_id / holati qaytariladi, yangi kuryer pochtasi o‘chiriladi, NEW pochtaga tegilmaydi', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders(),
      // 1 — 101 beriladi; 2 — 102 yiqiladi.
      failOrderUpdateAt: 2,
    });

    const error = await rpcError(
      dispatch(ctx, {
        post_id: '500',
        courier_id: '93',
        order_ids: ['101', '102'],
      }),
    );

    expect(error.statusCode).toBe(409);
    expect(ctx.orders.get('101')).toMatchObject({
      courier_id: null,
      status: Order_status.RECEIVED,
      post_id: '500',
    });
    expect(ctx.orders.get('102')).toMatchObject({ post_id: '500' });
    expect(ctx.posts.has('900')).toBe(false);
    expect(ctx.posts.get('500')).toMatchObject({ order_quantity: 3 });
    expect(ctx.counterReleases).toEqual([]);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it.each([
    ['branch.user.find_by_branch', 'branch'],
    ['branch.find_hq', 'branch'],
    ['identity.courier.find_all', 'identity'],
  ])('⭐ %s javob bermadi — 503, hech narsa yozilmaydi', async (cmd, side) => {
    const down = new Error('connection closed');
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders(),
      ...(side === 'branch'
        ? { branchErrors: { [cmd]: down } }
        : { identityErrors: { [cmd]: down } }),
    });

    const error = await rpcError(
      dispatch(ctx, {
        post_id: '500',
        courier_id: '93',
        order_ids: ['101'],
      }),
    );

    expect(error.statusCode).toBe(503);
    ctx.expectNothingWritten();
  });

  it('kuryer holatini tekshirib bo‘lmasa (identity find_by_ids) — 503', async () => {
    const ctx = setup({
      posts: basePosts(),
      orders: baseOrders(),
      identityErrors: { 'identity.courier.find_by_ids': new Error('down') },
    });

    const error = await rpcError(
      dispatch(ctx, { post_id: '500', courier_id: '91', order_ids: ['101'] }),
    );

    expect(error.statusCode).toBe(503);
    ctx.expectNothingWritten();
  });

  it.each([
    [
      { courier_id: 'abc', order_ids: ['101'] },
      POST_COURIER_MESSAGES.COURIER_ID_INVALID,
    ],
    [
      { courier_id: '93', order_ids: [] },
      POST_COURIER_MESSAGES.ORDER_IDS_REQUIRED,
    ],
    [
      { courier_id: '93', order_ids: ['1.5'] },
      POST_COURIER_MESSAGES.ORDER_IDS_REQUIRED,
    ],
    [{ courier_id: '93' }, POST_COURIER_MESSAGES.ORDER_IDS_REQUIRED],
    [
      {
        courier_id: '93',
        order_ids: Array.from({ length: 1001 }, (_, i) => String(i + 1)),
      },
      POST_COURIER_MESSAGES.ORDER_IDS_TOO_MANY,
    ],
  ])('kirish xatosi %j — 400', async (body, message) => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(dispatch(ctx, { post_id: '500', ...body }));

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(message);
    ctx.expectNothingWritten();
  });
});

describe('Regressiya: /dispatch (assignOrdersToCourier) qoidasi O‘ZGARMAGAN', () => {
  it('⭐ o‘sha super-kuryer + boshqa viloyat buyurtmasi — hamon 403 hq_courier_region_only, hech narsa yozilmaydi', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(USERS.superadmin, {
        order_ids: ['101'],
        courier_id: '93',
      }),
    );

    expect(error.statusCode).toBe(403);
    expect(publicErrorData(error)).toEqual({
      reason: 'hq_courier_region_only',
      details: { order_ids: ['101'] },
    });
    ctx.expectNothingWritten();
  });

  it('HQ viloyati buyurtmasi — /dispatch avvalgidek beradi (umumiy yozuv kodi), kuryer pochtasi viloyati = birinchi buyurtma viloyati', async () => {
    const ctx = setup({ posts: basePosts(), orders: baseOrders() });

    const res = (await ctx.service.assignOrdersToCourier(USERS.superadmin, {
      order_ids: ['201'],
      courier_id: '91',
    })) as { data: Row };

    expect(res.data).toMatchObject({
      order_ids: ['201'],
      courier_id: '91',
      post_created: true,
      assigned_count: 1,
    });
    expect(ctx.posts.get(String(res.data.post_id))).toMatchObject({
      region_id: TOSHKENT,
      order_quantity: 1,
    });
    expect(ctx.orderUpdates()[0][1]).toMatchObject({
      requester: { note: 'Manager tomonidan ommaviy courier biriktirish' },
    });
    // /dispatch NEW pochta hisoblagichiga tegmaydi (avvalgidek).
    expect(ctx.counterReleases).toEqual([]);
  });
});
