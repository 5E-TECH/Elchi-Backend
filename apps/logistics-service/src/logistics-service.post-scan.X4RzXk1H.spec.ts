/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { Order_status, Post_status, Where_deliver } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * X4RzXk1H — `logistics.post.find_by_scan` (`GET /scan/:token` `POST-…`,
 * `GET /post/scan/:id`): ilgari requester'siz, rol/doira tekshiruvisiz edi —
 * market ham pochta qatorini to'liq olardi. Endi: rol (POST_SCAN_ROLES) +
 * `GET /post/orders/:id` doirasi; skan pochtani o'zgartirmaydi.
 *
 * dwJX3NjT (S2) — javobga buyurtmalar ro'yxati, viloyat va kuryer.
 */
const TOKEN = 'POST-mh3k2x9a-4f7q1z8c'; // logistics generateToken() shakli

const COURIERS: Record<string, Record<string, unknown>> = {
  '26': {
    id: '26',
    name: 'TEST Claude Kuryer',
    phone_number: '+998900000026',
    salary: 5_000_000,
    tariff_home: 25000,
  },
};

const SUMMARIES: Record<string, Record<string, unknown>> = {
  '700': {
    id: '700',
    order_number: 'EL-100700',
    status: 'on the road',
    total_price: 65000,
    customer_name: 'Ali Valiyev',
    customer_phone: '+998901234567',
    region_name: 'Buxoro viloyati',
    district_name: 'Buxoro tumani',
  },
  '701': {
    id: '701',
    order_number: 'EL-100701',
    status: 'sold',
    total_price: 30000,
    customer_name: 'Vali Aliyev',
    customer_phone: '+998907654321',
    region_name: 'Buxoro viloyati',
    district_name: 'Kogon tumani',
  },
};

type OrderRowLike = Record<string, unknown>;

const ORDERS: OrderRowLike[] = [
  {
    id: '700',
    status: Order_status.ON_THE_ROAD,
    where_deliver: Where_deliver.ADDRESS,
    total_price: 65000,
    branch_id: '1',
    market_tariff: 20000,
  },
  {
    id: '701',
    status: Order_status.SOLD,
    where_deliver: Where_deliver.CENTER,
    total_price: 30000,
    branch_id: '1',
    market_tariff: 15000,
  },
];

const post = (over: Record<string, unknown> = {}) => ({
  id: '90',
  status: Post_status.SENT,
  courier_id: '26',
  region_id: '6',
  branch_id: '1',
  qr_code_token: TOKEN,
  order_quantity: 2,
  post_total_price: 95000,
  createdAt: new Date('2026-10-25T09:00:00.000Z'),
  ...over,
});

function makeService(opts?: {
  post?: Record<string, unknown> | null;
  orders?: OrderRowLike[];
  summaries?: 'ok' | 'down';
  /** requester.id → filial doirasi (null — SA/admin). */
  scope?: Record<string, string | null>;
}) {
  const row = opts?.post === undefined ? post() : opts.post;
  const postRepo = {
    findOne: jest.fn(
      ({ where }: { where: { id?: string; qr_code_token?: string } }) => {
        if (!row) return Promise.resolve(null);
        if (where.qr_code_token !== undefined) {
          return Promise.resolve(
            where.qr_code_token === row.qr_code_token ? { ...row } : null,
          );
        }
        return Promise.resolve(
          String(where.id) === String(row.id)
            ? { ...row, region: { id: '6', name: 'Buxoro viloyati' } }
            : null,
        );
      },
    ),
    save: jest.fn((p: unknown) => Promise.resolve(p)),
  };
  const orderSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd === 'order.summary_by_ids') {
      if (opts?.summaries === 'down') {
        return throwError(() => new Error('order-service down'));
      }
      return of({
        data: (payload.ids as string[]).map((id) => SUMMARIES[id]),
      });
    }
    return of({});
  });
  const identitySend = jest.fn((pattern: { cmd: string }, payload: any) =>
    pattern.cmd === 'identity.courier.find_by_ids'
      ? of({
          data: (payload.ids as string[])
            .map((id) => COURIERS[id])
            .filter(Boolean),
        })
      : of({ data: null }),
  );
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    { send: orderSend } as any, // order
    { send: jest.fn(() => of({ data: null })) } as any, // branch
    { send: identitySend } as any,
    { send: jest.fn(() => of({})) } as any, // search
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  const scope = opts?.scope ?? {};
  jest
    .spyOn(service as any, 'resolveScopedBranchId')
    .mockImplementation(((requester: { id: string }) =>
      Promise.resolve(scope[requester.id] ?? null)) as never);
  const orders = opts?.orders ?? ORDERS;
  jest
    .spyOn(service as any, 'findOrders')
    .mockImplementation(((query: Record<string, unknown>) =>
      Promise.resolve(
        query.post_id ? orders.map((order) => ({ ...order })) : [],
      )) as never);
  return { service, postRepo, orderSend };
}

