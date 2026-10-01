import { of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 LC-06 — HQ bekor pochtani QISMAN qabul qilsa, qabul qilinmagan
 * posilkalar HQ da EMAS, jo'natuvchiga qaytadi.
 *
 * Haqiqiy holat (jo'natilgandan KEYIN): createCanceledPostToHq / HQ kuryeri
 * createCanceledPost buyurtmaga allaqachon branch_id = HQ yozadi, updateFull
 * esa holder'ni HQ qiladi (holder_branch_id null). Eski kod shu HQ doirasini
 * olib, "qaytarilgan" posilkani yana HQ ga yozardi. HQ = '1'.
 */
describe('FIX3 LC-06 — qisman HQ qabulida qolgan bekor posilkalar jo‘natuvchiga qaytadi', () => {
  type Row = Record<string, unknown>;

  // Jo'natilgandan keyingi real holat: HQ ga yozilgan.
  const sentToHq = (id: string, totalPrice: number): Row => ({
    id,
    status: Order_status.CANCELLED_SENT,
    canceled_post_id: '77',
    total_price: totalPrice,
    region_id: '14',
    branch_id: '1',
    holder_type: 'HQ',
    holder_branch_id: null,
    holder_courier_id: null,
  });

  function setup(options: {
    sourcePost: Row;
    orders: Row[];
    sender?: Row | null | 'error';
  }) {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload?: { id?: string }) => {
        if (pattern.cmd === 'order.find_all') {
          return of({ data: { data: options.orders } });
        }
        return of({ statusCode: 200, data: { id: payload?.id } });
      }),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          return of({ data: { id: '1', type: 'HQ' } });
        }
        if (pattern.cmd === 'branch.user.find_by_user') {
          if (options.sender === 'error') {
            return throwError(() => new Error('branch-service down'));
          }
          return of({ data: options.sender ?? null });
        }
        return of({ data: null });
      }),
    };
    const postRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest
        .fn()
        .mockResolvedValueOnce({ ...options.sourcePost })
        .mockResolvedValueOnce(null),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) =>
        Promise.resolve({ ...post, id: post.id ?? '88' }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined), query: jest.fn() } as any,
    );

    const updateOf = (orderId: string) =>
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(
          ([, payload]) =>
            payload as {
              id: string;
              dto: Row;
              requester: { note?: string };
            },
        )
        .filter(({ id }) => String(id) === orderId);

    return { service, orderClient, branchClient, postRepo, updateOf };
  }

  const managerPostToHq: Row = {
    id: '77',
    courier_id: '8',
    branch_id: '1',
    region_id: '14',
    status: Post_status.CANCELED,
    order_quantity: 2,
    post_total_price: 1_500_000,
  };

  it('menejer jo‘natgan pochta: qolgani menejer filiali (10) pochtasiga, kuryersiz qaytadi', async () => {
    const ctx = setup({
      sourcePost: managerPostToHq,
      orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
      sender: { branch_id: '10', role: 'MANAGER' },
    });

    const response: any = await ctx.service.receiveCanceledPost(
      { id: '1', roles: ['admin'] },
      '77',
      { order_ids: ['101'] },
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        order_ids: ['101'],
        remaining_order_ids: ['102'],
        requeued_post_ids: ['88'],
      }),
    );
    expect(ctx.postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '8',
        branch_id: '10',
        region_id: '14',
        status: Post_status.CANCELED,
      }),
    );
    const [update] = ctx.updateOf('102');
    expect(update.dto).toEqual({
      status: Order_status.CANCELLED_SENT,
      branch_id: '10',
      courier_id: null,
      assigned_at: null,
      canceled_post_id: '88',
    });
    expect(update.requester.note).toBe(
      'Canceled order returned to branch after partial HQ receive',
    );
    // Qabul qilingan 101 — HQ da (o'zgarmagan qoida).
    expect(ctx.updateOf('101')[0].dto).toEqual(
      expect.objectContaining({
        status: Order_status.CANCELLED,
        branch_id: '1',
      }),
    );
  });

  it('HQ kuryeri jo‘natgan pochta: qolgani kuryerning o‘ziga qaytadi (custody = kuryer)', async () => {
    const ctx = setup({
      sourcePost: { ...managerPostToHq, courier_id: '31' },
      orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
      sender: { branch_id: '1', role: 'COURIER' },
    });

    await ctx.service.receiveCanceledPost(
      { id: '5', roles: ['registrator'], branch_id: '1' },
      '77',
      { order_ids: ['101'] },
    );

    expect(ctx.postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '31',
        branch_id: '1',
        status: Post_status.CANCELED,
      }),
    );
    const [update] = ctx.updateOf('102');
    expect(update.dto).toEqual({
      status: Order_status.CANCELLED_SENT,
      branch_id: '1',
      courier_id: '31',
      assigned_at: null,
      canceled_post_id: '88',
    });
    expect(update.requester.note).toBe(
      'Canceled order returned to courier after partial HQ receive',
    );
  });

  it('jo‘natuvchini aniqlab bo‘lmasa — avvalgidek HQ da, kuryersiz qoladi', async () => {
    const ctx = setup({
      sourcePost: managerPostToHq,
      orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
      sender: 'error',
    });

    await ctx.service.receiveCanceledPost({ id: '1', roles: ['admin'] }, '77', {
      order_ids: ['101'],
    });

    const [update] = ctx.updateOf('102');
    expect(update.dto).toEqual(
      expect.objectContaining({ branch_id: '1', courier_id: null }),
    );
  });

  it('eski (jo‘natishdan oldingi) holat: buyurtmaning o‘z filial doirasi ustun', async () => {
    const ctx = setup({
      sourcePost: managerPostToHq,
      orders: [
        sentToHq('101', 1_000_000),
        {
          ...sentToHq('102', 500_000),
          branch_id: '12',
          holder_type: 'BRANCH',
          holder_branch_id: '12',
        },
      ],
      sender: { branch_id: '10', role: 'MANAGER' },
    });

    await ctx.service.receiveCanceledPost({ id: '1', roles: ['admin'] }, '77', {
      order_ids: ['101'],
    });

    expect(ctx.updateOf('102')[0].dto).toEqual(
      expect.objectContaining({ branch_id: '12', courier_id: null }),
    );
  });

  describe('filial qabuli (o‘zgarmagan + menejer pochtasi)', () => {
    const branchOrders = (): Row[] => [
      {
        id: '101',
        status: Order_status.CANCELLED_SENT,
        canceled_post_id: '55',
        total_price: 1_000_000,
        region_id: '14',
      },
      {
        id: '102',
        status: Order_status.CANCELLED_SENT,
        canceled_post_id: '55',
        total_price: 500_000,
        region_id: '14',
      },
    ];
    const manager10 = { id: '8', roles: ['manager'], branch_id: '10' };

    it('kuryer pochtasi: qolgani avvalgidek kuryerga qaytadi', async () => {
      const ctx = setup({
        sourcePost: {
          id: '55',
          courier_id: '7',
          branch_id: '10',
          region_id: '14',
          status: Post_status.CANCELED,
        },
        orders: branchOrders(),
        sender: { branch_id: '10', role: 'COURIER' },
      });

      await ctx.service.receiveCanceledPost(manager10, '55', {
        order_ids: ['101'],
      });

      expect(ctx.updateOf('102')[0].dto).toEqual({
        status: Order_status.CANCELLED_SENT,
        branch_id: '10',
        courier_id: '7',
        assigned_at: null,
        canceled_post_id: '88',
      });
    });

    it('HQ dan qaytgan MENEJER pochtasi qisman qabul qilinsa — menejer id si kuryer bo‘lib yozilmaydi', async () => {
      const ctx = setup({
        sourcePost: {
          id: '55',
          courier_id: '8',
          branch_id: '10',
          region_id: '14',
          status: Post_status.CANCELED,
        },
        orders: branchOrders(),
        sender: { branch_id: '10', role: 'MANAGER' },
      });

      await ctx.service.receiveCanceledPost(manager10, '55', {
        order_ids: ['101'],
      });

      expect(ctx.updateOf('102')[0].dto).toEqual(
        expect.objectContaining({ branch_id: '10', courier_id: null }),
      );
    });

    it('jo‘natuvchini aniqlab bo‘lmasa — avvalgi xatti-harakat (kuryerga)', async () => {
      const ctx = setup({
        sourcePost: {
          id: '55',
          courier_id: '7',
          branch_id: '10',
          region_id: '14',
          status: Post_status.CANCELED,
        },
        orders: branchOrders(),
        sender: 'error',
      });

      await ctx.service.receiveCanceledPost(manager10, '55', {
        order_ids: ['101'],
      });

      expect(ctx.updateOf('102')[0].dto).toEqual(
        expect.objectContaining({ branch_id: '10', courier_id: '7' }),
      );
    });
  });
});
