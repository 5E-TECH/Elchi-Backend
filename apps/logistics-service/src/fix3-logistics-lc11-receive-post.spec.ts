import { RpcException } from '@nestjs/microservices';
import { TimeoutError, of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 LC-11 — filial pochtani qabul qilganda pochta holati so'rov boshidagi
 * suratdan emas, yozuvlardan KEYINGI haqiqiy holatdan tanlanadi.
 *
 * Ilgari: bitta order.update yiqilsa (yoki shu orada HQ dispatch yangi
 * buyurtma qo'shsa) pochta baribir RECEIVED bo'lardi; FE esa RECEIVED pochtani
 * faqat ko'rish rejimida ochadi — yo'lda qolgan posilkani qabul qilib
 * bo'lmasdi. Javob 200 'Post received successfully' edi, xato faqat logda.
 */
describe('FIX3 LC-11 — receivePost yo‘lda qolgan buyurtma bo‘lsa pochtani SENT qoldiradi', () => {
  type Row = Record<string, unknown>;

  const onTheRoad = (id: string): Row => ({
    id,
    status: Order_status.ON_THE_ROAD,
    branch_id: '10',
    post_id: '40',
    total_price: 100_000,
  });

  function setup(options: {
    snapshot: Row[];
    updateErrors?: Record<string, unknown>;
    // yozuvlardan keyin pochtada ON_THE_ROAD turganlar; 'error' — so'rov yiqiladi
    onTheRoadAfter: Row[] | 'error';
  }) {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { id?: string; query?: Row }) => {
          if (pattern.cmd === 'order.find_all') {
            if (payload.query?.status === Order_status.ON_THE_ROAD) {
              return options.onTheRoadAfter === 'error'
                ? throwError(() => new TimeoutError())
                : of({ data: { data: options.onTheRoadAfter } });
            }
            return of({ data: { data: options.snapshot } });
          }
          if (pattern.cmd === 'order.update') {
            const error = options.updateErrors?.[String(payload.id)];
            return error ? throwError(() => error) : of({ statusCode: 200 });
          }
          if (pattern.cmd === 'order.find_by_id') {
            return of({ id: payload.id, status: Order_status.WAITING });
          }
          return of({});
        },
      ),
    };
    const post: Row = {
      id: '40',
      courier_id: '0',
      branch_id: '10',
      region_id: '14',
      status: Post_status.SENT,
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(post),
      save: jest.fn((entity: Row) => Promise.resolve({ ...entity })),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      { send: jest.fn(() => of({ data: null })) } as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    return { service, orderClient, postRepo, activityLog };
  }

  const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };
  const savedStatus = (postRepo: { save: jest.Mock }) =>
    (postRepo.save.mock.calls.at(-1)?.[0] as Row | undefined)?.status;

  it('tanlangan buyurtma yangilanmasa: pochta SENT, javobda not_received_order_ids va failures', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101'), onTheRoad('102')],
      updateErrors: {
        '102': new RpcException({
          statusCode: 502,
          message: 'Order #102 update failed',
        }),
      },
      onTheRoadAfter: [onTheRoad('102')],
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.SENT);
    expect(response.statusCode).toBe(200);
    expect(response.not_received_order_ids).toEqual(['102']);
    expect(response.failures).toEqual([
      expect.objectContaining({ order_id: '102' }),
    ]);
    expect(response.message).toBe(
      "Pochta qisman qabul qilindi: 1 ta buyurtmani qabul qilib bo'lmadi — qayta urinib ko'ring",
    );
    // `data` shakli o'zgarmagan: tanlangan buyurtmalar ro'yxati.
    expect(response.data.map((row: Row) => row.id)).toEqual(['101', '102']);
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        new_value: { status: Post_status.SENT },
        metadata: expect.objectContaining({
          failed_order_count: 1,
          not_received_order_ids: ['102'],
        }),
      }),
    );
  });

  it('shu orada HQ dispatch qo‘shgan buyurtma (suratda yo‘q) — pochta SENT qoladi', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101')],
      onTheRoadAfter: [onTheRoad('150')],
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.SENT);
    expect(response.not_received_order_ids).toEqual([]);
    expect(response.message).toBe('Post received successfully');
  });

  it('hammasi qabul qilindi — pochta RECEIVED, javob avvalgidek', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101'), onTheRoad('102')],
      onTheRoadAfter: [],
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.RECEIVED);
    expect(response.message).toBe('Post received successfully');
    expect(response.failures).toEqual([]);
    expect(response.not_received_order_ids).toEqual([]);
  });

  it('timeout, lekin buyurtma aslida o‘tgan (endi ON_THE_ROAD emas) — qabul qilingan deb hisoblanadi', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101'), onTheRoad('102')],
      updateErrors: { '102': new TimeoutError() },
      onTheRoadAfter: [],
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.RECEIVED);
    expect(response.not_received_order_ids).toEqual([]);
    // Xato baribir ko'rinadi (diagnostika uchun).
    expect(response.failures).toEqual([
      expect.objectContaining({ order_id: '102' }),
    ]);
  });

  it('qayta tekshiruv yiqilsa — yiqilgan tanlov bo‘yicha xavfsiz tomonga (SENT)', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101'), onTheRoad('102')],
      updateErrors: {
        '102': new RpcException({ statusCode: 409, message: 'conflict' }),
      },
      onTheRoadAfter: 'error',
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101', '102'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.SENT);
    expect(response.not_received_order_ids).toEqual(['102']);
  });

  it('qayta tekshiruv yiqilsa va hech narsa yiqilmagan bo‘lsa — avvalgi qoida (RECEIVED)', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101')],
      onTheRoadAfter: 'error',
    });

    await ctx.service.receivePost(manager10, '40', { order_ids: ['101'] });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.RECEIVED);
  });

  it('tanlanmagan ON_THE_ROAD qoldiq (qaytarish so‘rovi) — avvalgidek SENT', async () => {
    const ctx = setup({
      snapshot: [onTheRoad('101'), onTheRoad('102')],
      onTheRoadAfter: [onTheRoad('102')],
    });

    const response: any = await ctx.service.receivePost(manager10, '40', {
      order_ids: ['101'],
    });

    expect(savedStatus(ctx.postRepo)).toBe(Post_status.SENT);
    expect(response.not_received_order_ids).toEqual([]);
    expect(ctx.orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '102',
        dto: expect.objectContaining({
          status: Order_status.ON_THE_ROAD,
          return_requested: true,
        }),
      }),
    );
  });
});
