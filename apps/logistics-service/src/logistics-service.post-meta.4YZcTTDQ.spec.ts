/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { of, throwError } from 'rxjs';
import { Order_status, Post_status, Where_deliver } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * 4YZcTTDQ — pochtaning o'z ma'lumoti:
 *   (1) GET /post (logistics.post.find_all) — har qatorda `courier`
 *       ({id, name, phone_number}; courier_id bo'lmasa yoki kuryer
 *       o'chirilgan bo'lsa null). Ilgari faqat `courier_id` bor edi —
 *       /mails/old kartasi va Excel "Kuryer" ustuni doim bo'sh edi.
 *   (2) GET /post/orders/:id — `data.post.status` (+ kuryer, QR, sana,
 *       viloyat) — deep-link (/mails/70, state'siz) holatni serverdan oladi.
 */
const COURIERS: Record<string, Record<string, unknown>> = {
  '119': {
    id: '119',
    name: 'Buxaro Courier',
    phone_number: '+998901110119',
    salary: 5_000_000,
    tariff_home: 25000,
    role: 'courier',
  },
};

function makeService(opts: {
  posts?: Array<Record<string, unknown>>;
  identity?: 'ok' | 'down';
}) {
  const identitySend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (opts.identity === 'down') {
      return throwError(() => new Error('identity down'));
    }
    if (pattern.cmd === 'identity.courier.find_by_ids') {
      return of({
        data: (payload.ids as string[])
          .map((id) => COURIERS[id])
          .filter(Boolean),
      });
    }
    return of({ data: null });
  });
  const posts = opts.posts ?? [];
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
    findAndCount: jest.fn(() =>
      Promise.resolve([posts.map((p) => ({ ...p })), posts.length]),
    ),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        posts.find((p) => String(p.id) === String(where.id)) ?? null,
      ),
    ),
    save: jest.fn((p: unknown) => Promise.resolve(p)),
    // (tveJKICY) ro'yxat yig'indilari so'rovi.
    createQueryBuilder: jest.fn(() => totalsQb),
  };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any, // order
    { send: jest.fn(() => of({ data: null })) } as any, // branch
    { send: identitySend } as any,
    { send: jest.fn(() => of({})) } as any, // search
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  jest.spyOn(service as any, 'resolveScopedBranchId').mockResolvedValue(null);
  jest.spyOn(service as any, 'findHqBranchId').mockResolvedValue('1');
  jest.spyOn(service as any, 'findOrders').mockImplementation(((
    query: Record<string, unknown>,
  ) =>
    Promise.resolve(
      query.post_id
        ? [
            {
              id: '700',
              post_id: query.post_id,
              status: Order_status.ON_THE_ROAD,
              where_deliver: Where_deliver.ADDRESS,
              total_price: 65_000,
              branch_id: '1',
            },
          ]
        : [],
    )) as never);
  return { service, identitySend, postRepo };
}

const ADMIN = { id: '1', roles: ['admin'] };
const post = (over: Record<string, unknown>) => ({
  id: '90',
  status: Post_status.SENT,
  courier_id: '119',
  region_id: '6',
  region: { id: '6', name: 'Buxoro' },
  branch_id: '1',
  qr_code_token: 'POST-QR-90',
  order_quantity: 3,
  post_total_price: 65_000_000,
  createdAt: new Date('2026-08-24T12:33:00.000Z'),
  ...over,
});

