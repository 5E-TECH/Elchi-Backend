/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { Order_status, Post_status, Where_deliver } from '@app/common';
import {
  LOGIST_POST_FORBIDDEN_MESSAGE,
  LogisticsServiceService,
  defaultPostOrdersView,
} from './logistics-service.service';
import { LogisticsServiceController } from './logistics-service.controller';

/**
 * Eski pochtalar (ega: "Eski pochtalar bo'sh, yorliq va Excel yo'q"):
 *   - qabul qilingan pochta (`received` / `canceled_received`) sukut bo'yicha
 *     `all` — pochtaga HAR QACHON kirgan buyurtmalar (`order.post_membership.find`
 *     ∪ joriy ko'rsatkichlar), har qatorda `in_post_now`, `membership`,
 *     `current_post_id`;
 *   - joriy (new/sent/canceled) pochta va QR skan — avvalgidek `current`;
 *   - bo'shab qolgan pochta o'z filiali / yuboruvchisi uchun 403 bermaydi;
 *   - kuryer pochtasi QABUL QILINGANDA kuryer filialiga (`branch_id`)
 *     bog'lanadi (SENT paytida emas — HQ dispatch / «Yangi» ro'yxati);
 *   - sof kuryer tarixni (`all`) faqat o'z pochtasida ko'radi;
 *   - qabul qilingan bekor pochta hisoblagichlari nolga tushmaydi.
 */

const BRANCH = '10';
const OTHER_BRANCH = '20';
const HQ = '1';

type Row = Record<string, unknown>;

function makeService(opts: {
  post: Row;
  current?: Row[];
  memberships?: Row[] | 'down';
  history?: Row[] | 'down';
  scopedBranchId?: string | null;
}) {
  const posts = new Map<string, Row>([[String(opts.post.id), opts.post]]);
  const orderSend = jest.fn((pattern: { cmd: string }) => {
    if (pattern.cmd === 'order.post_membership.find') {
      if (opts.memberships === 'down') {
        return throwError(() => new Error('order-service down'));
      }
      return of({ statusCode: 200, data: opts.memberships ?? [] });
    }
    if (pattern.cmd === 'order.summary_by_ids') {
      return of({ data: [] });
    }
    return of({});
  });
  const postRepo = {
    findOne: jest.fn(({ where }: { where: { id?: string } }) =>
      Promise.resolve(
        where?.id ? { ...(posts.get(String(where.id)) ?? {}) } : null,
      ).then((row) => (row && Object.keys(row).length ? row : null)),
    ),
    save: jest.fn((row: Row) => Promise.resolve(row)),
  };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    { send: orderSend } as any,
    { send: jest.fn(() => of({ data: null })) } as any,
    { send: jest.fn(() => of({ data: [] })) } as any,
    { send: jest.fn(() => of({})) } as any,
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  jest
    .spyOn(service as any, 'resolveScopedBranchId')
    .mockResolvedValue(opts.scopedBranchId ?? null);
  const findOrders = jest
    .spyOn(service as any, 'findOrders')
    .mockImplementation(((query: Row) => {
      if (query.post_id) {
        return Promise.resolve(
          (opts.current ?? []).filter(
            (order) => String(order.post_id) === String(query.post_id),
          ),
        );
      }
      if (query.canceled_post_id) {
        return Promise.resolve(
          (opts.current ?? []).filter(
            (order) =>
              String(order.canceled_post_id) === String(query.canceled_post_id),
          ),
        );
      }
      if (query.search_order_ids) {
        if (opts.history === 'down') {
          return Promise.reject(new RpcException({ statusCode: 502 }));
        }
        const ids = new Set(query.search_order_ids as string[]);
        return Promise.resolve(
          (opts.history ?? []).filter((order) => ids.has(String(order.id))),
        );
      }
      return Promise.resolve([]);
    }) as never);
  return { service, orderSend, postRepo, findOrders };
}

const membershipCalls = (orderSend: jest.Mock) =>
  orderSend.mock.calls.filter(
    ([pattern]) => pattern.cmd === 'order.post_membership.find',
  );

/** Filialga qabul qilingan (HQ → filial) eski pochta — buyurtmalar kuryerlarga o'tgan. */
const oldBranchPost = (over: Row = {}): Row => ({
  id: '500',
  status: Post_status.RECEIVED,
  courier_id: '0',
  branch_id: BRANCH,
  region_id: '6',
  region: { id: '6', name: 'Buxoro' },
  qr_code_token: 'POST-OLD-500',
  order_quantity: 2,
  post_total_price: 300_000,
  createdAt: new Date('2026-10-01T08:00:00.000Z'),
  ...over,
});

const movedOrders: Row[] = [
  {
    id: '101',
    post_id: '600',
    canceled_post_id: null,
    status: Order_status.SOLD,
    where_deliver: Where_deliver.ADDRESS,
    total_price: 100_000,
    branch_id: BRANCH,
    holder_branch_id: null,
  },
  {
    id: '102',
    post_id: '601',
    canceled_post_id: null,
    status: Order_status.ON_THE_ROAD,
    where_deliver: Where_deliver.CENTER,
    total_price: 200_000,
    branch_id: BRANCH,
    holder_branch_id: null,
  },
];

const movedMemberships: Row[] = [
  {
    order_id: '102',
    post_id: '500',
    kind: 'DELIVERY',
    joined_at: '2026-10-01T08:05:00.000Z',
    left_at: '2026-10-02T09:00:00.000Z',
    next_post_id: '601',
  },
  {
    order_id: '101',
    post_id: '500',
    kind: 'DELIVERY',
    joined_at: '2026-10-01T08:01:00.000Z',
    left_at: '2026-10-02T08:00:00.000Z',
    next_post_id: '600',
  },
];

