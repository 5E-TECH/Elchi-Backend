import { RpcException } from '@nestjs/microservices';
import { DataSource, FindOperator } from 'typeorm';
import { of, throwError, type Observable } from 'rxjs';
import { Order_status, Post_status, publicErrorData } from '@app/common';
import {
  COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE,
  LogisticsServiceService,
  NEW_POSTS_ACCESS_UNAVAILABLE_MESSAGE,
  NEW_POSTS_HQ_ONLY_MESSAGE,
  ORDER_IN_OUTGOING_BATCH_MESSAGE,
  POST_NOT_VISIBLE_TO_COURIER_MESSAGE,
  POST_RECEIVE_MANAGER_ONLY_MESSAGE,
} from './logistics-service.service';
import { SCAN_ASSIGN_MESSAGES } from './utils/scan-assign-eligibility';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';

/**
 * anKpzwxk (ega qarori, 2026-11-03) — VILOYAT qamrovi, kuryerga berish,
 * o'tkazma pochtasini qabul qilish va ko'rinish qoidalari (logistics tomoni).
 * Kartadagi qabul mezonlari:
 *  2) filial o'ziga kelgan har qanday buyurtmani istalgan o'z kuryeriga
 *     beradi; tranzit (boshqa viloyat) va chiquvchi partiyadagi — rad;
 *  3) pochtani faqat manzil filial menejeri qabul qiladi; registrator — 403;
 *     superadmin qabuli jurnalga yoziladi;
 *  4) kuryer kelayotgan pochtani ro'yxatda ko'rmaydi; boshqa filial menejeri
 *     «Yangi pochtalar»ni ko'rmaydi;
 *  5) HQ kuryeri boshqa viloyat (Samarqand) buyurtmasini ololmaydi — HQ
 *     qamrov imtiyozi bor buyurtmadan tashqari («eski filialda tugasin»:
 *     tuman HQ viloyatidan ko'chgan yoki deploy paytida HQ kuryerida bo'lgan,
 *     migratsiya 1716000000211);
 *  6) «Eski filialda tugasin» (coverage_exemptions) viloyat ko'chishida ishlaydi.
 *
 * Viloyatlar: 14 — Toshkent (HQ), 8 — Samarqand, 3 — Buxoro.
 * Filiallar: 1 — HQ (Toshkent), 10 — «Samarqand filiali», 11 — «Urgut filiali»
 * (ikkalasi Samarqand viloyatida).
 * Tumanlar: 50 — Urgut (Samarqand; eski `serving_branch_id` = 11 — endi
 * hisobga olinmaydi), 60 — Buxoro tumani, 70 — Buxoro viloyatidan Samarqandga
 * biriktirilgan tuman (`assigned_region`).
 *
 * Rad javoblari gateway orqali ham tekshiriladi (`publicErrorData`): u faqat
 * reason/usage/details ni o'tkazadi — id'lar `details` ichida bo'lishi shart.
 */
type Row = Record<string, unknown>;

const SAMARQAND = '8';
const TOSHKENT = '14';
const BUXORO = '3';

const baseBranches = (): Record<string, Row> => ({
  '1': { id: '1', type: 'HQ', region_id: TOSHKENT, status: 'active' },
  '10': { id: '10', type: 'REGIONAL', region_id: SAMARQAND, status: 'active' },
  '11': { id: '11', type: 'REGIONAL', region_id: SAMARQAND, status: 'active' },
});

const DISTRICTS: Row[] = [
  {
    id: '50',
    name: 'Urgut',
    region_id: SAMARQAND,
    assigned_region: null,
    serving_branch_id: '11',
  },
  {
    id: '60',
    name: 'Buxoro tumani',
    region_id: BUXORO,
    assigned_region: null,
    serving_branch_id: null,
  },
  {
    id: '70',
    name: 'Samarqandga biriktirilgan tuman',
    region_id: BUXORO,
    assigned_region: SAMARQAND,
    serving_branch_id: null,
  },
];

/** Foydalanuvchilar: JWT (rol + filial) va filial biriktiruvi. */
const USERS = {
  superadmin: { id: '1', roles: ['superadmin'] },
  manager10: { id: '77', roles: ['manager'], branch_id: '10' },
  registrator10: { id: '78', roles: ['registrator'], branch_id: '10' },
  branchAccount10: { id: '79', roles: ['branch'], branch_id: '10' },
  manager11: { id: '87', roles: ['manager'], branch_id: '11' },
  courier44: { id: '44', roles: ['courier'], branch_id: '10' },
  hqRegistrator: { id: '90', roles: ['registrator'] },
  hqManager: { id: '92', roles: ['manager'] },
  hqCourier: { id: '91', roles: ['courier'] },
};

const ASSIGNMENTS: Record<string, { branch_id: string; role: string }> = {
  '77': { branch_id: '10', role: 'MANAGER' },
  '78': { branch_id: '10', role: 'REGISTRATOR' },
  '87': { branch_id: '11', role: 'MANAGER' },
  '44': { branch_id: '10', role: 'COURIER' },
  '45': { branch_id: '10', role: 'COURIER' },
  '90': { branch_id: '1', role: 'REGISTRATOR' },
  '92': { branch_id: '1', role: 'MANAGER' },
  '91': { branch_id: '1', role: 'COURIER' },
};

/** Id/qiymat matni (satr yoki son), boshqasi — `null`. */
const asText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

