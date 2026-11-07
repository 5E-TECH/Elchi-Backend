import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import {
  LogisticsServiceService,
  RETURN_REQUEST_NOT_ALLOWED_MESSAGE,
} from './logistics-service.service';

/**
 * Filial menejeri «Bu buyurtma kelmagan — qaytarish so'rovi» (egasi talabi
 * 2026-11-04): HQ → filial o'tkazma pochtasi (courier_id '0', SENT) dagi hali
 * qabul qilinmagan buyurtma yo'lda qoladi, `return_requested` qo'yiladi va HQ
 * «Qaytarish» ro'yxatiga tushadi. Faqat manzil filial menejeri; kuryer
 * xulqi o'zgarmaydi.
 */
describe('requestCourierOrderReturn — filial menejeri, o‘tkazma pochtasi', () => {
  type Row = Record<string, unknown>;

  const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };
  const manager20 = { id: '298', roles: ['manager'], branch_id: '20' };

  const transferPost = (extra: Row = {}): Row => ({
    id: '98',
    courier_id: '0',
    branch_id: '10',
    status: Post_status.SENT,
    ...extra,
  });
  // dispatchPostToBranch yozgan holat: yo'lda, filial hisobida, kuryersiz.
  const inTransfer = (id: string, extra: Row = {}): Row => ({
    id,
    status: Order_status.ON_THE_ROAD,
    post_id: '98',
    branch_id: '10',
    holder_type: 'BRANCH',
    holder_branch_id: '10',
    holder_courier_id: null,
    courier_id: null,
    return_requested: false,
    total_price: 100_000,
    ...extra,
  });

  function setup(options: {
    post?: Row | null;
    orders: Row[];
    assignment?: Row | null;
  }) {
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
                (query.status === undefined || row.status === query.status),
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
    const post =
      options.post === undefined ? transferPost() : (options.post ?? null);
    const postRepo = {
      findOne: jest.fn(
        (query: { where?: { id?: string; courier_id?: string } }) => {
          const where = query?.where ?? {};
          if (!post || String(where.id) !== String(post.id)) {
            return Promise.resolve(null);
          }
          // Kuryer yo'li `courier_id: requester.id` bilan qidiradi.
          if (
            where.courier_id !== undefined &&
            String(where.courier_id) !== String(post.courier_id)
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ ...post });
        },
      ),
      save: jest.fn((row: Row) => Promise.resolve(row)),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({ data: options.assignment ?? null });
        }
        return of({ data: null });
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

  async function expectStatus(
    promise: Promise<unknown>,
    status: number,
    reason?: string,
  ) {
    try {
      await promise;
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        statusCode?: number;
        data?: { reason?: string };
      };
      expect(payload.statusCode).toBe(status);
      if (reason) {
        expect(payload.data?.reason).toBe(reason);
      }
    }
  }

  it('o‘z filialiga jo‘natilgan SENT pochta — belgi qo‘yiladi, yo‘lda qoladi, pochta yopilmaydi', async () => {
    const ctx = setup({ orders: [inTransfer('101'), inTransfer('102')] });

    const response: any = await ctx.service.requestCourierOrderReturn(
      manager10,
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
        id: '198',
        roles: ['manager'],
        branch_return_request: { post_id: '98' },
      }),
    );
    expect(update.requester).not.toHaveProperty('courier_return_request');
    expect(ctx.orders.get('101')?.status).toBe(Order_status.ON_THE_ROAD);
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '101',
        action: 'logistics.return_request',
        user_id: '198',
        metadata: {
          post_id: '98',
          branch_id: '10',
          source: 'branch_not_arrived',
        },
      }),
    );
  });

  it('pochtada filial yo‘q, lekin hamma buyurtma shu filialda — ruxsat (receivePost qoidasi)', async () => {
    const ctx = setup({
      post: transferPost({ branch_id: null }),
      orders: [inTransfer('101'), inTransfer('102')],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      manager10,
      '98',
      '101',
    );
    expect(response.data.return_requested).toBe(true);
    expect(ctx.updates()).toHaveLength(1);
  });

  it('JWT da filial yo‘q — biriktirilgan filial (branch.user.find_by_user) olinadi', async () => {
    const ctx = setup({
      orders: [inTransfer('101')],
      assignment: { branch_id: '10', role: 'MANAGER' },
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      { id: '198', roles: ['manager'] },
      '98',
      '101',
    );
    expect(response.data.remaining_receivable).toBe(0);
  });

  it('qayta bosish — idempotent, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [
        inTransfer('101', { return_requested: true }),
        inTransfer('102'),
      ],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      manager10,
      '98',
      '101',
    );
    expect(response.data).toEqual({
      order_id: '101',
      post_id: '98',
      return_requested: true,
      already_requested: true,
      remaining_receivable: 1,
    });
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('boshqa filial menejeri — 403, hech narsa yozilmaydi, manzil filial oshkor qilinmaydi', async () => {
    const ctx = setup({ orders: [inTransfer('101')] });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager20, '98', '101'),
      403,
      'return_request_not_allowed',
    );
    expect(ctx.updates()).toHaveLength(0);

    // anKpzwxk: `details` da faqat `post_id` (manzil `branch_id` yo'q).
    let payload: { data?: { details?: unknown; branch_id?: unknown } } = {};
    try {
      await ctx.service.requestCourierOrderReturn(manager20, '98', '101');
    } catch (error) {
      payload = (error as RpcException).getError() as typeof payload;
    }
    expect(payload.data?.details).toEqual({ post_id: '98' });
    expect(payload.data?.branch_id).toBeUndefined();
  });

  it.each([
    [
      'filial registratori',
      { id: '77', roles: ['registrator'], branch_id: '10' },
    ],
    ['filial akkaunti', { id: '78', roles: ['branch'], branch_id: '10' }],
    ['market', { id: '79', roles: ['market'] }],
    ['admin (kerak emas)', { id: '2', roles: ['admin'] }],
  ])('%s — 403', async (_label, requester) => {
    const ctx = setup({ orders: [inTransfer('101')] });
    try {
      await ctx.service.requestCourierOrderReturn(requester, '98', '101');
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
      expect(payload.statusCode).toBe(403);
      expect(payload.message).toBe(RETURN_REQUEST_NOT_ALLOWED_MESSAGE);
    }
    expect(ctx.updates()).toHaveLength(0);
  });

  it('menejer kuryer pochtasida — 403 (kuryer pochtasi faqat kuryerniki)', async () => {
    const ctx = setup({
      post: transferPost({ courier_id: '209' }),
      orders: [inTransfer('101')],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      403,
      'return_request_not_allowed',
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('pochta topilmadi — 404', async () => {
    const ctx = setup({ post: null, orders: [inTransfer('101')] });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      404,
    );
  });

  it('qabul qilingan (RECEIVED) pochta — 400', async () => {
    const ctx = setup({
      post: transferPost({ status: Post_status.RECEIVED }),
      orders: [inTransfer('101')],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      400,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('buyurtma bu pochtada emas — 409', async () => {
    const ctx = setup({
      orders: [inTransfer('101'), inTransfer('102', { post_id: '99' })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '102'),
      409,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('allaqachon qabul qilingan (WAITING) — 400', async () => {
    const ctx = setup({
      orders: [inTransfer('101', { status: Order_status.WAITING })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      400,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('buyurtma kuryer hisobida (filial pochtasi hisobida emas) — 409', async () => {
    const ctx = setup({
      orders: [
        inTransfer('101', {
          holder_type: 'COURIER',
          holder_courier_id: '209',
          courier_id: '209',
        }),
      ],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      409,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('pochta o‘z filialiniki, lekin buyurtma boshqa filial (20) hisobida — 409, hech narsa yozilmaydi', async () => {
    const ctx = setup({
      orders: [inTransfer('101', { branch_id: '20', holder_branch_id: '20' })],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      409,
    );
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('boshqa filial hisobidagi buyurtma belgilangan bo‘lsa ham — 409 (idempotent javob belgini oshkor qilmaydi)', async () => {
    const ctx = setup({
      orders: [
        inTransfer('101', {
          branch_id: '20',
          holder_branch_id: '20',
          return_requested: true,
        }),
      ],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      409,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('marketga qaytarish belgisi (initiate-return, `return_reason`) — 409 market_return_requested, jim «allaqachon» emas', async () => {
    const ctx = setup({
      orders: [
        inTransfer('101', {
          return_requested: true,
          return_reason: 'Mijoz bekor qildi',
        }),
      ],
    });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(manager10, '98', '101'),
      409,
      'market_return_requested',
    );
    expect(ctx.updates()).toHaveLength(0);
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  });

  it('belgisiz, lekin eski initiate-return sababi qolgan — so‘rov bilan sabab tozalanadi (HQ ro‘yxatida ko‘rinsin)', async () => {
    const ctx = setup({
      orders: [inTransfer('101', { return_reason: 'eski sabab' })],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      manager10,
      '98',
      '101',
    );
    expect(response.data.already_requested).toBe(false);
    const [update] = ctx.updates();
    expect(update.dto).toEqual({ return_requested: true, return_reason: null });
    expect(update.requester).toEqual(
      expect.objectContaining({ branch_return_request: { post_id: '98' } }),
    );
  });

  it('kuryer xulqi o‘zgarmaydi: kuryer o‘tkazma pochtasida — 404 (avvalgidek)', async () => {
    const ctx = setup({ orders: [inTransfer('101')] });
    await expectStatus(
      ctx.service.requestCourierOrderReturn(
        { id: 'c1', roles: ['courier'] },
        '98',
        '101',
      ),
      404,
    );
    expect(ctx.updates()).toHaveLength(0);
  });

  it('kuryer xulqi o‘zgarmaydi: o‘z SENT pochtasida — courier_return_request bilan', async () => {
    const ctx = setup({
      post: transferPost({ courier_id: 'c1', branch_id: null }),
      orders: [
        inTransfer('101', {
          holder_type: 'COURIER',
          holder_courier_id: 'c1',
          courier_id: 'c1',
          last_handover_by: 'manager-7',
        }),
      ],
    });
    const response: any = await ctx.service.requestCourierOrderReturn(
      { id: 'c1', roles: ['courier'] },
      '98',
      '101',
    );
    expect(response.data.already_requested).toBe(false);
    const [update] = ctx.updates();
    expect(update.requester).toEqual(
      expect.objectContaining({ courier_return_request: { post_id: '98' } }),
    );
    expect(update.requester).not.toHaveProperty('branch_return_request');
    expect(ctx.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ source: 'courier_not_arrived' }),
      }),
    );
  });
});

/**
 * Oqim (egasi talabi 2026-11-04): menejer qabuldan OLDIN «kelmagan» deydi →
 * qolganini qabul qiladi (pochta SENT qoladi: belgilangan buyurtma hamon
 * yo'lda) → HQ tasdiqlaydi: buyurtma HQ omboriga dispatch oldidagi holatida
 * (RECEIVED, hudud NEW pochtasi, holder HQ) — HQ uni qayta jo'nata oladi;
 * o'tkazma pochtasi yopiladi (RECEIVED).
 *
 * Soxta order-service qulf ostidagi shartli yozuvlarni (`post_receive_guard`,
 * `return_request_review`) bazadagi qatorga nisbatan tekshiradi — HQ
 * tasdig'i ↔ filial qabuli poygasi shu bilan sinaladi.
 */
describe('filial «kelmagan» → qisman qabul → HQ tasdig‘i (oqim)', () => {
  type Row = Record<string, unknown>;

  const conflict = (reason: string) =>
    throwError(
      () =>
        new RpcException({
          statusCode: 409,
          message: 'Buyurtma holati o‘zgardi',
          reason,
        }),
    );

  function setupFlow(options?: {
    /** order.find_all (post_id) birinchi javobi — receivePost qulfsiz surati. */
    receiveSnapshot?: Row[];
    /** order.find_by_id javobi — approve qulfsiz surati. */
    approveSnapshot?: Row[];
  }) {
    const post: Row = {
      id: '98',
      courier_id: '0',
      branch_id: '10',
      region_id: '14',
      status: Post_status.SENT,
      order_quantity: 2,
      post_total_price: 200_000,
    };
    // HQ hudud NEW pochtasi (dispatch shu yerdan olgan).
    const newPost: Row = {
      id: '700',
      courier_id: '0',
      branch_id: null,
      region_id: '14',
      status: Post_status.NEW,
      order_quantity: 0,
      post_total_price: 0,
    };
    const base = {
      status: Order_status.ON_THE_ROAD,
      post_id: '98',
      branch_id: '10',
      region_id: '14',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
      return_requested: false,
      total_price: 100_000,
    };
    const orders = new Map<string, Row>([
      ['101', { id: '101', ...base }],
      ['102', { id: '102', ...base }],
    ]);
    let receiveSnapshot = options?.receiveSnapshot;
    const approveSnapshot = new Map(
      (options?.approveSnapshot ?? []).map((row) => [String(row.id), row]),
    );
    const orderClient = {
      send: jest.fn(
        (
          pattern: { cmd: string },
          payload: {
            id?: string;
            dto?: Row;
            query?: { post_id?: string } & Row;
            requester?: {
              post_receive_guard?: { post_id: string; status: string | null };
              return_request_review?: {
                post_id: string | null;
                status: string | null;
                source: string;
              };
            };
          },
        ) => {
          if (pattern.cmd === 'order.find_by_id') {
            const snapshot = approveSnapshot.get(String(payload.id));
            return of({
              ...(snapshot ?? orders.get(String(payload.id)) ?? {}),
            });
          }
          if (pattern.cmd === 'order.find_all') {
            const query = payload.query ?? {};
            if (receiveSnapshot && query.post_id !== undefined) {
              const rows = receiveSnapshot;
              receiveSnapshot = undefined;
              return of({ data: { data: rows.map((row) => ({ ...row })) } });
            }
            // order.find_all filtrlari: post_id, status (bitta yoki massiv),
            // return_requested, holder_type.
            const statuses =
              query.status === undefined
                ? null
                : ([] as unknown[]).concat(query.status);
            const rows = [...orders.values()].filter(
              (row) =>
                (query.post_id === undefined ||
                  String(row.post_id) === String(query.post_id)) &&
                (!statuses || statuses.includes(row.status)) &&
                (query.return_requested === undefined ||
                  row.return_requested === query.return_requested) &&
                (query.holder_type === undefined ||
                  row.holder_type === query.holder_type),
            );
            return of({ data: { data: rows.map((row) => ({ ...row })) } });
          }
          if (pattern.cmd === 'order.update') {
            const row = orders.get(String(payload.id));
            if (!row) {
              return of({ statusCode: 200 });
            }
            // order-service qulf ostidagi tekshiruvlari (soddalashtirilgan).
            const guard = payload.requester?.post_receive_guard;
            if (
              guard &&
              (String((row.post_id as string | null) ?? '') !== guard.post_id ||
                (guard.status && row.status !== guard.status))
            ) {
              return conflict('post_receive_conflict');
            }
            const review = payload.requester?.return_request_review;
            if (
              review &&
              (row.return_requested !== true ||
                String((row.post_id as string | null) ?? '') !==
                  String(review.post_id ?? '') ||
                (review.status && row.status !== review.status))
            ) {
              return conflict('return_request_review_conflict');
            }
            Object.assign(row, payload.dto);
            // updateFull: branch_id berilsa holder qayta hisoblanadi (HQ = '1').
            if (payload.dto && 'branch_id' in payload.dto) {
              const branchId = (row.branch_id as string | null) ?? '';
              row.holder_type = branchId === '1' ? 'HQ' : 'BRANCH';
              row.holder_branch_id = branchId === '1' ? null : branchId;
            }
            return of({ statusCode: 200 });
          }
          return of({});
        },
      ),
    };
    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const postRepo = {
      findOne: jest.fn((query: { where?: Record<string, string> }) => {
        const where = query?.where ?? {};
        if (where.region_id !== undefined) {
          return Promise.resolve(
            String(where.region_id) === '14' && where.status === Post_status.NEW
              ? { ...newPost }
              : null,
          );
        }
        if (String(where.id) === '98' && where.courier_id === undefined) {
          return Promise.resolve({ ...post });
        }
        if (String(where.id) === '700') {
          return Promise.resolve({ ...newPost });
        }
        return Promise.resolve(null);
      }),
      find: jest.fn(() => Promise.resolve([{ ...post }])),
      create: jest.fn((row: Row) => row),
      save: jest.fn((row: Row) => {
        Object.assign(post, row);
        return Promise.resolve({ ...row });
      }),
      createQueryBuilder: jest.fn(() => postUpdateQb),
    };
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'branch.find_hq'
          ? of({ data: { id: '1' } })
          : of({ data: null }),
      ),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({ data: [] })) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn().mockResolvedValue(undefined), query: jest.fn() } as any,
    );
    return { service, post, orders, postRepo };
  }

  const manager10 = { id: '198', roles: ['manager'], branch_id: '10' };
  const admin = { id: '2', roles: ['admin'] };

  it('belgilangan buyurtma qabuldan keyin ham yo‘lda; HQ tasdig‘i uni HQ NEW pochtasiga (RECEIVED) qaytaradi va pochtani yopadi', async () => {
    const { service, post, orders, postRepo } = setupFlow();

    await service.requestCourierOrderReturn(manager10, '98', '101');
    expect(orders.get('101')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
    });

    // Menejer qolganini (102) qabul qiladi — 101 yo'lda qoladi, pochta SENT.
    await service.receivePost(manager10, '98', { order_ids: ['102'] });
    expect(orders.get('102')).toMatchObject({ status: Order_status.WAITING });
    expect(orders.get('101')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
      holder_type: 'BRANCH',
    });
    expect(post.status).toBe(Post_status.SENT);

    // HQ «Qaytarish» ro'yxatida ko'rinadi.
    const list: any = await service.getReturnRequests(admin);
    expect(
      list.data.groups.flatMap((g: Row) =>
        (g.orders as Row[]).map((o) => o.id),
      ),
    ).toEqual(['101']);

    // HQ tasdiqlaydi — dispatch oldidagi holat, o'tkazma pochtasi yopiladi.
    const approved: any = await service.approveReturnRequests(
      { order_ids: ['101'] },
      admin,
    );
    expect(approved.data.order_ids).toEqual(['101']);
    expect(orders.get('101')).toMatchObject({
      status: Order_status.RECEIVED,
      return_requested: false,
      courier_id: null,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
    });
    expect(post.status).toBe(Post_status.RECEIVED);
    // Yangi pochta yaratilmadi — mavjud hudud NEW pochtasi.
    expect(postRepo.create).not.toHaveBeenCalled();
    // Filial ro'yxatida endi yo'q (pochta yopilgan, buyurtma HQ da).
    const after: any = await service.getReturnRequests(admin);
    expect(after.data.total).toBe(0);
  });

  it('poyga: qabul surati olingach HQ tasdiqlagan — qoldiq qayta belgilanmaydi (HQ da qoladi), xato ham emas', async () => {
    const snapshot = [
      {
        id: '101',
        status: Order_status.ON_THE_ROAD,
        post_id: '98',
        branch_id: '10',
        holder_type: 'BRANCH',
        return_requested: true,
      },
      {
        id: '102',
        status: Order_status.ON_THE_ROAD,
        post_id: '98',
        branch_id: '10',
        holder_type: 'BRANCH',
        return_requested: false,
      },
    ];
    const { service, orders } = setupFlow({ receiveSnapshot: snapshot });
    // Bazada 101 allaqachon HQ tasdig'idan o'tgan.
    Object.assign(orders.get('101') ?? {}, {
      status: Order_status.RECEIVED,
      return_requested: false,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
      holder_branch_id: null,
    });

    const response: any = await service.receivePost(manager10, '98', {
      order_ids: ['102'],
    });

    expect(response.failures).toEqual([]);
    expect(orders.get('102')).toMatchObject({ status: Order_status.WAITING });
    expect(orders.get('101')).toMatchObject({
      status: Order_status.RECEIVED,
      return_requested: false,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
    });
  });

  it('poyga: tasdiqlangan buyurtmani eski surat bilan qabul qilish — yozilmaydi (NEW pochtada WAITING bo‘lmaydi)', async () => {
    const snapshot = [
      {
        id: '101',
        status: Order_status.ON_THE_ROAD,
        post_id: '98',
        branch_id: '10',
        holder_type: 'BRANCH',
        return_requested: true,
      },
    ];
    const { service, orders } = setupFlow({ receiveSnapshot: snapshot });
    orders.delete('102');
    Object.assign(orders.get('101') ?? {}, {
      status: Order_status.RECEIVED,
      return_requested: false,
      post_id: '700',
      branch_id: '1',
      holder_type: 'HQ',
      holder_branch_id: null,
    });

    const response: any = await service.receivePost(manager10, '98', {
      order_ids: ['101'],
    });

    expect(response.failures).toEqual([
      expect.objectContaining({ order_id: '101' }),
    ]);
    // Pochtada endi yo'q — «qabul qilinmadi» ro'yxatiga ham tushmaydi.
    expect(response.not_received_order_ids).toEqual([]);
    expect(orders.get('101')).toMatchObject({
      status: Order_status.RECEIVED,
      post_id: '700',
      branch_id: '1',
    });
  });

  it('poyga: filial qabul qilgandan keyin eski surat bilan HQ tasdig‘i — yozilmaydi, 409', async () => {
    const flagged = {
      id: '101',
      status: Order_status.ON_THE_ROAD,
      post_id: '98',
      branch_id: '10',
      region_id: '14',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: null,
      return_requested: true,
      total_price: 100_000,
    };
    const { service, orders } = setupFlow({ approveSnapshot: [flagged] });
    // Bazada filial 101 ni allaqachon qabul qilgan.
    Object.assign(orders.get('101') ?? {}, {
      status: Order_status.WAITING,
      return_requested: false,
    });

    try {
      await service.approveReturnRequests({ order_ids: ['101'] }, admin);
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect(
        ((error as RpcException).getError() as { statusCode?: number })
          .statusCode,
      ).toBe(409);
    }
    expect(orders.get('101')).toMatchObject({
      status: Order_status.WAITING,
      branch_id: '10',
      holder_type: 'BRANCH',
      post_id: '98',
    });
  });
});