const MANAGER = { id: '77', roles: ['manager'] };

describe('defaultPostOrdersView', () => {
  it('qabul qilingan pochta — all, qolganlari — current', () => {
    expect(defaultPostOrdersView(Post_status.RECEIVED)).toBe('all');
    expect(defaultPostOrdersView(Post_status.CANCELED_RECEIVED)).toBe('all');
    expect(defaultPostOrdersView(Post_status.NEW)).toBe('current');
    expect(defaultPostOrdersView(Post_status.SENT)).toBe('current');
    expect(defaultPostOrdersView(Post_status.CANCELED)).toBe('current');
  });
});

describe('getPostOrders — eski pochta (view = all)', () => {
  it('⭐ buyurtmalari kuryer pochtalariga o`tgan eski filial pochtasi — hammasi, in_post_now=false va membership bilan', async () => {
    const { service, orderSend } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(membershipCalls(orderSend)).toHaveLength(1);
    expect(membershipCalls(orderSend)[0][1]).toEqual({ post_ids: ['500'] });
    expect(res.data.view).toBe('all');
    expect(res.data.history_incomplete).toBe(false);
    // Kirgan vaqti bo'yicha: 101 (08:01), keyin 102 (08:05).
    expect(res.data.allOrdersByPostId.map((o: Row) => o.id)).toEqual([
      '101',
      '102',
    ]);
    expect(res.data.allOrdersByPostId[0]).toMatchObject({
      id: '101',
      status: Order_status.SOLD,
      in_post_now: false,
      current_post_id: '600',
      current_canceled_post_id: null,
      membership: {
        joined_at: '2026-10-01T08:01:00.000Z',
        left_at: '2026-10-02T08:00:00.000Z',
        next_post_id: '600',
      },
    });
    expect(res.data.allOrdersByPostId[1]).toMatchObject({
      id: '102',
      in_post_now: false,
      current_post_id: '601',
      membership: { next_post_id: '601' },
    });
    // Jami — pochtaga kirgan barcha buyurtmalar bo'yicha.
    expect(res.data.homeOrders).toEqual({
      homeOrders: 1,
      homeOrdersTotalPrice: 100_000,
    });
    expect(res.data.centerOrders).toEqual({
      centerOrders: 1,
      centerOrdersTotalPrice: 200_000,
    });
    // Pochta meta'si o'zgarmagan.
    expect(res.data.post).toMatchObject({
      id: '500',
      status: Post_status.RECEIVED,
      qr_code_token: 'POST-OLD-500',
      order_quantity: 2,
      branch_id: BRANCH,
    });
  });

  it('joriy a`zo + sobiq a`zo: joriy birinchi, in_post_now=true, ochiq membership', async () => {
    const current: Row = {
      id: '103',
      post_id: '500',
      status: Order_status.RECEIVED,
      where_deliver: Where_deliver.ADDRESS,
      total_price: 50_000,
      branch_id: BRANCH,
    };
    const { service } = makeService({
      post: oldBranchPost(),
      current: [current],
      memberships: [
        ...movedMemberships,
        {
          order_id: '103',
          post_id: '500',
          kind: 'DELIVERY',
          joined_at: '2026-10-01T08:10:00.000Z',
          left_at: null,
          next_post_id: null,
        },
      ],
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.allOrdersByPostId.map((o: Row) => o.id)).toEqual([
      '103',
      '101',
      '102',
    ]);
    expect(res.data.allOrdersByPostId[0]).toMatchObject({
      id: '103',
      in_post_now: true,
      current_post_id: '500',
      membership: {
        joined_at: '2026-10-01T08:10:00.000Z',
        left_at: null,
        next_post_id: null,
      },
    });
  });

  it('bir necha marta kirgan buyurtma — birinchi kirgan, oxirgi chiqqan payt', async () => {
    const { service } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: [
        {
          order_id: '101',
          post_id: '500',
          kind: 'DELIVERY',
          joined_at: '2026-10-03T08:00:00.000Z',
          left_at: '2026-10-04T08:00:00.000Z',
          next_post_id: '600',
        },
        {
          order_id: '101',
          post_id: '500',
          kind: 'DELIVERY',
          joined_at: '2026-10-01T08:00:00.000Z',
          left_at: '2026-10-02T08:00:00.000Z',
          next_post_id: '599',
        },
      ],
      history: [movedOrders[0]],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.allOrdersByPostId).toHaveLength(1);
    expect(res.data.allOrdersByPostId[0].membership).toEqual({
      joined_at: '2026-10-01T08:00:00.000Z',
      left_at: '2026-10-04T08:00:00.000Z',
      next_post_id: '600',
    });
  });

  it('tarix olinmasa — joriy a`zolar qaytadi, history_incomplete=true (yiqilmaydi)', async () => {
    const current: Row = {
      id: '103',
      post_id: '500',
      status: Order_status.RECEIVED,
      total_price: 50_000,
      branch_id: BRANCH,
    };
    const { service } = makeService({
      post: oldBranchPost(),
      current: [current],
      memberships: 'down',
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.history_incomplete).toBe(true);
    expect(res.data.allOrdersByPostId).toEqual([
      expect.objectContaining({
        id: '103',
        in_post_now: true,
        membership: null,
      }),
    ]);
  });

  it('sobiq a`zolarni olib bo`lmasa — history_incomplete=true, joriylar qaytadi', async () => {
    const { service } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: 'down',
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.history_incomplete).toBe(true);
    expect(res.data.allOrdersByPostId).toEqual([]);
  });

  it('bekor pochta (canceled_received) — kind CANCELED, current_canceled_post_id', async () => {
    const { service } = makeService({
      post: oldBranchPost({
        id: '700',
        status: Post_status.CANCELED_RECEIVED,
        courier_id: '44',
      }),
      current: [],
      memberships: [
        {
          order_id: '201',
          post_id: '700',
          kind: 'CANCELED',
          joined_at: '2026-10-05T08:00:00.000Z',
          left_at: '2026-10-06T08:00:00.000Z',
          next_post_id: '701',
        },
      ],
      history: [
        {
          id: '201',
          post_id: '600',
          canceled_post_id: '701',
          status: Order_status.CANCELLED_SENT,
          total_price: 10_000,
          branch_id: BRANCH,
        },
      ],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('700', MANAGER);

    expect(res.data.allOrdersByPostId[0]).toMatchObject({
      id: '201',
      in_post_now: false,
      current_canceled_post_id: '701',
      membership: { next_post_id: '701' },
    });
  });
});

describe('getPostOrders — joriy pochta va skan (view = current) o`zgarmagan', () => {
  const sentRow: Row = {
    id: '301',
    post_id: '800',
    status: Order_status.ON_THE_ROAD,
    where_deliver: Where_deliver.ADDRESS,
    total_price: 70_000,
    branch_id: BRANCH,
  };

  it('⭐ sent pochta — tarix so`ralmaydi, qatorlar va kalitlar avvalgidek', async () => {
    const { service, orderSend } = makeService({
      post: oldBranchPost({
        id: '800',
        status: Post_status.SENT,
        courier_id: '44',
      }),
      current: [sentRow],
      memberships: movedMemberships,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('800', MANAGER);

    expect(membershipCalls(orderSend)).toHaveLength(0);
    expect(res.data.allOrdersByPostId).toEqual([sentRow]);
    expect(Object.keys(res.data).sort()).toEqual(
      ['allOrdersByPostId', 'centerOrders', 'homeOrders', 'post'].sort(),
    );
  });

  it('qabul qilingan pochtada ham view=current — faqat joriy a`zolar', async () => {
    const current: Row = { ...sentRow, post_id: '500' };
    const { service, orderSend } = makeService({
      post: oldBranchPost(),
      current: [current],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER, {
      view: 'current',
    });

    expect(membershipCalls(orderSend)).toHaveLength(0);
    expect(res.data.allOrdersByPostId).toEqual([current]);
    expect(res.data.view).toBeUndefined();
  });

  it('⭐ QR skan (findPostWithQr) eski pochtada ham faqat joriy a`zolarni ko`rsatadi', async () => {
    const current: Row = { ...sentRow, post_id: '500' };
    const { service, orderSend, postRepo } = makeService({
      post: oldBranchPost(),
      current: [current],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });
    postRepo.findOne.mockImplementation(
      (query: { where: { id?: string; qr_code_token?: string } }) =>
        Promise.resolve(
          query.where.qr_code_token === 'POST-OLD-500' ||
            query.where.id === '500'
            ? oldBranchPost()
            : null,
        ),
    );

    const res: any = await service.findPostWithQr('POST-OLD-500', MANAGER);

    expect(membershipCalls(orderSend)).toHaveLength(0);
    expect(res.data.orders.map((o: Row) => o.id)).toEqual(['301']);
  });

  it('kuryer o`z sent pochtasida (current) faqat yo`ldagilarni ko`radi', async () => {
    const delivered: Row = {
      ...sentRow,
      id: '302',
      status: Order_status.SOLD,
    };
    const { service } = makeService({
      post: oldBranchPost({
        id: '800',
        status: Post_status.SENT,
        courier_id: '44',
      }),
      current: [sentRow, delivered],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('800', {
      id: '44',
      roles: ['courier'],
    });

    expect(res.data.allOrdersByPostId.map((o: Row) => o.id)).toEqual(['301']);
  });
});

describe('getPostOrders — bo`shab qolgan eski pochta ruxsati', () => {
  it('⭐ o`z filiali pochtasi (branch_id) — joriy a`zolar yo`q bo`lsa ham 403 emas', async () => {
    const { service } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: [],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.allOrdersByPostId).toEqual([]);
  });

  it('branch_id bo`sh HQ → filial pochtasi: tarixdagi buyurtmalar shu filialda — 403 emas, branch_id yozilmaydi', async () => {
    const { service, postRepo } = makeService({
      post: oldBranchPost({ branch_id: null }),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.allOrdersByPostId).toHaveLength(2);
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('boshqa filial menejeri — 403 (tarix ham boshqa filialda)', async () => {
    const { service } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: OTHER_BRANCH,
    });

    await expect(
      service.getPostOrders('500', { id: '88', roles: ['manager'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('menejer → HQ bekor pochtasi (courier_id = menejer) — o`z pochtasi, 403 emas', async () => {
    const { service } = makeService({
      post: oldBranchPost({
        id: '900',
        status: Post_status.CANCELED_RECEIVED,
        courier_id: MANAGER.id,
        branch_id: HQ,
      }),
      current: [],
      memberships: [],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('900', MANAGER);

    expect(res.data.allOrdersByPostId).toEqual([]);
  });

  it('sof kuryer boshqa kuryer pochtasini (filiali bir xil) ocha olmaydi; o`zinikini ochadi', async () => {
    const courierPost = oldBranchPost({ courier_id: '44' });
    const { service } = makeService({
      post: courierPost,
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    await expect(
      service.getPostOrders('500', { id: '45', roles: ['courier'] }),
    ).rejects.toBeInstanceOf(RpcException);
    const own: any = await service.getPostOrders('500', {
      id: '44',
      roles: ['courier'],
    });
    expect(own.data.allOrdersByPostId).toHaveLength(2);
  });

  it('logist — viloyat qoidasi eski pochtada ham amal qiladi', async () => {
    const { service } = makeService({
      post: oldBranchPost({ region_id: '7' }),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
    });
    jest
      .spyOn(service as any, 'findLogistRegions')
      .mockResolvedValue([{ id: '6' }]);

    await expect(
      service.getPostOrders('500', { id: '5', roles: ['logist'] }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        message: LOGIST_POST_FORBIDDEN_MESSAGE,
      }),
    });
  });
});

describe('getPostOrders — kuryer tarixi, qabul ekrani va vaqt byudjeti', () => {
  const COURIER = { id: '44', roles: ['courier'] };

  it('⭐ sof kuryer filial o`tkazmasi pochtasida (courier_id 0, o`z filiali) `all` so`rasa — 403', async () => {
    const { service, orderSend } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    await expect(
      service.getPostOrders('500', COURIER, { view: 'all' }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(membershipCalls(orderSend)).toHaveLength(0);
  });

  it('sof kuryer filial o`tkazmasi pochtasini sukut bilan ochsa — faqat joriy a`zolar (avvalgidek)', async () => {
    const current: Row = {
      id: '301',
      post_id: '500',
      status: Order_status.WAITING,
      branch_id: BRANCH,
    };
    const { service, orderSend } = makeService({
      post: oldBranchPost(),
      current: [current],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', COURIER);

    expect(membershipCalls(orderSend)).toHaveLength(0);
    expect(res.data.view).toBeUndefined();
    expect(res.data.allOrdersByPostId).toEqual([current]);
  });

  it('kuryer o`z qabul qilingan pochtasida `all` ni oladi', async () => {
    const { service } = makeService({
      post: oldBranchPost({ courier_id: '44' }),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', COURIER, {
      view: 'all',
    });

    expect(res.data.view).toBe('all');
    expect(res.data.allOrdersByPostId).toHaveLength(2);
  });

  it('⭐ hali qabul qilinadigan RECEIVED pochta (yo`ldagi joriy a`zo) — sukut `current`; aniq `all` — tarix', async () => {
    const onTheRoad: Row = {
      id: '301',
      post_id: '500',
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
      branch_id: BRANCH,
    };
    const { service } = makeService({
      post: oldBranchPost(),
      current: [onTheRoad],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const receiveScreen: any = await service.getPostOrders('500', MANAGER);
    expect(receiveScreen.data.view).toBeUndefined();
    expect(receiveScreen.data.allOrdersByPostId).toEqual([onTheRoad]);

    const history: any = await service.getPostOrders('500', MANAGER, {
      view: 'all',
    });
    expect(history.data.view).toBe('all');
    expect(history.data.allOrdersByPostId.map((o: Row) => o.id)).toEqual([
      '301',
      '101',
      '102',
    ]);
  });

  it('sobiq a`zolar so`rovi qolgan byudjet bilan (timeoutMs ≤ 2500)', async () => {
    const { service, findOrders } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    await service.getPostOrders('500', MANAGER);

    const historyCall = findOrders.mock.calls.find(
      ([query]: any[]) => query.search_order_ids,
    ) as any[];
    expect(historyCall[1].timeoutMs).toBeGreaterThanOrEqual(500);
    expect(historyCall[1].timeoutMs).toBeLessThanOrEqual(2500);
  });

  it('⭐ byudjet tugagan (joriy so`rovlar sekin) — sobiq a`zolar so`ralmaydi, history_incomplete=true', async () => {
    const { service, findOrders } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships: movedMemberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(7_300);

    try {
      const res: any = await service.getPostOrders('500', MANAGER);

      expect(res.data.history_incomplete).toBe(true);
      expect(res.data.allOrdersByPostId).toEqual([]);
      expect(
        findOrders.mock.calls.some(([query]: any[]) => query.search_order_ids),
      ).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('sobiq a`zolar 5000 tadan ko`p — 5000 tasi so`raladi (≤ 5 bo`lak), history_incomplete=true', async () => {
    const memberships: Row[] = Array.from({ length: 5001 }, (_, index) => ({
      order_id: String(10_000 + index),
      post_id: '500',
      kind: 'DELIVERY',
      joined_at: new Date(Date.UTC(2026, 9, 1, 8, 0, index % 60)).toISOString(),
      left_at: null,
      next_post_id: null,
    }));
    const { service, findOrders } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships,
      history: [],
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    const historyCalls = findOrders.mock.calls.filter(
      ([query]: any[]) => query.search_order_ids,
    ) as any[];
    expect(historyCalls.length).toBeLessThanOrEqual(5);
    expect(
      historyCalls.reduce(
        (sum, [query]) => sum + query.search_order_ids.length,
        0,
      ),
    ).toBe(5000);
    expect(res.data.history_incomplete).toBe(true);
  });

  it('a`zolik javobi 20 000 qatorda kesilgan — history_incomplete=true', async () => {
    const memberships: Row[] = Array.from({ length: 20_000 }, (_, index) => ({
      ...movedMemberships[index % 2],
    }));
    const { service } = makeService({
      post: oldBranchPost(),
      current: [],
      memberships,
      history: movedOrders,
      scopedBranchId: BRANCH,
    });

    const res: any = await service.getPostOrders('500', MANAGER);

    expect(res.data.allOrdersByPostId).toHaveLength(2);
    expect(res.data.history_incomplete).toBe(true);
  });
});

describe('logistics.post.orders_by_post — payload.view', () => {
  it('view faqat all | current bo`lib servisga uzatiladi', async () => {
    const logisticsService = {
      getPostOrders: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new LogisticsServiceController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      logisticsService as any,
      {} as any,
    );
    const context = {
      getPattern: () => 'x',
      getMessage: () => ({}),
    } as unknown as RmqContext;
    const requester = { id: '1', roles: ['admin'] };

    await controller.ordersByPost({ id: '5', requester, view: 'all' }, context);
    await controller.ordersByPost({ id: '5', requester, view: 'bad' }, context);

    expect(logisticsService.getPostOrders).toHaveBeenNthCalledWith(
      1,
      '5',
      requester,
      { withSenderBranch: false, view: 'all' },
    );
    expect(logisticsService.getPostOrders).toHaveBeenNthCalledWith(
      2,
      '5',
      requester,
      { withSenderBranch: false, view: undefined },
    );
  });
});

describe('findAllPosts — menejer o`z kuryerlari pochtalarini branch_id orqali ko`radi', () => {
  it('⭐ where.branch_id = filial: kuryer pochtasi (branch_id = kuryer filiali) ro`yxatda', async () => {
    const posts: Row[] = [
      {
        id: '601',
        status: Post_status.RECEIVED,
        courier_id: '44',
        branch_id: BRANCH,
      },
      {
        id: '602',
        status: Post_status.RECEIVED,
        courier_id: '55',
        branch_id: OTHER_BRANCH,
      },
    ];
    const totalsQb = {
      setFindOptions: jest.fn(),
      select: jest.fn(),
      addSelect: jest.fn(),
      getRawOne: jest.fn(() => Promise.resolve(undefined)),
    };
    for (const key of ['setFindOptions', 'select', 'addSelect'] as const) {
      totalsQb[key].mockReturnValue(totalsQb);
    }
    const postRepo = {
      find: jest.fn(() => Promise.resolve([])),
      findAndCount: jest.fn(({ where }: { where: Row }) => {
        const rows = posts.filter(
          (post) => !where.branch_id || post.branch_id === where.branch_id,
        );
        return Promise.resolve([rows, rows.length]);
      }),
      createQueryBuilder: jest.fn(() => totalsQb),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn() } as any,
    );
    jest
      .spyOn(service as any, 'resolveScopedBranchId')
      .mockResolvedValue(BRANCH);

    const res: any = await service.findAllPosts(
      1,
      10,
      { status: Post_status.RECEIVED },
      MANAGER,
    );

    expect(postRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch_id: BRANCH,
          status: Post_status.RECEIVED,
        }),
      }),
    );
    expect(res.data.data.map((post: Row) => post.id)).toEqual(['601']);
  });
});

describe('findAllPosts — sof kuryer boshqa kuryerlar pochtasini ro`yxatda ko`rmaydi', () => {
  function listService() {
    const totalsQb = {
      setFindOptions: jest.fn(),
      select: jest.fn(),
      addSelect: jest.fn(),
      getRawOne: jest.fn(() => Promise.resolve(undefined)),
    };
    for (const key of ['setFindOptions', 'select', 'addSelect'] as const) {
      totalsQb[key].mockReturnValue(totalsQb);
    }
    const postRepo = {
      find: jest.fn(() => Promise.resolve([])),
      findAndCount: jest.fn(() => Promise.resolve([[], 0])),
      createQueryBuilder: jest.fn(() => totalsQb),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn() } as any,
    );
    jest
      .spyOn(service as any, 'resolveScopedBranchId')
      .mockResolvedValue(BRANCH);
    jest
      .spyOn(service as any, 'repairSentPostBranchAssignments')
      .mockResolvedValue(undefined);
    return { service, postRepo };
  }
  const PURE_COURIER = { id: '44', roles: ['courier'] };

  it('⭐ courier_id IN (0, o`zi) — filial o`tkazmasi va o`z pochtasi', async () => {
    const { service, postRepo } = listService();
    await service.findAllPosts(1, 10, {}, PURE_COURIER);
    const where = (postRepo.findAndCount.mock.calls[0] as any[])[0].where;
    expect(where.branch_id).toBe(BRANCH);
    expect(where.courier_id).toEqual(
      expect.objectContaining({ _type: 'in', _value: ['0', '44'] }),
    );
  });

  it('⭐ boshqa kuryer filtri — bo`sh sahifa, so`rov yo`q', async () => {
    const { service, postRepo } = listService();
    const res: any = await service.findAllPosts(
      1,
      10,
      { courier_id: '55' },
      PURE_COURIER,
    );
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
    expect(res.data.data).toEqual([]);
  });

  it('menejer (kuryer roli ham bor) — cheklov yo`q', async () => {
    const { service, postRepo } = listService();
    await service.findAllPosts(
      1,
      10,
      {},
      { id: '9', roles: ['manager', 'courier'] },
    );
    const where = (postRepo.findAndCount.mock.calls[0] as any[])[0].where;
    expect(where.courier_id).toBeUndefined();
  });
});

describe('kuryer pochtasi: SENT paytida filialsiz, qabul qilinganda (RECEIVED) kuryer filialida', () => {
  function baseService(overrides?: {
    branchSend?: jest.Mock;
    postFindOne?: jest.Mock;
  }) {
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      findOne: overrides?.postFindOne ?? jest.fn(() => Promise.resolve(null)),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
      remove: jest.fn(() => Promise.resolve(undefined)),
      createQueryBuilder: jest.fn(() => postUpdateQb),
    };
    const branchSend =
      overrides?.branchSend ??
      jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.user.find_by_user'
          ? of({ data: { branch_id: BRANCH, role: 'COURIER' } })
          : of({ data: null }),
      );
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({ ok: true })) } as any,
      { send: branchSend } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service as any, 'updateOrder').mockResolvedValue(undefined);
    return { service, postRepo, branchSend };
  }

  const findByUserCalls = (branchSend: jest.Mock) =>
    branchSend.mock.calls.filter(
      ([pattern]) => pattern.cmd === 'branch.user.find_by_user',
    );

  const sentCourierPost = (over: Row = {}): Row => ({
    id: '450',
    status: Post_status.SENT,
    courier_id: '44',
    branch_id: null,
    region_id: '6',
    qr_code_token: 'POST-450',
    ...over,
  });

  async function assignToCourier() {
    const { service, postRepo, branchSend } = baseService();
    jest
      .spyOn(service as any, 'findBranchAssignmentByUserId')
      .mockResolvedValue({ branch_id: BRANCH, role: 'MANAGER' });
    jest
      .spyOn(service as any, 'findBranchUsersByBranchId')
      .mockResolvedValue([{ user_id: '44', role: 'COURIER' }]);
    jest.spyOn(service as any, 'findOrderById').mockResolvedValue({
      id: '101',
      branch_id: BRANCH,
      status: Order_status.RECEIVED,
      courier_id: null,
      total_price: 100_000,
      region_id: '6',
    });
    jest
      .spyOn(service as any, 'assertOrdersServedByBranch')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'findBranchCoverageRow').mockResolvedValue(null);
    jest.spyOn(service as any, 'findCourierStatus').mockResolvedValue(null);

    await service.assignOrdersToCourier(MANAGER, {
      order_ids: ['101'],
      courier_id: '44',
    });
    return { postRepo, branchSend };
  }

  it('⭐ assignOrdersToCourier — yangi SENT pochta filialsiz (o`tkazma pochtasiga o`xshamasin)', async () => {
    const { postRepo, branchSend } = await assignToCourier();

    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '44',
        status: Post_status.SENT,
      }),
    );
    expect(postRepo.create.mock.calls[0][0]).not.toHaveProperty('branch_id');
    expect(findByUserCalls(branchSend)).toHaveLength(0);
  });

  it('⭐ menejerning «Yangi» (status=sent) ro`yxati: kuryerning yo`ldagi pochtasi yo`q, filial o`tkazmasi bor', async () => {
    const { postRepo: assignRepo } = await assignToCourier();
    const courierPost: Row = {
      ...assignRepo.create.mock.calls[0][0],
      id: '701',
    };
    const transferPost: Row = {
      id: '702',
      status: Post_status.SENT,
      courier_id: '0',
      branch_id: BRANCH,
    };
    const posts = [courierPost, transferPost];
    const totalsQb = {
      setFindOptions: jest.fn(),
      select: jest.fn(),
      addSelect: jest.fn(),
      getRawOne: jest.fn(() => Promise.resolve(undefined)),
    };
    for (const key of ['setFindOptions', 'select', 'addSelect'] as const) {
      totalsQb[key].mockReturnValue(totalsQb);
    }
    const postRepo = {
      find: jest.fn(() => Promise.resolve([])),
      findAndCount: jest.fn(({ where }: { where: Row }) => {
        const rows = posts.filter(
          (post) =>
            (post.branch_id ?? null) === (where.branch_id ?? null) &&
            post.status === where.status,
        );
        return Promise.resolve([rows, rows.length]);
      }),
      createQueryBuilder: jest.fn(() => totalsQb),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn() } as any,
    );
    jest
      .spyOn(service as any, 'resolveScopedBranchId')
      .mockResolvedValue(BRANCH);

    const res: any = await service.findAllPosts(
      1,
      10,
      { status: Post_status.SENT },
      MANAGER,
    );

    expect(res.data.data.map((post: Row) => post.id)).toEqual(['702']);
  });

  it('⭐ scanAssignOrder — kuryer skani bilan yaratilgan SENT pochta filialsiz', async () => {
    const { service, postRepo } = baseService();
    jest.spyOn(service as any, 'findOrderByQrToken').mockResolvedValue({
      id: '101',
      branch_id: BRANCH,
      status: Order_status.RECEIVED,
      courier_id: null,
      post_id: null,
      total_price: 100_000,
      region_id: '6',
    });
    jest.spyOn(service as any, 'findCourierAssignment').mockResolvedValue({
      branchId: BRANCH,
      branchType: 'REGIONAL',
      branch: null,
    });
    jest
      .spyOn(service as any, 'assertOrdersServedByBranch')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'findBranchCoverageRow').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'releaseOrderFromNewRegionPost')
      .mockResolvedValue(undefined);

    await service.scanAssignOrder(
      { id: '44', roles: ['courier'] },
      {
        qr_token: 'ORDER-QR',
      },
    );

    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '44',
        status: Post_status.SENT,
      }),
    );
    expect(postRepo.create.mock.calls[0][0]).not.toHaveProperty('branch_id');
  });

  it('sendPost (HQ hudud pochtasi) — SENT pochta filialsiz qoladi, kuryer filiali so`ralmaydi', async () => {
    const newPost: Row = {
      id: '400',
      status: Post_status.NEW,
      courier_id: '0',
      branch_id: null,
      region_id: '6',
    };
    const { service, postRepo, branchSend } = baseService({
      postFindOne: jest.fn(() => Promise.resolve({ ...newPost })),
    });
    jest
      .spyOn(service as any, 'findCourierById')
      .mockResolvedValue({ id: '44' });
    const order = { id: '101', post_id: '400', total_price: 100_000 };
    jest.spyOn(service as any, 'findOrders').mockResolvedValue([order]);
    jest.spyOn(service as any, 'findOrderById').mockResolvedValue(order);

    await service.sendPost(
      '400',
      { courierId: '44', orderIds: ['101'] },
      { id: '1', roles: ['admin'] },
    );

    expect(findByUserCalls(branchSend)).toHaveLength(0);
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '400',
        status: Post_status.SENT,
        courier_id: '44',
        branch_id: null,
      }),
    );
  });

  it('⭐ receivePostWithScanner — qabul qilingan kuryer pochtasi kuryer filialiga', async () => {
    const { service, postRepo, branchSend } = baseService({
      postFindOne: jest.fn(() => Promise.resolve(sentCourierPost())),
    });
    jest
      .spyOn(service as any, 'findOrders')
      .mockResolvedValue([{ id: '101', status: Order_status.ON_THE_ROAD }]);

    await service.receivePostWithScanner(
      { id: '44', roles: ['courier'] },
      'POST-450',
    );

    expect(findByUserCalls(branchSend)[0][1]).toEqual(
      expect.objectContaining({ user_id: '44' }),
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '450',
        status: Post_status.RECEIVED,
        branch_id: BRANCH,
      }),
    );
  });

  it('receiveOrderWithScannerCourier — oxirgi buyurtmada RECEIVED + kuryer filiali; yo`lda qolsa yozilmaydi', async () => {
    const remaining: Row[] = [];
    const { service, postRepo, branchSend } = baseService({
      postFindOne: jest.fn(() => Promise.resolve(sentCourierPost())),
    });
    jest
      .spyOn(service as any, 'findOrderById')
      .mockResolvedValue({ id: '101', post_id: '450' });
    jest
      .spyOn(service as any, 'findOrders')
      .mockImplementation(() => Promise.resolve(remaining));

    remaining.push({ id: '102', status: Order_status.ON_THE_ROAD });
    await service.receiveOrderWithScannerCourier(
      { id: '44', roles: ['courier'] },
      '101',
    );
    expect(postRepo.save).not.toHaveBeenCalled();
    expect(findByUserCalls(branchSend)).toHaveLength(0);

    remaining.length = 0;
    await service.receiveOrderWithScannerCourier(
      { id: '44', roles: ['courier'] },
      '101',
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '450',
        status: Post_status.RECEIVED,
        branch_id: BRANCH,
      }),
    );
  });

  function receivePostService(stillOnTheRoad: Row[]) {
    const order: Row = {
      id: '101',
      post_id: '450',
      status: Order_status.ON_THE_ROAD,
      branch_id: BRANCH,
      total_price: 100_000,
    };
    const env = baseService({
      postFindOne: jest.fn(() => Promise.resolve(sentCourierPost())),
    });
    jest
      .spyOn(env.service as any, 'findOrders')
      .mockImplementation(((query: Row) =>
        Promise.resolve(
          query.status === Order_status.ON_THE_ROAD ? stillOnTheRoad : [order],
        )) as never);
    jest
      .spyOn(env.service as any, 'resolveScopedBranchId')
      .mockResolvedValue(BRANCH);
    jest.spyOn(env.service as any, 'findOrderById').mockResolvedValue(order);
    return env;
  }

  it('⭐ receivePost (kuryer, to`liq) — RECEIVED + kuryer filiali; buyurtma filiali avvalgidek', async () => {
    const { service, postRepo } = receivePostService([]);

    await service.receivePost({ id: '44', roles: ['courier'] }, '450', {
      order_ids: ['101'],
    });

    expect((service as any).updateOrder).toHaveBeenCalledWith(
      '101',
      expect.objectContaining({
        status: Order_status.WAITING,
        branch_id: BRANCH,
      }),
      expect.anything(),
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '450',
        status: Post_status.RECEIVED,
        branch_id: BRANCH,
      }),
    );
  });

  it('receivePost — yo`lda buyurtma qolsa SENT, branch_id yozilmaydi', async () => {
    const { service, postRepo, branchSend } = receivePostService([
      { id: '101', status: Order_status.ON_THE_ROAD },
    ]);

    await service.receivePost({ id: '44', roles: ['courier'] }, '450', {
      order_ids: ['101'],
    });

    expect(findByUserCalls(branchSend)).toHaveLength(0);
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '450',
        status: Post_status.SENT,
        branch_id: null,
      }),
    );
  });

  it('releaseReturnSourcePosts — oxirgi yo`ldagi chiqqan kuryer pochtasi RECEIVED + kuryer filiali', async () => {
    const { service, postRepo } = baseService({
      postFindOne: jest.fn(() => Promise.resolve(sentCourierPost())),
    });
    jest.spyOn(service as any, 'findOrders').mockResolvedValue([]);

    await (service as any).releaseReturnSourcePosts(
      new Map([['450', { count: 1, total: 100_000 }]]),
    );

    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '450',
        status: Post_status.RECEIVED,
        branch_id: BRANCH,
      }),
    );
  });

  it('branch_id bor, kuryersiz pochta yoki filial aniqlanmasa — o`zgarmaydi, qabul to`xtamaydi', async () => {
    const run = async (post: Row, branchSend?: jest.Mock) => {
      const env = baseService({
        postFindOne: jest.fn(() => Promise.resolve(post)),
        branchSend,
      });
      jest
        .spyOn(env.service as any, 'findOrders')
        .mockResolvedValue([{ id: '101', status: Order_status.ON_THE_ROAD }]);
      await env.service.receivePostWithScanner(
        { id: '44', roles: ['courier'] },
        'POST-450',
      );
      return env;
    };

    const withBranch = await run(sentCourierPost({ branch_id: OTHER_BRANCH }));
    expect(findByUserCalls(withBranch.branchSend)).toHaveLength(0);
    expect(withBranch.postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: OTHER_BRANCH }),
    );

    const transfer = await run(sentCourierPost({ courier_id: '0' }));
    expect(findByUserCalls(transfer.branchSend)).toHaveLength(0);

    const down = await run(
      sentCourierPost(),
      jest.fn(() => throwError(() => new Error('branch down'))),
    );
    expect(down.postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Post_status.RECEIVED,
        branch_id: null,
      }),
    );
  });
});