const matchValue = (value: unknown, cond: unknown): boolean => {
  if (cond instanceof FindOperator) {
    if (cond.type === 'in') {
      return (cond.value as unknown[]).map(String).includes(String(value));
    }
    if (cond.type === 'not') {
      return cond.child
        ? !matchValue(value, cond.child)
        : !matchValue(value, cond.value);
    }
    // Sana / son operatorlari (createdAt, order_quantity) bu spec'da ahamiyatsiz.
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

function setup(
  options: {
    orders?: Row[];
    posts?: Row[];
    branches?: Record<string, Row>;
    exemptions?: Row[];
    /**
     * `order.transfer_batch.receive_one_by_scan` (P1b) — order-service
     * simulyatsiyasi; berilmasa `no_batch`.
     */
    scanReceive?: (orders: Map<string, Row>, payload: Row) => Row;
    /** branch-service buyrug'i → shu xato (timeout / rad javobi). */
    branchErrors?: Record<string, unknown>;
  } = {},
) {
  const branches = options.branches ?? baseBranches();
  const orders = new Map(
    (options.orders ?? []).map((order) => [String(order.id), { ...order }]),
  );
  const posts = new Map(
    (options.posts ?? []).map((post) => [String(post.id), { ...post }]),
  );

  const orderClient = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: Row): Observable<unknown> => {
        switch (pattern.cmd) {
          case 'order.find_by_id':
            return of(orders.get(String(payload.id)));
          case 'order.find_by_qr': {
            const found = Array.from(orders.values()).find(
              (order) => order.qr_code_token === payload.token,
            );
            return found
              ? of({ data: found })
              : throwError(() => ({
                  statusCode: 404,
                  message: 'Order topilmadi',
                }));
          }
          case 'order.find_all': {
            const query = (payload.query ?? {}) as Row;
            const rows = Array.from(orders.values()).filter(
              (order) =>
                (query.post_id === undefined ||
                  asText(order.post_id) === asText(query.post_id)) &&
                (query.status === undefined || order.status === query.status) &&
                query.canceled_post_id === undefined,
            );
            return of({ data: { data: rows } });
          }
          case 'order.update': {
            const current = orders.get(String(payload.id));
            if (current) Object.assign(current, payload.dto as Row);
            return of({ statusCode: 200 });
          }
          case 'order.transfer_batch.receive_one_by_scan':
            return of({
              data: options.scanReceive
                ? options.scanReceive(orders, payload)
                : { received: false, reason: 'no_batch' },
            });
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
                ? { ...assignment, branch: branches[assignment.branch_id] }
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
            const row = branches[String(payload.id)];
            return row
              ? of({ statusCode: 200, data: row })
              : throwError(() => ({
                  statusCode: 404,
                  message: 'Filial topilmadi',
                }));
          }
          case 'branch.find_hq':
            return of({ data: branches['1'] });
          default:
            return of({ data: null });
        }
      },
    ),
  };

  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) =>
      pattern.cmd === 'identity.courier.find_by_ids'
        ? of({
            data: ((payload.ids as string[]) ?? []).map((id) => ({
              id,
              status: 'active',
            })),
          })
        : of({ data: [] }),
    ),
  };

  const qb: Record<string, jest.Mock> = {};
  for (const key of [
    'update',
    'set',
    'where',
    'andWhere',
    'setFindOptions',
    'select',
    'addSelect',
  ]) {
    qb[key] = jest.fn(() => qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  qb.getRawOne = jest
    .fn()
    .mockResolvedValue({ orders_total: 0, amount_total: 0 });

  let nextPostId = 900;
  const postRepo = {
    rows: posts,
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        Array.from(posts.values()).find((post) => matchesWhere(post, where)) ??
          null,
      ),
    ),
    find: jest.fn(({ where }: { where?: Row | Row[] } = {}) =>
      Promise.resolve(
        Array.from(posts.values()).filter((post) => matchesWhere(post, where)),
      ),
    ),
    findAndCount: jest.fn(({ where }: { where?: Row | Row[] }) => {
      const rows = Array.from(posts.values()).filter((post) =>
        matchesWhere(post, where),
      );
      return Promise.resolve([rows, rows.length]);
    }),
    create: jest.fn((payload: Row) => ({ ...payload })),
    save: jest.fn((entity: Row) => {
      const id = asText(entity.id) ?? String(nextPostId++);
      const saved = { ...entity, id };
      posts.set(id, saved);
      return Promise.resolve({ ...saved });
    }),
    createQueryBuilder: jest.fn(() => qb),
  };

  const districtRepo = {
    find: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(DISTRICTS.filter((row) => matchesWhere(row, where))),
    ),
  };
  const exemptionRepo = {
    find: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        (options.exemptions ?? []).filter((row) => matchesWhere(row, where)),
      ),
    ),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new LogisticsServiceService(
    postRepo as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
    districtRepo as any,
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
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
    expect(qb.execute).not.toHaveBeenCalled();
  };

  return {
    service,
    orders,
    postRepo,
    branchClient,
    orderClient,
    exemptionRepo,
    activityLog,
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

/** Gateway HTTP javobiga chiqadigan `data` (all-exceptions.filter bilan bir xil). */
const gatewayData = (error: unknown) => publicErrorData(error);

const order = (overrides: Row): Row => ({
  branch_id: '10',
  status: Order_status.RECEIVED,
  courier_id: null,
  holder_courier_id: null,
  post_id: null,
  current_batch_id: null,
  total_price: 100_000,
  region_id: SAMARQAND,
  district_id: null,
  ...overrides,
});

describe('anKpzwxk 2-band — filial kuryerga berishi (assignOrdersToCourier)', () => {
  const assign = (
    ctx: ReturnType<typeof setup>,
    orderIds: string[],
    courierId = '44',
    requester: { id: string; roles: string[] } = USERS.manager10,
  ) =>
    ctx.service.assignOrdersToCourier(requester, {
      order_ids: orderIds,
      courier_id: courierId,
    });

  it('⭐ filialga kelgan Samarqand viloyati buyurtmalari istalgan o‘z kuryeriga (Urgut tumani ham, filial yaratgan ham)', async () => {
    const ctx = setup({
      orders: [
        // Urgut tumani — eski serving_branch_id = 11, lekin endi viloyat qoidasi.
        order({ id: '101', district_id: '50' }),
        // Filialning o'zi yaratgan, mijozi shu viloyatda.
        order({ id: '102', source: 'branch', status: Order_status.NEW }),
        order({ id: '103', status: Order_status.WAITING }),
      ],
    });

    const first: any = await assign(ctx, ['101', '102']);
    const second: any = await assign(ctx, ['103'], '45');

    expect(first.data.assigned_count).toBe(2);
    expect(second.data.assigned_count).toBe(1);
    expect(ctx.orders.get('101')).toMatchObject({ courier_id: '44' });
    expect(ctx.orders.get('103')).toMatchObject({ courier_id: '45' });
  });

  it('⭐ tranzit (boshqa viloyat) — 403 district_not_served_by_branch, «Boshqa viloyat buyurtmasi», hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101' }),
        order({ id: '104', district_id: '60' }),
        order({ id: '105', region_id: BUXORO, status: Order_status.NEW }),
      ],
    });

    const error = await rpcError(assign(ctx, ['101', '104', '105']));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Boshqa viloyat buyurtmasi — kuryerga berilmaydi: #104, #105',
    );
    expect(error.data).toEqual({
      reason: 'district_not_served_by_branch',
      order_ids: ['104', '105'],
      details: { order_ids: ['104', '105'] },
    });
    expect(gatewayData(error)).toEqual({
      reason: 'district_not_served_by_branch',
      details: { order_ids: ['104', '105'] },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ chiquvchi partiyadagi buyurtma — 409 order_in_outgoing_batch, details.order_ids, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '101' }),
        order({ id: '106', current_batch_id: '7' }),
      ],
    });

    const error = await rpcError(assign(ctx, ['101', '106']));

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe(`${ORDER_IN_OUTGOING_BATCH_MESSAGE}: #106`);
    expect(error.data).toEqual({
      reason: 'order_in_outgoing_batch',
      order_ids: ['106'],
      details: { order_ids: ['106'] },
    });
    // Gateway HTTP javobi: details.order_ids yetib boradi (yuqori darajadagi
    // `order_ids` filtrdan o'tmaydi).
    expect(gatewayData(error)).toEqual({
      reason: 'order_in_outgoing_batch',
      details: { order_ids: ['106'] },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ 6-band: tuman boshqa viloyatga ko‘chgan — eski filial imtiyozi bor buyurtma baribir beriladi', async () => {
    const ctx = setup({
      orders: [order({ id: '107', district_id: '60' })],
      exemptions: [
        {
          order_id: '107',
          branch_id: '10',
          district_id: '60',
          revoked_at: null,
        },
      ],
    });

    const res: any = await assign(ctx, ['107']);

    expect(res.data.assigned_count).toBe(1);
  });
});

