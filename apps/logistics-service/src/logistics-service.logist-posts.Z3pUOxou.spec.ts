import { RpcException } from '@nestjs/microservices';
import { In, Not } from 'typeorm';
import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * Z3pUOxou — logist: pochtalarni ko'rish (GET /post, /post/:id,
 * /post/orders/:id) — faqat o'ziga biriktirilgan viloyatlar
 * (regions.logist_id = me), faqat o'qish, pulsiz (ega LG-S1/LG-S3).
 *
 * Avval logist filialga biriktirilmagani uchun 403 olardi (va gateway
 * @Roles'da yo'q edi). Endi: o'z viloyati — 200, boshqasi — 403/400,
 * biriktirilmagan — bo'sh; `post_total_price`/`amount_total`/
 * `homeOrdersTotalPrice` qaytmaydi; GET hech narsa yozmaydi.
 */
const LOGIST = { id: '42', roles: ['logist'] };
const REGIONS = [
  { id: '5', name: 'Samarqand', logist_id: '42' },
  { id: '9', name: 'Buxoro', logist_id: '42' },
  { id: '7', name: 'Xorazm', logist_id: '43' },
];

const postRow = (overrides: Record<string, unknown> = {}) => ({
  id: '11',
  region_id: '5',
  branch_id: '3',
  courier_id: '26',
  status: Post_status.SENT,
  order_quantity: 2,
  post_total_price: 250000,
  qr_code_token: 'POST-abc',
  createdAt: new Date('2026-10-25T05:00:00Z'),
  region: { id: '5', name: 'Samarqand' },
  ...overrides,
});