const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof RpcException
      ? (e.getError() as { statusCode?: number }).statusCode
      : undefined;
  }
};

const ADMIN = { id: '1', roles: ['admin'] };

describe('X4RzXk1H — pochta skani: rol tekshiruvi', () => {
  it.each([['market'], ['customer'], ['operator'], ['investor'], ['logist']])(
    '%s — 403, pochta qidirilmaydi (token bor-yo`qligi ham bilinmaydi)',
    async (role) => {
      const { service, postRepo } = makeService();
      expect(
        await statusOf(
          service.findPostWithQr(TOKEN, { id: '37', roles: [role] }),
        ),
      ).toBe(403);
      expect(postRepo.findOne).not.toHaveBeenCalled();
    },
  );

  it('requester`siz chaqiruv — 403 (fail-closed)', async () => {
    const { service, postRepo } = makeService();
    expect(await statusOf(service.findPostWithQr(TOKEN))).toBe(403);
    expect(
      await statusOf(
        service.findPostWithQr(TOKEN, { id: '', roles: ['admin'] }),
      ),
    ).toBe(403);
    expect(postRepo.findOne).not.toHaveBeenCalled();
  });

  it('noma`lum token — 404', async () => {
    const { service } = makeService();
    expect(await statusOf(service.findPostWithQr('POST-yoq-123', ADMIN))).toBe(
      404,
    );
  });
});