describe('anKpzwxk 2-band — kuryer o‘zi skanerlab oladi (scanAssignOrder)', () => {
  const scan = (ctx: ReturnType<typeof setup>, token: string) =>
    ctx.service.scanAssignOrder(USERS.courier44, { qr_token: token });

  it('o‘z viloyati buyurtmasi — oladi', async () => {
    const ctx = setup({
      orders: [order({ id: '101', district_id: '50', qr_code_token: 'Q1' })],
    });

    const res: any = await scan(ctx, 'Q1');

    expect(res.data).toMatchObject({ idempotent: false, order_id: '101' });
  });

  it('⭐ tranzit — 403 «Boshqa viloyat buyurtmasi», hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [order({ id: '104', district_id: '60', qr_code_token: 'Q4' })],
    });

    const error = await rpcError(scan(ctx, 'Q4'));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Boshqa viloyat buyurtmasi — kuryerga berilmaydi: #104',
    );
    expect(gatewayData(error)).toEqual({
      reason: 'district_not_served_by_branch',
      details: { order_ids: ['104'] },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ chiquvchi partiyada — 409 order_in_outgoing_batch, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        order({ id: '106', current_batch_id: '7', qr_code_token: 'Q6' }),
      ],
    });

    const error = await rpcError(scan(ctx, 'Q6'));

    expect(error.statusCode).toBe(409);
    expect(gatewayData(error)).toEqual({
      reason: 'order_in_outgoing_batch',
      details: { order_ids: ['106'] },
    });
    ctx.expectNothingWritten();
  });

  /**
   * P1b: kuryer kelayotgan HQ → filial partiyasidagi posilkani skanerlaydi.
   * order-service `order.region_id` ≠ partiya viloyati bo'lsa posilkani
   * filialga qabul qiladi (NEW, `current_batch_id` bo'shaydi) va `transit`
   * qaytaradi — kuryerga berish-bermaslikni logistikadagi viloyat qoidasi
   * (XIZMAT viloyati) hal qiladi.
   */
  const transitReceive = (orders: Map<string, Row>, payload: Row): Row => {
    const target = orders.get(String(payload.order_id));
    if (target) {
      Object.assign(target, {
        branch_id: String(payload.courier_branch_id),
        holder_branch_id: String(payload.courier_branch_id),
        status: Order_status.NEW,
        current_batch_id: null,
      });
    }
    return {
      received: false,
      reason: 'transit',
      order_id: String(payload.order_id),
    };
  };
  const incomingBatchOrder = (overrides: Row): Row =>
    order({
      branch_id: '1',
      holder_branch_id: null,
      status: Order_status.ON_THE_ROAD,
      current_batch_id: '7',
      ...overrides,
    });

  it('⭐ partiyadan tranzit posilka (Buxoro) — 403 district_not_served_by_branch «Boshqa viloyat buyurtmasi … qabul qilindi», kuryerga yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        incomingBatchOrder({
          id: '104',
          region_id: BUXORO,
          qr_code_token: 'Q104',
        }),
      ],
      scanReceive: transitReceive,
    });

    const error = await rpcError(scan(ctx, 'Q104'));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      "Boshqa viloyat buyurtmasi — posilka filialingizga qabul qilindi, lekin kuryerga berilmaydi (uni o'z viloyatiga partiya/HQ orqali jo'nating): #104",
    );
    expect(gatewayData(error)).toEqual({
      reason: 'district_not_served_by_branch',
      details: { order_ids: ['104'] },
    });
    // Posilka filialda (order-service), kuryerga emas.
    expect(ctx.orders.get('104')).toMatchObject({
      branch_id: '10',
      status: Order_status.NEW,
      courier_id: null,
    });
    ctx.expectNothingWritten();
  });

  it('⭐ partiyadan «tranzit» posilka, lekin tumani Samarqandga biriktirilgan (XIZMAT viloyati — filial viloyati) — kuryer oladi', async () => {
    const ctx = setup({
      orders: [
        incomingBatchOrder({
          id: '108',
          region_id: BUXORO,
          district_id: '70',
          qr_code_token: 'Q108',
        }),
      ],
      scanReceive: transitReceive,
    });

    const res: any = await scan(ctx, 'Q108');

    expect(res.data).toMatchObject({ idempotent: false, order_id: '108' });
    expect(ctx.orders.get('108')).toMatchObject({
      courier_id: '44',
      status: Order_status.ON_THE_ROAD,
    });
  });
});

