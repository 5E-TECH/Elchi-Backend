import { of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * FIX3 LC-06 → egasi qarori (2026-11-03): HQ bekor pochtani QISMAN qabul
 * qilsa, qabul qilinmagan posilkalar o'zi HECH QAYERGA ketmaydi — HQ da shu
 * pochtada kutadi. Jo'natuvchi filialga qaytarish — alohida «Filialga
 * qaytarish» (`returnCanceledOrdersToSender`), faqat tanlanganlar. Pochta
 * hammasi qabul qilinganda yoki qaytarilganda yopiladi. Filial qabuli
 * (kuryer → filial) avvalgidek: qolgani jo'natuvchiga qaytadi.
 *
 * Haqiqiy holat (jo'natilgandan KEYIN): createCanceledPostToHq / HQ kuryeri
 * createCanceledPost buyurtmaga allaqachon branch_id = HQ yozadi, updateFull
 * esa holder'ni HQ qiladi (holder_branch_id null). HQ = '1'.
 */
describe('FIX3 LC-06 — HQ qabulida qolganlar pochtada, qaytarish faqat tugma bilan', () => {
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

  /**
   * Holatli soxta order-service va pochta jadvali: `order.update` buyurtmani
   * o'zgartiradi, `order.find_all` `canceled_post_id`/`status` bo'yicha
   * filtrlaydi — qayta o'qish (pochtani yopish) haqiqiy holatni ko'radi.
   */
  function setup(options: {
    sourcePost: Row;
    orders: Row[];
    sender?: Row | null | 'error';
    /** Shu jo'natuvchining boshqa ochiq pochtalari (guruh). */
    extraPosts?: Row[];
    /** Shu buyurtmani yozish 409 bilan yiqiladi (boshqa xodim o'zgartirgan). */
    failUpdateOf?: string;
    /** `timeout` — order-service javob bermadi (logistics uni 502 qiladi). */
    failUpdateWith?: 'conflict' | 'timeout';
    /** Buyurtma yozilganda (shu orada) chaqiriladi — poyga sinovi uchun. */
    onUpdate?: (
      orderId: string,
      ctx: { orders: Map<string, Row>; posts: Map<string, Row> },
    ) => void;
  }) {
    const orders = new Map<string, Row>(
      options.orders.map((order) => [String(order.id), { ...order }]),
    );
    const posts = new Map<string, Row>(
      [options.sourcePost, ...(options.extraPosts ?? [])].map((post) => [
        String(post.id),
        { ...post },
      ]),
    );
    let nextPostId = 88;
    const orderClient = {
      send: jest.fn(
        (
          pattern: { cmd: string },
          payload?: { id?: string; dto?: Row; query?: Row },
        ) => {
          if (pattern.cmd === 'order.find_all') {
            const query = payload?.query ?? {};
            const rows = [...orders.values()].filter(
              (order) =>
                (query.canceled_post_id === undefined ||
                  String(order.canceled_post_id) ===
                    String(query.canceled_post_id)) &&
                (query.status === undefined || order.status === query.status),
            );
            return of({ data: { data: rows.map((row) => ({ ...row })) } });
          }
          if (pattern.cmd === 'order.update') {
            const orderId = String(payload?.id);
            if (
              options.failUpdateOf === orderId &&
              options.failUpdateWith === 'timeout'
            ) {
              return throwError(() => new Error('Timeout has occurred'));
            }
            if (options.failUpdateOf === orderId) {
              return throwError(() => ({
                statusCode: 409,
                message: `Buyurtma #${orderId} holati o'zgardi`,
              }));
            }
            Object.assign(orders.get(orderId) ?? {}, payload?.dto ?? {});
            options.onUpdate?.(orderId, { orders, posts });
            return of({ statusCode: 200, data: { id: orderId } });
          }
          return of({ statusCode: 200, data: { id: payload?.id } });
        },
      ),
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
      find: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          [...posts.values()]
            .filter(
              (post) =>
                post.status === where.status &&
                String(post.courier_id) === String(where.courier_id),
            )
            .map((post) => ({ ...post })),
        ),
      ),
      // Aniq id — jadvaldan; `id: Not(...)` (qaytarish pochtasini izlash) —
      // yo'q (yangisi yaratiladi).
      findOne: jest.fn(({ where }: { where: { id?: unknown } }) => {
        const id = where?.id;
        if (typeof id === 'string' || typeof id === 'number') {
          const post = posts.get(String(id));
          return Promise.resolve(post ? { ...post } : null);
        }
        return Promise.resolve(null);
      }),
      create: jest.fn((payload: Row) => payload),
      save: jest.fn((post: Row) => {
        const id = String(post.id ?? nextPostId++);
        const saved = { ...post, id };
        posts.set(id, saved);
        return Promise.resolve({ ...saved });
      }),
      update: jest.fn((id: string, patch: Row) => {
        Object.assign(posts.get(String(id)) ?? {}, patch);
        return Promise.resolve(undefined);
      }),
      delete: jest.fn(({ id }: { id: string }) => {
        posts.delete(String(id));
        return Promise.resolve(undefined);
      }),
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
      branchClient as any,
      {} as any,
      { send: jest.fn(() => of({})) } as any,
      activityLog as any,
    );

    const updateOf = (orderId: string) =>
      orderClient.send.mock.calls
        .filter(([pattern]) => pattern.cmd === 'order.update')
        .map(
          ([, payload]) =>
            payload as {
              id: string;
              dto: Row;
              requester: Row & { note?: string };
            },
        )
        .filter(({ id }) => String(id) === orderId);
    const updateCount = () =>
      orderClient.send.mock.calls.filter(
        ([pattern]) => pattern.cmd === 'order.update',
      ).length;

    return {
      service,
      orderClient,
      branchClient,
      postRepo,
      activityLog,
      orders,
      posts,
      updateOf,
      updateCount,
    };
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
  const samarqandManager: Row = {
    branch_id: '10',
    role: 'MANAGER',
    branch: { id: '10', name: 'Samarqand' },
  };
  const admin = { id: '1', roles: ['admin'] };

  describe('HQ qabuli: tanlanmaganlar shu pochtada qoladi', () => {
    it('2 tadan 1 tasi qabul qilinsa — qolgani HQ da kutadi, hech narsa qaytmaydi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      const response: any = await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101'],
      });

      expect(response.data).toEqual({
        order_ids: ['101'],
        remaining_order_ids: ['102'],
        requeued_post_ids: [],
        grouped_post_ids: ['77'],
        branch_id: '1',
        post_status: Post_status.CANCELED,
        post_closed: false,
      });
      // Qabul qilingan 101 — HQ da (o'zgarmagan qoida), poyga himoyasi bilan.
      const [received] = ctx.updateOf('101');
      expect(received.dto).toEqual({
        status: Order_status.CANCELLED,
        branch_id: '1',
        courier_id: null,
        assigned_at: null,
        canceled_post_id: null,
      });
      expect(received.requester).toEqual(
        expect.objectContaining({
          note: 'Canceled order received by HQ and held for market handover',
          canceled_post_guard: { post_id: '77' },
        }),
      );
      // 102 ga tegilmadi, qaytarish pochtasi yaratilmadi.
      expect(ctx.updateOf('102')).toHaveLength(0);
      expect(ctx.postRepo.create).not.toHaveBeenCalled();
      expect(ctx.orders.get('102')).toEqual(sentToHq('102', 500_000));
      // Pochta ochiq: hisobda qabul qilingan + kutayotgan (2 / 1.5 mln).
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          order_quantity: 2,
          post_total_price: 1_500_000,
        }),
      );
      expect(ctx.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: '77',
          action: 'logistics.canceled_post_partial_receive',
          user_id: '1',
        }),
      );
    });

    it('qolganini keyin qabul qilsa — pochta yopiladi, hisobda ikkala qabul', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101'],
      });
      const response: any = await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['102'],
      });

      expect(response.data).toEqual(
        expect.objectContaining({
          order_ids: ['102'],
          remaining_order_ids: [],
          post_status: Post_status.CANCELED_RECEIVED,
          post_closed: true,
        }),
      );
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 2,
          post_total_price: 1_500_000,
        }),
      );
    });

    it('hammasi bir martada qabul qilinsa — darhol yopiladi (avvalgidek)', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      const response: any = await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101', '102'],
      });

      expect(response.data.post_closed).toBe(true);
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 2,
          post_total_price: 1_500_000,
        }),
      );
      expect(ctx.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'status_change',
          new_value: { status: Post_status.CANCELED_RECEIVED },
        }),
      );
    });

    it('bo‘sh tanlov rad etiladi — avval butun pochta qaytib ketardi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      await expect(
        ctx.service.receiveCanceledPost(admin, '77', { order_ids: [] }),
      ).rejects.toBeTruthy();
      expect(ctx.updateCount()).toBe(0);
      expect(ctx.posts.get('77')?.status).toBe(Post_status.CANCELED);
    });

    it('shu orada filial yangi buyurtma qo‘shsa — pochta yopilmaydi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
        onUpdate: (orderId, { orders, posts }) => {
          if (orderId !== '102') return;
          // createCanceledPostToHq: ochiq pochtaga qo'shadi (`+=`).
          orders.set('103', sentToHq('103', 300_000));
          const post = posts.get('77')!;
          post.order_quantity = Number(post.order_quantity) + 1;
          post.post_total_price = Number(post.post_total_price) + 300_000;
        },
      });

      const response: any = await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101', '102'],
      });

      expect(response.data).toEqual(
        expect.objectContaining({
          remaining_order_ids: ['103'],
          post_closed: false,
        }),
      );
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          order_quantity: 3,
          post_total_price: 1_800_000,
        }),
      );
    });

    it('guruh: bo‘shagan pochta yopiladi, buyurtmasi qolgan pochta ochiq qoladi', async () => {
      const ctx = setup({
        sourcePost: {
          ...managerPostToHq,
          order_quantity: 1,
          post_total_price: 1_000_000,
        },
        extraPosts: [
          {
            ...managerPostToHq,
            id: '78',
            order_quantity: 1,
            post_total_price: 500_000,
          },
        ],
        orders: [
          sentToHq('101', 1_000_000),
          { ...sentToHq('102', 500_000), canceled_post_id: '78' },
        ],
        sender: samarqandManager,
      });

      const response: any = await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101'],
      });

      expect(response.data).toEqual(
        expect.objectContaining({
          remaining_order_ids: ['102'],
          grouped_post_ids: ['77', '78'],
          post_closed: true,
        }),
      );
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 1,
          post_total_price: 1_000_000,
        }),
      );
      expect(ctx.posts.get('78')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          order_quantity: 1,
          post_total_price: 500_000,
        }),
      );
    });
  });

  describe('HQ «Filialga qaytarish»: faqat tanlanganlar', () => {
    it('menejer jo‘natgan pochta: tanlangani menejer filiali (10) pochtasiga, kuryersiz qaytadi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      const response: any = await ctx.service.returnCanceledOrdersToSender(
        admin,
        '77',
        { order_ids: ['102'] },
      );

      expect(response.data).toEqual({
        order_ids: ['102'],
        remaining_order_ids: ['101'],
        requeued_post_ids: ['88'],
        return_branch_id: '10',
        return_branch_name: 'Samarqand',
        post_status: Post_status.CANCELED,
        post_closed: false,
      });
      expect(ctx.postRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          courier_id: '8',
          branch_id: '10',
          region_id: '14',
          status: Post_status.CANCELED,
        }),
      );
      const [returned] = ctx.updateOf('102');
      expect(returned.dto).toEqual({
        status: Order_status.CANCELLED_SENT,
        branch_id: '10',
        courier_id: null,
        assigned_at: null,
        canceled_post_id: '88',
      });
      expect(returned.requester).toEqual(
        expect.objectContaining({
          note: 'Canceled order returned to sender branch by HQ',
          canceled_post_guard: { post_id: '77' },
          canceled_post_return: {
            post_id: '77',
            return_post_id: '88',
            to_branch_id: '10',
            to_branch_name: 'Samarqand',
          },
        }),
      );
      // Tanlanmagan 101 — pochtada qoldi.
      expect(ctx.updateOf('101')).toHaveLength(0);
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          order_quantity: 1,
          post_total_price: 1_000_000,
        }),
      );
      expect(ctx.posts.get('88')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          branch_id: '10',
          order_quantity: 1,
          post_total_price: 500_000,
        }),
      );
      expect(ctx.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: '77',
          action: 'logistics.canceled_post_return',
          user_id: '1',
        }),
      );
    });

    it('qabul + qaytarish → pochta yopiladi, hisobda faqat HQ qabul qilganlari', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101'],
      });
      const response: any = await ctx.service.returnCanceledOrdersToSender(
        admin,
        '77',
        { order_ids: ['102'] },
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          remaining_order_ids: [],
          post_status: Post_status.CANCELED_RECEIVED,
          post_closed: true,
        }),
      );
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED_RECEIVED,
          order_quantity: 1,
          post_total_price: 1_000_000,
        }),
      );
    });

    it('HQ kuryeri olib kelgan pochta qaytarilmaydi — hech narsa yozilmaydi', async () => {
      const ctx = setup({
        sourcePost: { ...managerPostToHq, courier_id: '31' },
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: { branch_id: '1', role: 'COURIER' },
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(
          { id: '5', roles: ['registrator'], branch_id: '1' },
          '77',
          { order_ids: ['102'] },
        ),
      ).rejects.toBeTruthy();
      expect(ctx.updateCount()).toBe(0);
      expect(ctx.postRepo.create).not.toHaveBeenCalled();
    });

    it('jo‘natuvchini aniqlab bo‘lmasa — qaytarish rad etiladi (HQ ga qayta tushmaydi)', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: 'error',
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['102'],
        }),
      ).rejects.toBeTruthy();
      expect(ctx.updateCount()).toBe(0);
    });

    it('qabul qilingan buyurtmani qaytarib bo‘lmaydi; bo‘sh tanlov ham rad', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
      });

      await ctx.service.receiveCanceledPost(admin, '77', {
        order_ids: ['101'],
      });
      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['101'],
        }),
      ).rejects.toBeTruthy();
      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: [],
        }),
      ).rejects.toBeTruthy();
      expect(ctx.updateCount()).toBe(1);
    });

    it('yopilgan pochtadan qaytarib bo‘lmaydi', async () => {
      const ctx = setup({
        sourcePost: {
          ...managerPostToHq,
          status: Post_status.CANCELED_RECEIVED,
        },
        orders: [],
        sender: samarqandManager,
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['102'],
        }),
      ).rejects.toBeTruthy();
    });

    it('filial pochtasini qaytarish tugmasi bilan qaytarib bo‘lmaydi (faqat HQ)', async () => {
      const ctx = setup({
        sourcePost: {
          id: '55',
          courier_id: '7',
          branch_id: '10',
          region_id: '14',
          status: Post_status.CANCELED,
        },
        orders: [
          {
            ...sentToHq('101', 1_000_000),
            canceled_post_id: '55',
            branch_id: '10',
          },
        ],
        sender: { branch_id: '10', role: 'COURIER' },
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(
          { id: '8', roles: ['manager'], branch_id: '10' },
          '55',
          { order_ids: ['101'] },
        ),
      ).rejects.toBeTruthy();
      expect(ctx.updateCount()).toBe(0);
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
        sender: samarqandManager,
      });

      await ctx.service.returnCanceledOrdersToSender(admin, '77', {
        order_ids: ['102'],
      });

      const [returned] = ctx.updateOf('102');
      expect(returned.dto).toEqual(
        expect.objectContaining({ branch_id: '12', courier_id: null }),
      );
      // Boshqa filial — nom faqat jo'natuvchi filialniki bo'lsa.
      expect(returned.requester.canceled_post_return).toEqual(
        expect.objectContaining({ to_branch_id: '12', to_branch_name: null }),
      );
    });

    it('yarim yo‘lda 409 — ko‘chganlari hisobda qoladi, pochta ochiq', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
        failUpdateOf: '102',
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['101', '102'],
        }),
      ).rejects.toBeTruthy();

      expect(ctx.posts.get('88')).toEqual(
        expect.objectContaining({
          order_quantity: 1,
          post_total_price: 1_000_000,
        }),
      );
      expect(ctx.posts.get('77')).toEqual(
        expect.objectContaining({
          status: Post_status.CANCELED,
          order_quantity: 1,
          post_total_price: 500_000,
        }),
      );
    });

    it('birinchi buyurtmadayoq yiqilsa — filialda bo‘sh pochta qolmaydi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
        failUpdateOf: '102',
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['102'],
        }),
      ).rejects.toBeTruthy();

      expect(ctx.postRepo.delete).toHaveBeenCalledWith({ id: '88' });
      expect(ctx.posts.has('88')).toBe(false);
      expect(ctx.posts.get('77')?.status).toBe(Post_status.CANCELED);
    });

    it('timeout (502) da yangi qaytarish pochtasi o‘chirilmaydi — kechikkan yozuv unga tushadi', async () => {
      const ctx = setup({
        sourcePost: managerPostToHq,
        orders: [sentToHq('101', 1_000_000), sentToHq('102', 500_000)],
        sender: samarqandManager,
        failUpdateOf: '102',
        failUpdateWith: 'timeout',
      });

      await expect(
        ctx.service.returnCanceledOrdersToSender(admin, '77', {
          order_ids: ['102'],
        }),
      ).rejects.toBeTruthy();

      expect(ctx.postRepo.delete).not.toHaveBeenCalled();
      expect(ctx.posts.has('88')).toBe(true);
    });
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