describe('X4RzXk1H — pochta skani: filial/kuryer doirasi (GET /post/orders/:id bilan AYNI)', () => {
  it('o`z filiali menejeri — ko`radi', async () => {
    const { service } = makeService({ scope: { '25': '1' } });
    expect(
      await statusOf(
        service.findPostWithQr(TOKEN, { id: '25', roles: ['manager'] }),
      ),
    ).toBe(200);
  });

  it('begona filial menejeri — 403', async () => {
    const { service } = makeService({ scope: { '77': '9' } });
    expect(
      await statusOf(
        service.findPostWithQr(TOKEN, { id: '77', roles: ['manager'] }),
      ),
    ).toBe(403);
  });

  it('kuryer — o`z pochtasi (boshqa filialda bo`lsa ham) ko`radi; SENT da faqat yo`ldagi buyurtmalar', async () => {
    const { service } = makeService({ scope: { '26': '3' } });
    const res: any = await service.findPostWithQr(TOKEN, {
      id: '26',
      roles: ['courier'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.orders.map((order: any) => order.id)).toEqual(['700']);
  });

  it('kuryer — begona filialdagi boshqa kuryer pochtasi 403', async () => {
    const { service } = makeService({ scope: { '27': '3' } });
    expect(
      await statusOf(
        service.findPostWithQr(TOKEN, { id: '27', roles: ['courier'] }),
      ),
    ).toBe(403);
  });

  it('skan — faqat o`qish: filial o`tkazmasi pochtasi branch_id`si YOZILMAYDI (getPostOrders esa avvalgidek yozadi)', async () => {
    const transferPost = post({ courier_id: '0', branch_id: '1' });
    const ordersAtBranch3 = ORDERS.map((order) => ({
      ...order,
      holder_branch_id: '3',
    }));

    const scan = makeService({
      post: transferPost,
      orders: ordersAtBranch3,
      scope: { '25': '3' },
    });
    expect(
      await statusOf(
        scan.service.findPostWithQr(TOKEN, { id: '25', roles: ['manager'] }),
      ),
    ).toBe(200);
    expect(scan.postRepo.save).not.toHaveBeenCalled();

    const page = makeService({
      post: transferPost,
      orders: ordersAtBranch3,
      scope: { '25': '3' },
    });
    await page.service.getPostOrders('90', { id: '25', roles: ['manager'] });
    expect(page.postRepo.save).toHaveBeenCalledTimes(1);
  });
});

describe('dwJX3NjT (S2) — pochta skani mazmuni', () => {
  it('⭐ pochta qatori (o`zgarmagan) + region, courier, orders (mijoz, holat, summa)', async () => {
    const { service, orderSend } = makeService();
    const res: any = await service.findPostWithQr(TOKEN, ADMIN);

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Post found');
    // Avvalgi maydonlar (FE buildScanPostView: order_quantity, post_total_price…).
    expect(res.data).toMatchObject({
      id: '90',
      status: Post_status.SENT,
      courier_id: '26',
      region_id: '6',
      branch_id: '1',
      qr_code_token: TOKEN,
      order_quantity: 2,
      post_total_price: 95000,
    });
    expect(res.data.region).toEqual({ id: '6', name: 'Buxoro viloyati' });
    // Kuryer — faqat {id, name, phone_number} (maosh/tarif yo'q).
    expect(res.data.courier).toEqual({
      id: '26',
      name: 'TEST Claude Kuryer',
      phone_number: '+998900000026',
    });
    expect(res.data.orders).toEqual([
      {
        id: '700',
        order_number: 'EL-100700',
        status: Order_status.ON_THE_ROAD,
        total_price: 65000,
        where_deliver: Where_deliver.ADDRESS,
        customer: { name: 'Ali Valiyev', phone_number: '+998901234567' },
        region: 'Buxoro viloyati',
        district: 'Buxoro tumani',
      },
      {
        id: '701',
        order_number: 'EL-100701',
        status: Order_status.SOLD,
        total_price: 30000,
        where_deliver: Where_deliver.CENTER,
        customer: { name: 'Vali Aliyev', phone_number: '+998907654321' },
        region: 'Buxoro viloyati',
        district: 'Kogon tumani',
      },
    ]);
    // Xom buyurtma qatori (tariflar) javobga chiqmaydi.
    expect(JSON.stringify(res.data.orders)).not.toContain('market_tariff');
    expect(JSON.stringify(res.data)).not.toContain('salary');
    // BITTA xulosa so'rovi.
    const summaryCalls = orderSend.mock.calls.filter(
      ([pattern]: any[]) => pattern.cmd === 'order.summary_by_ids',
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0][1]).toEqual({ ids: ['700', '701'] });
  });

  it('kuryersiz (filial o`tkazmasi) pochta — courier null', async () => {
    const { service } = makeService({ post: post({ courier_id: '0' }) });
    const res: any = await service.findPostWithQr(TOKEN, ADMIN);
    expect(res.data.courier).toBeNull();
  });

  it('xulosa xizmati javob bermasa — ro`yxat qoladi (holat/summa), mijoz null; skan yiqilmaydi', async () => {
    const { service } = makeService({ summaries: 'down' });
    const res: any = await service.findPostWithQr(TOKEN, ADMIN);
    expect(res.statusCode).toBe(200);
    expect(res.data.orders).toEqual([
      expect.objectContaining({
        id: '700',
        status: Order_status.ON_THE_ROAD,
        total_price: 65000,
        customer: null,
        order_number: null,
      }),
      expect.objectContaining({ id: '701', customer: null }),
    ]);
  });

  it('bo`sh pochta — orders [] va xulosa so`ralmaydi', async () => {
    const { service, orderSend } = makeService({ orders: [] });
    const res: any = await service.findPostWithQr(TOKEN, ADMIN);
    expect(res.data.orders).toEqual([]);
    expect(orderSend).not.toHaveBeenCalledWith(
      { cmd: 'order.summary_by_ids' },
      expect.anything(),
    );
  });
});