describe('anKpzwxk 4-band — HQ → filial pochtasini faqat manzil menejeri qabul qiladi (receivePost)', () => {
  const transferPost = (): Row => ({
    id: '40',
    courier_id: '0',
    branch_id: '10',
    region_id: SAMARQAND,
    status: Post_status.SENT,
    qr_code_token: 'POST-40',
  });
  const inTransit = (id: string): Row =>
    order({
      id,
      status: Order_status.ON_THE_ROAD,
      post_id: '40',
      holder_branch_id: null,
    });
  const transferSetup = () =>
    setup({
      posts: [transferPost()],
      orders: [inTransit('101'), inTransit('102')],
    });

  it('⭐ manzil filial (10) menejeri — qabul qiladi, override yozuvi yo‘q', async () => {
    const ctx = transferSetup();

    const res: any = await ctx.service.receivePost(USERS.manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.postRepo.rows.get('40')?.status).toBe(Post_status.RECEIVED);
    expect(ctx.orders.get('101')?.status).toBe(Order_status.WAITING);
    expect(
      ctx.activityLog.log.mock.calls.map(([entry]) => entry.action),
    ).not.toContain('logistics.post_receive_override');
  });

  it.each([
    ['filial registratori', USERS.registrator10],
    ['filial akkaunti (BRANCH)', USERS.branchAccount10],
    ['filial kuryeri', USERS.courier44],
  ])(
    '⭐ %s (manzil filial xodimi) — 403 post_receive_manager_only, details faqat post_id, hech narsa yozilmaydi',
    async (_label, requester) => {
      const ctx = transferSetup();

      const error = await rpcError(
        ctx.service.receivePost(requester, '40', { order_ids: ['101'] }),
      );

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(POST_RECEIVE_MANAGER_ONLY_MESSAGE);
      expect(gatewayData(error)).toEqual({
        reason: 'post_receive_manager_only',
        details: { post_id: '40' },
      });
      ctx.expectNothingWritten();
    },
  );

  it.each([
    ['boshqa filial (Urgut) menejeri', USERS.manager11],
    ['HQ menejeri', USERS.hqManager],
  ])(
    '⭐ %s (begona filial) — ma‘lumotsiz umumiy 403: kod ham, manzil filial ham oshkor qilinmaydi',
    async (_label, requester) => {
      const ctx = transferSetup();

      const error = await rpcError(
        ctx.service.receivePost(requester, '40', { order_ids: ['101'] }),
      );

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(
        'Siz bu branch pochtasini qabul qila olmaysiz',
      );
      expect(JSON.stringify(gatewayData(error) ?? null)).not.toContain('10');
      expect(gatewayData(error)?.reason).toBeUndefined();
      ctx.expectNothingWritten();
    },
  );

  it('⭐ superadmin — favqulodda qabul, jurnalda kim, pochta, manzil filial va override: true', async () => {
    const ctx = transferSetup();

    const res: any = await ctx.service.receivePost(USERS.superadmin, '40', {
      order_ids: ['101'],
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Post',
        entity_id: '40',
        action: 'logistics.post_receive_override',
        user_id: '1',
        user_role: 'superadmin',
        metadata: expect.objectContaining({
          override: true,
          post_id: '40',
          branch_id: '10',
          received_order_ids: ['101'],
        }),
      }),
    );
  });

  it('kuryer pochtasi (courier_id — kuryer) — kuryer o‘z pochtasini avvalgidek qabul qiladi', async () => {
    const ctx = setup({
      posts: [
        {
          id: '41',
          courier_id: '44',
          branch_id: null,
          region_id: SAMARQAND,
          status: Post_status.SENT,
        },
      ],
      orders: [
        order({ id: '111', status: Order_status.ON_THE_ROAD, post_id: '41' }),
      ],
    });

    const res: any = await ctx.service.receivePost(USERS.courier44, '41', {
      order_ids: ['111'],
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.orders.get('111')?.status).toBe(Order_status.WAITING);
    expect(
      ctx.activityLog.log.mock.calls.map(([entry]) => entry.action),
    ).not.toContain('logistics.post_receive_override');
  });
});