function setup(opts: { regions?: typeof REGIONS; post?: unknown } = {}) {
  const regions = opts.regions ?? REGIONS;
  const regionRepo = {
    find: jest.fn(({ where }: { where?: { logist_id?: string } }) =>
      Promise.resolve(
        regions.filter((region) => region.logist_id === where?.logist_id),
      ),
    ),
  };
  const totalsQb = {
    setFindOptions: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getRawOne: jest
      .fn()
      .mockResolvedValue({ orders_total: '2', amount_total: '250000' }),
  };
  const postRepo = {
    findAndCount: jest.fn(() => Promise.resolve([[postRow()], 1])),
    findOne: jest.fn(() =>
      Promise.resolve(opts.post === undefined ? postRow() : opts.post),
    ),
    find: jest.fn(() => Promise.resolve([])),
    save: jest.fn((post: unknown) => Promise.resolve(post)),
    createQueryBuilder: jest.fn(() => totalsQb),
  };
  const branchClient = { send: jest.fn(() => of({ data: null })) };
  const identityClient = {
    send: jest.fn(() =>
      of({ data: [{ id: '26', name: 'Kuryer', phone_number: '+99890' }] }),
    ),
  };
  const searchClient = { send: jest.fn(() => of({})) };
  const service = new LogisticsServiceService(
    postRepo as any,
    regionRepo as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any, // order
    branchClient as any,
    identityClient as any,
    searchClient as any,
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  const findOrders = jest
    .spyOn(service as any, 'findOrders')
    .mockResolvedValue([
      {
        id: '100',
        region_id: '5',
        status: Order_status.ON_THE_ROAD,
        where_deliver: 'address',
        total_price: 150000,
        branch_id: '3',
      },
      {
        id: '101',
        region_id: '5',
        status: Order_status.ON_THE_ROAD,
        where_deliver: 'center',
        total_price: 100000,
        branch_id: '3',
      },
    ] as never);
  return { service, postRepo, regionRepo, branchClient, findOrders };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

describe('Z3pUOxou — GET /post (logist)', () => {
  it('faqat o‘z viloyatlari; pul (post_total_price, amount_total) yo‘q; filial ta’miri yozilmaydi', async () => {
    const { service, postRepo, branchClient } = setup();
    const res: any = await service.findAllPosts(1, 10, {}, LOGIST);

    const where = (postRepo.findAndCount.mock.calls[0] as any[])[0].where;
    expect(where.region_id).toEqual(In(['5', '9']));
    expect(where.status).toEqual(Not(Post_status.NEW));
    expect(where).not.toHaveProperty('branch_id');
    expect(res.data.data[0]).toEqual(
      expect.objectContaining({ id: '11', region_id: '5', order_quantity: 2 }),
    );
    expect(res.data.data[0]).not.toHaveProperty('post_total_price');
    expect(res.data.orders_total).toBe(2);
    expect(res.data).not.toHaveProperty('amount_total');
    // Logist filialga biriktirilmaydi — filial so'rovi va yozuv yo'q.
    expect(branchClient.send).not.toHaveBeenCalled();
    expect(postRepo.find).not.toHaveBeenCalled();
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('o‘z viloyati filtri — faqat shu viloyat (doira ustidan yozilmaydi)', async () => {
    const { service, postRepo } = setup();
    await service.findAllPosts(
      1,
      10,
      { region_id: '09', branch_id: '3' },
      LOGIST,
    );
    const where = (postRepo.findAndCount.mock.calls[0] as any[])[0].where;
    expect(where.region_id).toBe('9');
    expect(where.branch_id).toBe('3');
  });

  it('⛔ boshqa logistning viloyati filtri — 400, bazaga so‘rov yo‘q', async () => {
    const { service, postRepo } = setup();
    const err = await rpcError(
      service.findAllPosts(1, 10, { region_id: '7' }, LOGIST),
    );
    expect(err.statusCode).toBe(400);
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
  });

  it('viloyat biriktirilmagan logist — bo‘sh sahifa', async () => {
    const { service, postRepo } = setup({ regions: [] });
    const res: any = await service.findAllPosts(1, 10, {}, LOGIST);
    expect(res.data).toEqual(
      expect.objectContaining({ data: [], total: 0, orders_total: 0 }),
    );
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
  });

  it('boshqa rollar o‘zgarmagan: menejer — filial doirasi (branch.user.find_by_user yoki JWT)', async () => {
    const { service, postRepo } = setup();
    await service.findAllPosts(
      1,
      10,
      {},
      {
        id: '20',
        roles: ['manager'],
        branch_id: '3',
      },
    );
    const where = (postRepo.findAndCount.mock.calls[0] as any[])[0].where;
    expect(where.branch_id).toBe('3');
    expect(where).not.toHaveProperty('region_id');
  });
});

describe('Z3pUOxou — GET /post/:id (logist)', () => {
  it('o‘z viloyati — 200, post_total_price yo‘q, yozuv yo‘q', async () => {
    const { service, postRepo } = setup();
    const res: any = await service.findPostById('11', LOGIST);
    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('11');
    expect(res.data).not.toHaveProperty('post_total_price');
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('⛔ boshqa viloyat yoki viloyatsiz pochta — 403', async () => {
    for (const post of [
      postRow({ region_id: '7' }),
      postRow({ region_id: null }),
    ]) {
      const { service } = setup({ post });
      const err = await rpcError(service.findPostById('11', LOGIST));
      expect(err.statusCode).toBe(403);
    }
  });
});

describe('Z3pUOxou — GET /post/orders/:id (logist)', () => {
  it('o‘z viloyati — 200: buyurtmalar bor, summalar yo‘q, branch_id ko‘chirilmaydi', async () => {
    const { service, postRepo, branchClient } = setup({
      post: postRow({ courier_id: '0', branch_id: '1' }),
    });
    const res: any = await service.getPostOrders('11', LOGIST);
    expect(res.data.allOrdersByPostId.map((o: any) => o.id)).toEqual([
      '100',
      '101',
    ]);
    expect(res.data.homeOrders).toEqual({ homeOrders: 1 });
    expect(res.data.centerOrders).toEqual({ centerOrders: 1 });
    expect(res.data.post).not.toHaveProperty('post_total_price');
    expect(postRepo.save).not.toHaveBeenCalled();
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('⛔ boshqa viloyat — 403, buyurtmalar so‘ralmaydi', async () => {
    const { service, findOrders } = setup({
      post: postRow({ region_id: '7' }),
    });
    const err = await rpcError(service.getPostOrders('11', LOGIST));
    expect(err.statusCode).toBe(403);
    expect(findOrders).not.toHaveBeenCalled();
  });

  it('menejer javobi o‘zgarmagan (summalar qoladi)', async () => {
    const { service } = setup();
    const res: any = await service.getPostOrders('11', {
      id: '20',
      roles: ['manager'],
      branch_id: '3',
    });
    expect(res.data.homeOrders).toEqual({
      homeOrders: 1,
      homeOrdersTotalPrice: 150000,
    });
  });
});

/**
 * 1mOjtOVC — pochta cheki: `GET /post/:id` javobida haydovchi = pochta
 * kuryeri `courier { id, name, phone_number }` (kuryersiz pochta / identity
 * javob bermasa — null, javob yiqilmaydi).
 */
describe('1mOjtOVC — GET /post/:id: courier (pochta cheki haydovchisi)', () => {
  const SA = { id: '1', roles: ['superadmin'] };

  it('⭐ superadmin — courier {id, name, phone_number}, qolgan maydonlar o‘zgarmagan', async () => {
    const { service } = setup();
    const res: any = await service.findPostById('11', SA);
    expect(res.statusCode).toBe(200);
    expect(res.data.courier).toEqual({
      id: '26',
      name: 'Kuryer',
      phone_number: '+99890',
    });
    expect(res.data).toMatchObject({
      id: '11',
      qr_code_token: 'POST-abc',
      order_quantity: 2,
      post_total_price: 250000,
    });
  });

  it('logist — courier bor, post_total_price yo‘q', async () => {
    const { service } = setup();
    const res: any = await service.findPostById('11', LOGIST);
    expect(res.data.courier).toEqual(
      expect.objectContaining({ id: '26', name: 'Kuryer' }),
    );
    expect(res.data).not.toHaveProperty('post_total_price');
  });

  it("kuryersiz (filial) pochta — courier null, identity so'ralmaydi", async () => {
    const { service } = setup({ post: postRow({ courier_id: '0' }) });
    const identity = (service as any).identityClient.send as jest.Mock;
    identity.mockClear();
    const res: any = await service.findPostById('11', SA);
    expect(res.data.courier).toBeNull();
    expect(identity).not.toHaveBeenCalled();
  });
});