describe('receiveOrdersIntoPosts — HQ → filial dispatch kuryer pochtasiga tushmaydi', () => {
  function dispatchService(posts: Row[]) {
    const matches = (post: Row, where: Row) =>
      Object.entries(where).every(([key, value]) =>
        value !== null && typeof value === 'object'
          ? post[key] === null || post[key] === undefined // IsNull()
          : String(post[key] as string | number) === String(value),
      );
    const postRepo = {
      findOne: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(posts.find((post) => matches(post, where)) ?? null),
      ),
      create: jest.fn((payload: Row) => ({ ...payload })),
      save: jest.fn((entity: Row) =>
        Promise.resolve({ ...entity, id: entity.id ?? 'p-new' }),
      ),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { service, postRepo };
  }

  it('⭐ filial kuryerining faol SENT pochtasi (branch_id, region bir xil) tanlanmaydi — yangi o`tkazma pochtasi', async () => {
    const courierPost: Row = {
      id: '700',
      status: Post_status.SENT,
      courier_id: '44',
      branch_id: BRANCH,
      region_id: '6',
      order_quantity: 3,
      post_total_price: 300_000,
    };
    const { service, postRepo } = dispatchService([courierPost]);

    const res: any = await service.receiveOrdersIntoPosts([
      {
        order_id: '101',
        assigned_region: '6',
        total_price: 100_000,
        assigned_branch: BRANCH,
        assigned_post_status: Post_status.SENT,
      },
    ]);

    expect(postRepo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: Post_status.SENT,
        branch_id: BRANCH,
        courier_id: '0',
      }),
    });
    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '0',
        branch_id: BRANCH,
        status: Post_status.SENT,
      }),
    );
    expect(res.data).toEqual([{ order_id: '101', post_id: 'p-new' }]);
    expect(courierPost.order_quantity).toBe(3);
  });

  it('mavjud kuryersiz o`tkazma pochtasi qayta ishlatiladi; NEW maqsadga courier_id filtri qo`shilmaydi', async () => {
    const transferPost: Row = {
      id: '710',
      status: Post_status.SENT,
      courier_id: '0',
      branch_id: BRANCH,
      region_id: '6',
      order_quantity: 1,
      post_total_price: 50_000,
    };
    const { service, postRepo } = dispatchService([transferPost]);

    const res: any = await service.receiveOrdersIntoPosts([
      {
        order_id: '101',
        assigned_region: '6',
        total_price: 100_000,
        assigned_branch: BRANCH,
        assigned_post_status: Post_status.SENT,
      },
      { order_id: '102', assigned_region: '6', total_price: 10_000 },
    ]);

    expect(res.data).toEqual(
      expect.arrayContaining([{ order_id: '101', post_id: '710' }]),
    );
    const newLookup = postRepo.findOne.mock.calls
      .map(([query]) => query.where)
      .find((where: Row) => where.status === Post_status.NEW);
    expect(newLookup).not.toHaveProperty('courier_id');
  });
});