describe('anKpzwxk 5-band — kuryer kelayotgan o‘tkazma pochtasini ko‘rmaydi', () => {
  const posts = (): Row[] => [
    // Kelayotgan (hali qabul qilinmagan) HQ → filial pochtasi.
    { id: '40', courier_id: '0', branch_id: '10', status: Post_status.SENT },
    // Qabul qilingan o'tkazma — avvalgidek ko'rinadi.
    {
      id: '42',
      courier_id: '0',
      branch_id: '10',
      status: Post_status.RECEIVED,
    },
    // Kuryerning o'z (qabul qilingan) pochtasi.
    {
      id: '43',
      courier_id: '44',
      branch_id: '10',
      status: Post_status.RECEIVED,
    },
    // Boshqa kuryer pochtasi.
    {
      id: '46',
      courier_id: '45',
      branch_id: '10',
      status: Post_status.RECEIVED,
    },
  ];

  function listSetup() {
    const ctx = setup({ posts: posts() });
    jest
      .spyOn(ctx.service as any, 'repairSentPostBranchAssignments')
      .mockResolvedValue(undefined);
    return ctx;
  }
  const listedIds = (res: any) =>
    (res.data.data as Row[]).map((post) => String(post.id)).sort();

  it('⭐ GET /post (sof kuryer) — SENT o‘tkazma yo‘q; qabul qilingani va o‘z pochtasi bor', async () => {
    const ctx = listSetup();

    const res: any = await ctx.service.findAllPosts(1, 10, {}, USERS.courier44);

    expect(listedIds(res)).toEqual(['42', '43']);
  });

  it('GET /post?status=sent — kelayotgan pochta baribir yo‘q; courier_id=o‘zi — faqat o‘z pochtasi', async () => {
    const ctx = listSetup();

    const sent: any = await ctx.service.findAllPosts(
      1,
      10,
      { status: 'sent' },
      USERS.courier44,
    );
    const own: any = await ctx.service.findAllPosts(
      1,
      10,
      { courier_id: '44' },
      USERS.courier44,
    );

    expect(listedIds(sent)).toEqual([]);
    expect(listedIds(own)).toEqual(['43']);
  });

  it('filial menejeri — kelayotgan pochta ro‘yxatda (avvalgidek)', async () => {
    const ctx = listSetup();

    const res: any = await ctx.service.findAllPosts(1, 10, {}, USERS.manager10);

    expect(listedIds(res)).toEqual(['40', '42', '43', '46']);
  });

  it.each([
    [
      'GET /post/:id',
      (s: LogisticsServiceService) => s.findPostById('40', USERS.courier44),
    ],
    [
      'GET /post/orders/:id',
      (s: LogisticsServiceService) => s.getPostOrders('40', USERS.courier44),
    ],
    [
      'pochta QR skani',
      (s: LogisticsServiceService) =>
        s.findPostWithQr('POST-40', USERS.courier44),
    ],
  ])('⭐ %s — 403 post_not_visible_to_courier', async (_label, call) => {
    const ctx = setup({
      posts: [
        {
          id: '40',
          courier_id: '0',
          branch_id: '10',
          status: Post_status.SENT,
          qr_code_token: 'POST-40',
        },
      ],
    });

    const error = await rpcError(call(ctx.service));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(POST_NOT_VISIBLE_TO_COURIER_MESSAGE);
    expect(gatewayData(error)).toEqual({
      reason: 'post_not_visible_to_courier',
      details: { post_id: '40' },
    });
  });

  it('filial qabul qilgach (RECEIVED) — kuryer pochtani ochadi; menejer SENT ni ham ochadi', async () => {
    const ctx = setup({ posts: posts() });

    const received: any = await ctx.service.findPostById('42', USERS.courier44);
    const managerView: any = await ctx.service.findPostById(
      '40',
      USERS.manager10,
    );

    expect(received.statusCode).toBe(200);
    expect(managerView.statusCode).toBe(200);
  });
});

