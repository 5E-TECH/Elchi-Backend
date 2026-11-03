import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * Kuryer «Bu buyurtma kelmagan — qaytarish so'rovi» (egasi qarori 2026-11-03,
 * BeePost kabi): yangi (SENT) pochtadagi hali qabul qilinmagan buyurtma yo'lda
 * qoladi, `return_requested` qo'yiladi va «Qaytarish» ro'yxatiga tushadi.
 * Pochta shu yerda yopilmaydi.
 */
describe('requestCourierOrderReturn — «Bu buyurtma kelmagan»', () => {
  type Row = Record<string, unknown>;

  const courier = { id: 'c1', roles: ['courier'] };
  const onTheRoad = (id: string, extra: Row = {}): Row => ({
    id,
    status: Order_status.ON_THE_ROAD,
    post_id: '98',
    courier_id: 'c1',
    holder_type: 'COURIER',
    holder_courier_id: 'c1',
    last_handover_by: 'manager-7',
    return_requested: false,
    total_price: 100_000,
    ...extra,
  });

  function setup(options: { post?: Row | null; orders: Row[] }) {
    const orders = new Map(options.orders.map((o) => [String(o.id), { ...o }]));
    const orderClient = {
      send: jest.fn(
        (
          pattern: { cmd: string },
          payload: { id?: string; dto?: Row; query?: Row },
        ) => {
          if (pattern.cmd === 'order.find_by_id') {
            return of(orders.get(String(payload.id)) ?? null);
          }
          if (pattern.cmd === 'order.find_all') {
            const query = payload.query ?? {};
            const rows = [...orders.values()].filter(
              (row) =>
                String(row.post_id) === String(query.post_id) &&
                row.status === query.status,
            );
            return of({ data: { data: rows } });
          }
          if (pattern.cmd === 'order.update') {
            Object.assign(orders.get(String(payload.id)) ?? {}, payload.dto);
            return of({ statusCode: 200 });
          }
          return of({});
        },
      ),
    };
    const postRepo = {
      findOne: jest.fn(() =>
        Promise.resolve(
          options.post === undefined
            ? { id: '98', courier_id: 'c1', status: Post_status.SENT }
            : options.post,
        ),
      ),
      save: jest.fn((post: Row) => Promise.resolve(post)),
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
      { send: jest.fn(() => of({ data: null })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    const updates = () =>
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(
          ([, payload]) => payload as { id: string; dto: Row; requester: Row },
        );
    return { service, postRepo, activityLog, orders, updates };
  }

  async function expectStatus(promise: Promise<unknown>, status: number) {
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

  it('belgi qo‘yiladi, buyurtma yo‘lda qoladi, pochta yopilmaydi', async () => {
    const ctx = setup({ orders: [onTheRoad('101'), onTheRoad('102')] });

    const response: any = await ctx.service.requestCourierOrderReturn(
      courier,
      '98',
      '101',
    );

    expect(response.data).toEqual({
      order_id: '101',
      post_id: '98',
      return_requested: true,
      already_requested: false,
      remaining_receivable: 1,
    });
    const [update] = ctx.updates();
    expect(update.dto).toEqual({ return_requested: true });
    expect(update.requester).toEqual(
      expect.objectContaining({
        id: 'c1',
        courier_return_request: { post_id: '98' },
      }),
    );
    expect(ctx.orders.get('101')?.status).toBe(Order_status.ON_THE_ROAD);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '101',
        action: 'logistics.return_request',
        user_id: 'c1',
      }),
    );
  });

  it('oxirgi qabul qilinadigan buyurtma bo‘lsa — qabul qilinadigan qolmaydi (0)', async () => {
    const ctx = setup({
      orders: [onTheRoad('101'), onTheRoad('102', { return_requested: true })],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      courier,
      '98',
      '101',
    );
    expect(response.data.remaining_receivable).toBe(0);
  });

  it('qayta bosish — idempotent, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [onTheRoad('101', { return_requested: true })],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      courier,
      '98',
      '101',
    );
    expect(response.data.already_requested).toBe(true);
    expect(ctx.updates()).toHaveLength(0);
  });

  it('boshqa kuryerning pochtasi — 404', async () => {
    const ctx = setup({ post: null, orders: [onTheRoad('101')] });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      404,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('qabul qilingan pochta — 400', async () => {
    const ctx = setup({
      post: { id: '98', courier_id: 'c1', status: Post_status.RECEIVED },
      orders: [onTheRoad('101')],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      400,
    );
  });

  it('buyurtma boshqa pochtada — 409', async () => {
    const ctx = setup({ orders: [onTheRoad('101', { post_id: '99' })] });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      409,
    );
  });

  it('allaqachon qabul qilingan (WAITING) — 400', async () => {
    const ctx = setup({
      orders: [onTheRoad('101', { status: Order_status.WAITING })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      400,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('kuryer hisobida emas — 409', async () => {
    const ctx = setup({
      orders: [onTheRoad('101', { holder_type: 'BRANCH' })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      409,
    );
  });

  it('o‘zi skanerlab olgan posilka — 400 (u kuryer qo‘lida)', async () => {
    const ctx = setup({
      orders: [onTheRoad('101', { last_handover_by: 'c1' })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(courier, '98', '101'),
      400,
    );
    expect(ctx.updates()).toHaveLength(0);
  });
});