describe('receiveCanceledPost — qabul qilingan bekor pochta hisoblagichlari saqlanadi', () => {
  it('⭐ guruhdagi har pochtada AYNAN qabul qilinganlari soni/summasi qoladi', async () => {
    const post55: Row = {
      id: '55',
      courier_id: '44',
      branch_id: BRANCH,
      region_id: '6',
      status: Post_status.CANCELED,
      order_quantity: 1,
      post_total_price: 100_000,
    };
    const post56: Row = {
      id: '56',
      courier_id: '44',
      branch_id: BRANCH,
      region_id: '6',
      status: Post_status.CANCELED,
      order_quantity: 2,
      post_total_price: 500_000,
    };
    const saved: Row[] = [];
    const postRepo = {
      findOne: jest.fn(() => Promise.resolve(post55)),
      save: jest.fn((row: Row) => {
        saved.push({ ...row });
        return Promise.resolve(row);
      }),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({ ok: true })) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest
      .spyOn(service as any, 'resolveScopedBranchId')
      .mockResolvedValue(BRANCH);
    jest.spyOn(service as any, 'findHqBranchId').mockResolvedValue(HQ);
    jest.spyOn(service as any, 'findCanceledPostGroup').mockResolvedValue({
      posts: [post55, post56],
      orders: [
        { id: '101', canceled_post_id: '55', total_price: 100_000 },
        { id: '102', canceled_post_id: '56', total_price: 200_000 },
        { id: '103', canceled_post_id: '56', total_price: 300_000 },
      ],
    });
    jest
      .spyOn(service as any, 'findBranchAssignmentByUserId')
      .mockResolvedValue({ branch_id: BRANCH, role: 'COURIER' });
    jest.spyOn(service as any, 'updateOrder').mockResolvedValue(undefined);
    const requeue = jest
      .spyOn(service as any, 'requeueUnreceivedCanceledOrders')
      .mockResolvedValue(['66']);

    const res: any = await service.receiveCanceledPost(MANAGER, '55', {
      order_ids: ['101', '102'],
    });

    expect(res.data.remaining_order_ids).toEqual(['103']);
    expect(requeue).toHaveBeenCalled();
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '55',
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 1,
          post_total_price: 100_000,
        }),
        expect.objectContaining({
          id: '56',
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 1,
          post_total_price: 200_000,
        }),
      ]),
    );
  });
});