describe('anKpzwxk 5-band — «Yangi pochtalar» faqat HQ (newPosts)', () => {
  it.each([
    ['boshqa filial menejeri', USERS.manager10],
    ['filial registratori', USERS.registrator10],
    ['filial akkaunti (BRANCH)', USERS.branchAccount10],
    ['kuryer', USERS.courier44],
    ['HQ kuryeri', USERS.hqCourier],
    ['so‘rovchisiz', undefined],
  ])(
    '⭐ %s — 403 new_posts_hq_only, buyurtmalar o‘qilmaydi va yozilmaydi',
    async (_label, requester) => {
      const ctx = setup();

      const error = await rpcError(ctx.service.newPosts({}, requester));

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(NEW_POSTS_HQ_ONLY_MESSAGE);
      expect(error.data).toEqual({ reason: 'new_posts_hq_only' });
      expect(
        ctx.orderClient.send.mock.calls.filter(
          ([pattern]) => pattern.cmd === 'order.find_all',
        ),
      ).toHaveLength(0);
      ctx.expectNothingWritten();
    },
  );

  it.each([
    ['superadmin', USERS.superadmin],
    ['HQ registratori', USERS.hqRegistrator],
    ['HQ menejeri', USERS.hqManager],
  ])('%s — ro‘yxat qaytadi', async (_label, requester) => {
    const ctx = setup();

    const res: any = await ctx.service.newPosts({}, requester);

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['branch.user.find_by_user', 'biriktiruv'],
    ['branch.find_hq', 'HQ (filial turi javobda yo‘q)'],
  ])(
    '⭐ HQ registratori, branch-service javob bermadi (%s) — 503 qayta urinish (403 «faqat HQ» emas)',
    async (cmd) => {
      const branches = baseBranches();
      delete branches['1'].type;
      const ctx = setup({
        branches,
        branchErrors: { [cmd]: new Error('Timeout has occurred') },
      });

      const error = await rpcError(
        ctx.service.newPosts({}, USERS.hqRegistrator),
      );

      expect(error.statusCode).toBe(503);
      expect(error.message).toBe(NEW_POSTS_ACCESS_UNAVAILABLE_MESSAGE);
      expect(error.data).toBeNull();
      expect(
        ctx.orderClient.send.mock.calls.filter(
          ([pattern]) => pattern.cmd === 'order.find_all',
        ),
      ).toHaveLength(0);
      ctx.expectNothingWritten();
    },
  );

  it('branch-service biriktiruvni rad etdi (4xx) — 403 new_posts_hq_only', async () => {
    const ctx = setup({
      branchErrors: {
        'branch.user.find_by_user': { statusCode: 403, message: 'Ruxsat yo‘q' },
      },
    });

    const error = await rpcError(ctx.service.newPosts({}, USERS.hqRegistrator));

    expect(error.statusCode).toBe(403);
    expect(gatewayData(error)).toEqual({ reason: 'new_posts_hq_only' });
  });

  it('biriktiruv javobida filial turi yo‘q — HQ `branch.find_hq` bilan aniqlanadi', async () => {
    const branches = baseBranches();
    delete branches['1'].type;
    const ctx = setup({ branches });

    const res: any = await ctx.service.newPosts({}, USERS.hqRegistrator);

    expect(res.statusCode).toBe(200);
    expect(
      ctx.branchClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'branch.find_hq',
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('anKpzwxk 6-band — HQ kuryeri faqat HQ viloyati buyurtmasini oladi', () => {
  const hqOrder = (overrides: Row): Row =>
    order({ branch_id: '1', holder_branch_id: null, ...overrides });

  it('⭐ skan: Samarqand buyurtmasi (HQ — Toshkent) — 403 hq_courier_region_only, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [hqOrder({ id: '201', district_id: '50', qr_code_token: 'H1' })],
    });

    const error = await rpcError(
      ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H1' }),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(SCAN_ASSIGN_MESSAGES.OUT_OF_HQ_REGION);
    expect(gatewayData(error)).toEqual({
      reason: 'hq_courier_region_only',
      details: { order_ids: ['201'] },
    });
    ctx.expectNothingWritten();
  });

  it('⭐ o‘z WAITING buyurtmasini qayta skan (tumani Samarqandga ko‘chgan) — idempotent 200, 403 emas', async () => {
    const ctx = setup({
      orders: [
        hqOrder({
          id: '204',
          status: Order_status.WAITING,
          courier_id: '91',
          region_id: SAMARQAND,
          qr_code_token: 'H4',
        }),
      ],
    });

    const res: any = await ctx.service.scanAssignOrder(USERS.hqCourier, {
      qr_token: 'H4',
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ idempotent: true, order_id: '204' });
    ctx.expectNothingWritten();
  });

  it('skan: Toshkent buyurtmasi — HQ kuryeri oladi', async () => {
    const ctx = setup({
      orders: [
        hqOrder({ id: '202', region_id: TOSHKENT, qr_code_token: 'H2' }),
      ],
    });

    const res: any = await ctx.service.scanAssignOrder(USERS.hqCourier, {
      qr_token: 'H2',
    });

    expect(res.data).toMatchObject({ idempotent: false, order_id: '202' });
  });

  it('⭐ HQ registratori Samarqand buyurtmasini HQ kuryeriga beradi — 403 hq_courier_region_only', async () => {
    const ctx = setup({
      orders: [
        hqOrder({ id: '202', region_id: TOSHKENT }),
        hqOrder({ id: '203', region_id: SAMARQAND }),
      ],
    });

    const error = await rpcError(
      ctx.service.assignOrdersToCourier(USERS.hqRegistrator, {
        order_ids: ['202', '203'],
        courier_id: '91',
      }),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      `${SCAN_ASSIGN_MESSAGES.OUT_OF_HQ_REGION}: #203`,
    );
    expect(gatewayData(error)).toEqual({
      reason: 'hq_courier_region_only',
      details: { order_ids: ['203'] },
    });
    ctx.expectNothingWritten();
  });

  it('HQ registratori Toshkent buyurtmasini HQ kuryeriga beradi', async () => {
    const ctx = setup({
      orders: [hqOrder({ id: '202', region_id: TOSHKENT })],
    });

    const res: any = await ctx.service.assignOrdersToCourier(
      USERS.hqRegistrator,
      { order_ids: ['202'], courier_id: '91' },
    );

    expect(res.data.assigned_count).toBe(1);
  });

  it('⭐ HQ filialida viloyat yo‘q — skan ham, biriktirish ham 400 branch_region_missing (fail closed)', async () => {
    const branches = baseBranches();
    branches['1'].region_id = null;
    const ctx = setup({
      branches,
      orders: [
        hqOrder({ id: '202', region_id: TOSHKENT, qr_code_token: 'H2' }),
      ],
    });

    const scanError = await rpcError(
      ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H2' }),
    );
    const assignError = await rpcError(
      ctx.service.assignOrdersToCourier(USERS.hqRegistrator, {
        order_ids: ['202'],
        courier_id: '91',
      }),
    );

    expect(scanError.statusCode).toBe(400);
    expect(gatewayData(scanError)).toEqual({
      reason: 'branch_region_missing',
      details: { order_ids: ['202'], branch_id: '1' },
    });
    expect(assignError.statusCode).toBe(400);
    expect(gatewayData(assignError)).toEqual({
      reason: 'branch_region_missing',
      details: { branch_id: '1' },
    });
    ctx.expectNothingWritten();
  });

  describe('«Eski filialda tugasin» — HQ qamrov imtiyozi', () => {
    const hqExemption = (orderId: string, districtId: string | null): Row => ({
      order_id: orderId,
      branch_id: '1',
      district_id: districtId,
      revoked_at: null,
    });
    const assignToHqCourier = (
      ctx: ReturnType<typeof setup>,
      orderIds: string[],
    ) =>
      ctx.service.assignOrdersToCourier(USERS.hqRegistrator, {
        order_ids: orderIds,
        courier_id: '91',
      });

    it('⭐ qaytarilgan (WAITING, kuryersiz) Samarqand buyurtmasi, HQ imtiyozi bor — HQ registratori HQ kuryeriga beradi (200)', async () => {
      // Deploy'dan oldin HQ kuryeriga berilgan, mijoz javob bermadi — qaytish
      // tasdiqlandi (WAITING, courier_id/post_id null, filial HQ).
      const ctx = setup({
        orders: [
          hqOrder({
            id: '205',
            status: Order_status.WAITING,
            district_id: '50',
          }),
        ],
        exemptions: [hqExemption('205', '50')],
      });

      const res = (await assignToHqCourier(ctx, ['205'])) as {
        data: { assigned_count: number };
      };

      expect(res.data.assigned_count).toBe(1);
      expect(ctx.orders.get('205')).toMatchObject({ courier_id: '91' });
    });

    it('⭐ HQ kuryeri imtiyozli Samarqand buyurtmasini skan qilib oladi (200); tumansiz imtiyoz (NULL) ham', async () => {
      const ctx = setup({
        orders: [
          hqOrder({
            id: '206',
            status: Order_status.WAITING,
            district_id: '50',
            qr_code_token: 'H6',
          }),
          hqOrder({
            id: '207',
            status: Order_status.RECEIVED,
            region_id: SAMARQAND,
            qr_code_token: 'H7',
          }),
        ],
        exemptions: [hqExemption('206', '50'), hqExemption('207', null)],
      });

      const first = (await ctx.service.scanAssignOrder(USERS.hqCourier, {
        qr_token: 'H6',
      })) as { data: Row };
      const second = (await ctx.service.scanAssignOrder(USERS.hqCourier, {
        qr_token: 'H7',
      })) as { data: Row };

      expect(first.data).toMatchObject({ idempotent: false, order_id: '206' });
      expect(second.data).toMatchObject({
        idempotent: false,
        order_id: '207',
      });
      expect(ctx.orders.get('206')).toMatchObject({ courier_id: '91' });
    });

    it('⭐ imtiyozsizi avvalgidek 403 (aralashda faqat o‘zi); boshqa filial imtiyozi HQ ga yordam bermaydi', async () => {
      const ctx = setup({
        orders: [
          hqOrder({
            id: '205',
            status: Order_status.WAITING,
            district_id: '50',
          }),
          hqOrder({
            id: '208',
            status: Order_status.WAITING,
            district_id: '50',
            qr_code_token: 'H8',
          }),
        ],
        exemptions: [
          hqExemption('205', '50'),
          { ...hqExemption('208', '50'), branch_id: '10' },
        ],
      });

      const assignError = await rpcError(
        assignToHqCourier(ctx, ['205', '208']),
      );
      const scanError = await rpcError(
        ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H8' }),
      );

      expect(assignError.statusCode).toBe(403);
      expect(assignError.message).toBe(
        `${SCAN_ASSIGN_MESSAGES.OUT_OF_HQ_REGION}: #208`,
      );
      expect(gatewayData(assignError)).toEqual({
        reason: 'hq_courier_region_only',
        details: { order_ids: ['208'] },
      });
      expect(scanError.statusCode).toBe(403);
      expect(gatewayData(scanError)).toEqual({
        reason: 'hq_courier_region_only',
        details: { order_ids: ['208'] },
      });
      ctx.expectNothingWritten();
    });

    it('⭐ imtiyoz boshqa tumanda (buyurtma tumani keyin tahrirlangan) — baribir 403', async () => {
      const ctx = setup({
        orders: [
          hqOrder({
            id: '209',
            status: Order_status.WAITING,
            district_id: '50',
            qr_code_token: 'H9',
          }),
        ],
        exemptions: [hqExemption('209', '60')],
      });

      const assignError = await rpcError(assignToHqCourier(ctx, ['209']));
      const scanError = await rpcError(
        ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H9' }),
      );

      expect(assignError.statusCode).toBe(403);
      expect(gatewayData(assignError)).toEqual({
        reason: 'hq_courier_region_only',
        details: { order_ids: ['209'] },
      });
      expect(scanError.statusCode).toBe(403);
      expect(scanError.message).toBe(SCAN_ASSIGN_MESSAGES.OUT_OF_HQ_REGION);
      ctx.expectNothingWritten();
    });

    it('⭐ imtiyoz jadvalini o‘qib bo‘lmadi — 503 (fail closed), hech narsa yozilmaydi; HQ viloyati buyurtmasi uchun imtiyoz so‘ralmaydi', async () => {
      const ctx = setup({
        orders: [
          hqOrder({
            id: '205',
            status: Order_status.WAITING,
            district_id: '50',
            qr_code_token: 'H5',
          }),
        ],
        exemptions: [hqExemption('205', '50')],
      });
      ctx.exemptionRepo.find.mockRejectedValue(new Error('DB yiqildi'));

      const assignError = await rpcError(assignToHqCourier(ctx, ['205']));
      const scanError = await rpcError(
        ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H5' }),
      );

      expect(assignError.statusCode).toBe(503);
      expect(assignError.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
      expect(scanError.statusCode).toBe(503);
      expect(scanError.message).toBe(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE);
      ctx.expectNothingWritten();

      // Toshkent buyurtmasi — imtiyoz jadvali umuman o'qilmaydi.
      const inRegion = setup({
        orders: [
          hqOrder({ id: '202', region_id: TOSHKENT, qr_code_token: 'H2' }),
        ],
      });
      inRegion.exemptionRepo.find.mockRejectedValue(new Error('DB yiqildi'));
      const res = (await inRegion.service.scanAssignOrder(USERS.hqCourier, {
        qr_token: 'H2',
      })) as { data: Row };
      expect(res.data).toMatchObject({ idempotent: false, order_id: '202' });
      expect(inRegion.exemptionRepo.find).not.toHaveBeenCalled();
    });

    it('HQ viloyati yo‘q — imtiyoz bo‘lsa ham 400 branch_region_missing (birinchi), imtiyoz so‘ralmaydi', async () => {
      const branches = baseBranches();
      branches['1'].region_id = null;
      const ctx = setup({
        branches,
        orders: [
          hqOrder({
            id: '205',
            status: Order_status.WAITING,
            district_id: '50',
            qr_code_token: 'H5',
          }),
        ],
        exemptions: [hqExemption('205', '50')],
      });

      const assignError = await rpcError(assignToHqCourier(ctx, ['205']));
      const scanError = await rpcError(
        ctx.service.scanAssignOrder(USERS.hqCourier, { qr_token: 'H5' }),
      );

      expect(gatewayData(assignError)).toEqual({
        reason: 'branch_region_missing',
        details: { branch_id: '1' },
      });
      expect(gatewayData(scanError)).toEqual({
        reason: 'branch_region_missing',
        details: { order_ids: ['205'], branch_id: '1' },
      });
      expect(ctx.exemptionRepo.find).not.toHaveBeenCalled();
      ctx.expectNothingWritten();
    });
  });
});

/**
 * 5-band HAQIQIY Postgres'da: sof kuryerning `GET /post` OR sharti (o'z
 * pochtasi | courier_id '0' va NEW/SENT emas) TypeORM orqali to'g'ri SQL'ga
 * aylanadi, `total` va yig'indilar ro'yxat bilan mos.
 *
 * Ishga tushirish: LOGISTICS_REGION_COVERAGE_PG_TEST_URI=postgres://...@127.0.0.1:PORT/<nom>_test
 * (faqat lokal *_test baza; o'z sxemasi — boshqa pg spec'lar bilan to'qnashmaydi).
 */
const pgUri = process.env.LOGISTICS_REGION_COVERAGE_PG_TEST_URI;
const pgLocalTestDatabase = (() => {
  if (!pgUri) return false;
  const url = new URL(pgUri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();
const PG_SCHEMA = 'logistics_region_coverage_test';

(pgLocalTestDatabase ? describe : describe.skip)(
  'anKpzwxk 5-band — sof kuryer GET /post (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: LogisticsServiceService;
    let schemaCreated = false;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: pgUri,
        schema: PG_SCHEMA,
        entities: [Post, Region, District],
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA "${PG_SCHEMA}"`);
      schemaCreated = true;
      await db.synchronize();

      const rows: Array<[string, string, string | null, string]> = [
        // [kalit, courier_id, branch_id, status]
        ['incoming', '0', '10', 'sent'],
        ['transferReceived', '0', '10', 'received'],
        ['regionNew', '0', '10', 'new'],
        ['own', '44', '10', 'received'],
        ['other', '45', '10', 'received'],
        ['otherBranchTransfer', '0', '11', 'received'],
      ];
      for (const [key, courierId, branchId, status] of rows) {
        const [row] = await db.query<Array<{ id: string | number }>>(
          `INSERT INTO "${PG_SCHEMA}".posts
             (courier_id, post_total_price, order_quantity, branch_id, status)
           VALUES ($1, 1000, 1, $2, $3) RETURNING id`,
          [courierId, branchId, status],
        );
        ids[key] = String(row.id);
      }

      service = new LogisticsServiceService(
        db.getRepository(Post),
        db.getRepository(Region),
        db.getRepository(District),
        { send: jest.fn(() => of({ data: [] })) } as never,
        { send: jest.fn(() => of({ data: { id: '1' } })) } as never,
        { send: jest.fn(() => of({ data: [] })) } as never,
        { send: jest.fn(() => of({})) } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
      );
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        if (schemaCreated) {
          await db.query(`DROP SCHEMA "${PG_SCHEMA}" CASCADE`);
        }
        await db.destroy();
      }
    });

    const listed = (res: { data: { data: Array<{ id: unknown }> } }) =>
      res.data.data.map((post) => asText(post.id)).sort();

    it('⭐ kelayotgan (SENT) o‘tkazma va NEW yo‘q; qabul qilingan o‘tkazma va o‘z pochtasi bor; total mos', async () => {
      const res = await service.findAllPosts(1, 10, {}, USERS.courier44);

      expect(listed(res)).toEqual([ids.transferReceived, ids.own].sort());
      expect(res.data.total).toBe(2);
      expect(res.data.orders_total).toBe(2);
    });

    it('status=sent — kuryerga hech narsa; filial menejeri kelayotganini ko‘radi', async () => {
      const courier = await service.findAllPosts(
        1,
        10,
        { status: 'sent' },
        USERS.courier44,
      );
      const manager = await service.findAllPosts(
        1,
        10,
        { status: 'sent' },
        USERS.manager10,
      );

      expect(listed(courier)).toEqual([]);
      expect(listed(manager)).toEqual([ids.incoming]);
    });
  },
);