describe('4YZcTTDQ — GET /post: courier.name', () => {
  it('⭐ courier_id bor qatorda courier {id, name, phone_number} — maosh/tarif YO`Q', async () => {
    const { service } = makeService({ posts: [post({})] });

    const res: any = await service.findAllPosts(1, 10, {}, ADMIN as never);

    const row = res.data.data[0];
    expect(row.courier_id).toBe('119');
    expect(row.courier).toEqual({
      id: '119',
      name: 'Buxaro Courier',
      phone_number: '+998901110119',
    });
    expect(JSON.stringify(row)).not.toContain('salary');
    // Eski maydonlar joyida.
    expect(row).toMatchObject({
      id: '90',
      region: { id: '6', name: 'Buxoro' },
      qr_code_token: 'POST-QR-90',
    });
  });

  it.each([
    ["kuryer o'chirilgan (identity qaytarmaydi)", { courier_id: '555' }],
    ["courier_id '0' (filial o'tkazmasi)", { courier_id: '0' }],
    ["courier_id yo'q", { courier_id: null }],
  ])('%s → courier: null', async (_label, over) => {
    const { service } = makeService({ posts: [post(over)] });
    const res: any = await service.findAllPosts(1, 10, {}, ADMIN as never);
    expect(res.data.data[0]).toHaveProperty('courier', null);
  });

  it('sahifa uchun BITTA identity so`rovi (takroriy kuryerlar bitta)', async () => {
    const { service, identitySend } = makeService({
      posts: [
        post({ id: '90' }),
        post({ id: '91' }),
        post({ id: '92', courier_id: '555' }),
      ],
    });

    await service.findAllPosts(1, 10, {}, ADMIN as never);

    const calls = identitySend.mock.calls.filter(
      ([pattern]: any[]) => pattern.cmd === 'identity.courier.find_by_ids',
    );
    expect(calls).toHaveLength(1);
    expect([...calls[0][1].ids].sort()).toEqual(['119', '555']);
  });

  it('identity javob bermasa — ro`yxat yiqilmaydi, courier null', async () => {
    const { service } = makeService({
      posts: [post({})],
      identity: 'down',
    });
    const res: any = await service.findAllPosts(1, 10, {}, ADMIN as never);
    expect(res.statusCode).toBe(200);
    expect(res.data.data[0].courier).toBeNull();
  });
});

describe('4YZcTTDQ — GET /post/orders/:id: data.post', () => {
  it('⭐ data.post.status va pochta meta`si (kuryer, QR, viloyat, sana)', async () => {
    const { service } = makeService({ posts: [post({})] });

    const res: any = await service.getPostOrders('90', ADMIN as never);

    expect(res.data.post).toEqual({
      id: '90',
      status: Post_status.SENT,
      courier_id: '119',
      courier: {
        id: '119',
        name: 'Buxaro Courier',
        phone_number: '+998901110119',
      },
      qr_code_token: 'POST-QR-90',
      order_quantity: 3,
      branch_id: '1',
      region_id: '6',
      region: { id: '6', name: 'Buxoro' },
      createdAt: new Date('2026-08-24T12:33:00.000Z'),
    });
    // Eski kalitlar o'zgarmagan.
    expect(Object.keys(res.data).sort()).toEqual(
      ['allOrdersByPostId', 'centerOrders', 'homeOrders', 'post'].sort(),
    );
  });

  it.each([
    Post_status.NEW,
    Post_status.RECEIVED,
    Post_status.CANCELED_RECEIVED,
  ])(
    'holat %s — data.post.status aynan pochtaniki (buyurtmalardan taxmin emas)',
    async (status) => {
      const { service } = makeService({ posts: [post({ status })] });
      const res: any = await service.getPostOrders('90', ADMIN as never);
      expect(res.data.post.status).toBe(status);
    },
  );

  it('kuryersiz (filial o`tkazmasi) pochta — courier null', async () => {
    const { service, identitySend } = makeService({
      posts: [post({ courier_id: '0' })],
    });
    const res: any = await service.getPostOrders('90', ADMIN as never);
    expect(res.data.post.courier).toBeNull();
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('postRepo.findOne viloyat relation`i bilan chaqiriladi', async () => {
    const { service, postRepo } = makeService({ posts: [post({})] });
    await service.getPostOrders('90', ADMIN as never);
    expect(postRepo.findOne).toHaveBeenCalledWith({
      where: { id: '90' },
      relations: ['region'],
    });
  });
});
