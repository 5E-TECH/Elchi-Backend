import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';
import { Order_status, Post_status } from '@app/common';

describe('LogisticsServiceService scanAssignOrder', () => {
  function setup(options?: {
    order?: Record<string, unknown>;
    branchId?: string;
    openPost?: Record<string, unknown> | null;
    linkedPost?: Record<string, unknown> | null;
    orderLookupError?: unknown;
    // P1b — skan bilan avtomatik filial qabuli
    receiveByScan?: { received?: boolean; reason?: string } | 'throw';
    orderAfterReceive?: Record<string, unknown>;
    // ITEM 5 — kuryer filialining turi (`branch.user.find_by_user` → branch.type)
    branchType?: string;
    hqBranchId?: string;
    // `branch` qatori javobda yo'q (eski javob / o'chirilgan filial) → find_hq zaxirasi
    omitBranch?: boolean;
    findHqError?: boolean;
  }) {
    const order = {
      id: '101',
      branch_id: '10',
      status: Order_status.RECEIVED,
      courier_id: null,
      post_id: null,
      total_price: 120000,
      region_id: '1',
      ...options?.order,
    };

    // P1b: qabuldan KEYIN buyurtma yangi holatda o'qilishi kerak (filial+status
    // o'zgaradi). Shuning uchun `order.find_by_qr` qabuldan keyin boshqa obyekt
    // qaytaradi — real oqimni aynan shu simulyatsiya qiladi.
    let scanReceiveDone = false;

    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_qr') {
          if (options?.orderLookupError) {
            return throwError(() => options.orderLookupError);
          }
          if (scanReceiveDone && options?.orderAfterReceive) {
            return of({ data: { ...order, ...options.orderAfterReceive } });
          }
          return of({ data: order });
        }
        if (pattern.cmd === 'order.transfer_batch.receive_one_by_scan') {
          if (options?.receiveByScan === 'throw') {
            return throwError(
              () =>
                new RpcException({
                  statusCode: 400,
                  message:
                    "Paket hali jo'natilmagan — posilka filialga yetib kelmagan",
                }),
            );
          }
          const payload = options?.receiveByScan ?? { received: false };
          if (payload.received) {
            scanReceiveDone = true;
          }
          return of({ data: payload });
        }
        if (pattern.cmd === 'order.update') {
          return of({ ok: true });
        }
        return of({});
      }),
    };

    // Buyruq bo'yicha yo'naltiriladi: `branch.find_hq` zaxirasi javob bermasa,
    // har bir skan 404 'HQ branch topilmadi' bilan yiqilardi.
    const branchClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'branch.find_hq') {
          if (options?.findHqError) {
            return throwError(() => new Error('branch-service down'));
          }
          return of({ data: { id: options?.hqBranchId ?? '1' } });
        }
        const branchId = options?.branchId ?? '10';
        return of({
          data: {
            branch_id: branchId,
            ...(options?.omitBranch
              ? {}
              : {
                  branch: {
                    id: branchId,
                    type: options?.branchType ?? 'REGIONAL',
                  },
                }),
          },
        });
      }),
    };

    const postUpdateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const postRepo = {
      // Post hisoblagichi (order_quantity) atomik UPDATE query orqali yangilanadi.
      createQueryBuilder: jest.fn(() => postUpdateQb),
      findOne: jest.fn(
        (query: {
          where?: { id?: string; courier_id?: string; status?: Post_status };
        }) => {
          if (query?.where?.id && options?.linkedPost !== undefined) {
            // Haqiqiy so'rov kabi: `courier_id` berilsa, boshqa kuryerning
            // pochtasi (masalan hudud NEW pochtasi, courier '0') topilmaydi.
            const linkedCourierId = (
              options.linkedPost as { courier_id?: string } | null
            )?.courier_id;
            if (
              query.where.courier_id !== undefined &&
              query.where.courier_id !== linkedCourierId
            ) {
              return Promise.resolve(null);
            }
            return Promise.resolve(options.linkedPost);
          }
          if (query?.where?.status === Post_status.SENT) {
            return Promise.resolve(
              options?.openPost === undefined
                ? {
                    id: 'p-open',
                    courier_id: 'c1',
                    status: Post_status.SENT,
                    order_quantity: 2,
                    post_total_price: 200000,
                  }
                : options.openPost,
            );
          }
          return Promise.resolve(null);
        },
      ),
      create: jest.fn((payload: Record<string, unknown>) => payload),
      save: jest.fn((entity: Record<string, unknown>) =>
        Promise.resolve({
          ...entity,
          id: String((entity.id as string | number | undefined) ?? 'p-new'),
        }),
      ),
    };

    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({
        items: [],
        meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
      }),
      findByEntity: jest.fn().mockResolvedValue([]),
      findByUser: jest.fn().mockResolvedValue([]),
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

    return {
      service,
      orderClient,
      branchClient,
      postRepo,
      postUpdateQb,
      activityLog,
    };
  }

  async function expectRpcStatus(
    promise: Promise<unknown>,
    expectedStatus: number,
    expectedMessagePart?: string,
  ) {
    try {
      await promise;
      throw new Error('Expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
      expect(payload?.statusCode).toBe(expectedStatus);
      if (expectedMessagePart) {
        expect(String(payload?.message ?? '')).toContain(expectedMessagePart);
      }
    }
  }

  it('assigns order to courier and reuses existing open post', async () => {
    const { service, orderClient, postUpdateQb } = setup();

    const result: any = await service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_by_qr' },
      { token: 'ORD-abc123' },
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: expect.objectContaining({
          courier_id: 'c1',
          status: Order_status.ON_THE_ROAD,
          post_id: 'p-open',
        }),
      }),
    );
    // Reused 'p-open' postning hisoblagichi atomik UPDATE query bilan oshiriladi.
    expect(postUpdateQb.where).toHaveBeenCalledWith('id = :id', {
      id: 'p-open',
    });
    expect(postUpdateQb.execute).toHaveBeenCalled();
    expect(result.data.idempotent).toBe(false);
    expect(result.data.post_created).toBe(false);
  });

  it('creates new post when courier has no open post', async () => {
    const { service, postRepo } = setup({ openPost: null });

    const result: any = await service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: 'c1',
        status: Post_status.SENT,
      }),
    );
    expect(result.data.post_created).toBe(true);
    expect(result.data.post_id).toBe('p-new');
  });

  it('returns 403 when order belongs to another branch', async () => {
    const { service } = setup({ branchId: '99' });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      403,
      'Boshqa filial orderi',
    );
  });

  it('preserves downstream QR lookup errors', async () => {
    const { service } = setup({
      orderLookupError: new RpcException({
        statusCode: 500,
        message: 'Order service failed',
      }),
    });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      500,
      'Order service failed',
    );
  });

  it('returns error when order status is not NEW/RECEIVED', async () => {
    const { service } = setup({
      order: { status: Order_status.SOLD },
    });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      400,
      "Order holati noto'g'ri",
    );
  });

  it('returns error when order is already assigned to another courier', async () => {
    const { service } = setup({
      order: { courier_id: 'other-courier' },
    });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      400,
      'boshqa courierga',
    );
  });

  it('is idempotent when same courier scans same order again', async () => {
    const { service, orderClient } = setup({
      order: {
        status: Order_status.ON_THE_ROAD,
        courier_id: 'c1',
        post_id: 'p-open',
      },
      linkedPost: {
        id: 'p-open',
        courier_id: 'c1',
        status: Post_status.SENT,
        order_quantity: 5,
        post_total_price: 500000,
      },
    });

    const result: any = await service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

    expect(result.data.idempotent).toBe(true);
    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  // ===== P1b — skan bilan avtomatik filial qabuli =====

  const scanReceiveCalls = (orderClient: { send: jest.Mock }) =>
    orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) =>
        pattern.cmd === 'order.transfer_batch.receive_one_by_scan',
    );

  it('P1b: boshqa filialdagi buyurtma — paket kuryer filialiga atalgan bo‘lsa, skan qabul qiladi va biriktiradi', async () => {
    const { service, orderClient } = setup({
      // Buyurtma HQ'da (filial 99), kuryer esa filial 10'da. Paket 10'ga
      // jo'natilgan, shuning uchun status hamon ON_THE_ROAD.
      order: {
        branch_id: '99',
        status: Order_status.ON_THE_ROAD,
        courier_id: null,
      },
      branchId: '10',
      receiveByScan: { received: true },
      // Qabuldan keyingi haqiqiy holat: filial kuryerning filiali, status RECEIVED.
      orderAfterReceive: { branch_id: '10', status: Order_status.RECEIVED },
    });

    const result: any = await service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

    // Filial qabuli chaqirildi — kuryer filiali bilan
    expect(scanReceiveCalls(orderClient)).toHaveLength(1);
    expect(scanReceiveCalls(orderClient)[0][1]).toEqual(
      expect.objectContaining({ order_id: '101', courier_branch_id: '10' }),
    );
    // Va shundan keyin kuryerga biriktirildi — ya'ni BITTA skan, ikki bo'g'in
    expect(result.data.order_id).toBe('101');
    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    const assignCall = updateCalls[updateCalls.length - 1][1] as {
      dto: Record<string, unknown>;
    };
    expect(assignCall.dto).toEqual(
      expect.objectContaining({
        courier_id: 'c1',
        status: Order_status.ON_THE_ROAD,
      }),
    );
  });

  it('P1b: paket bu filialga atalmagan (received=false) -> 403, biriktirilmaydi', async () => {
    const { service, orderClient } = setup({
      order: { branch_id: '99', status: Order_status.ON_THE_ROAD },
      branchId: '10',
      receiveByScan: { received: false, reason: 'other_branch' },
    });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      403,
      'Boshqa filial orderi',
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('P1b: tranzit buyurtma (boshqa hudud) -> 400 aniq xabar, kuryerga biriktirilmaydi', async () => {
    const { service, orderClient } = setup({
      order: { branch_id: '99', status: Order_status.ON_THE_ROAD },
      branchId: '10',
      receiveByScan: { received: false, reason: 'transit' },
    });

    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      400,
      'boshqa hudud uchun (tranzit)',
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('P1b: guard xatosi (paket hali jo‘natilmagan) UMUMIY xabar bilan yashirilmaydi', async () => {
    const { service } = setup({
      order: { branch_id: '99', status: Order_status.ON_THE_ROAD },
      branchId: '10',
      receiveByScan: 'throw',
    });

    // Kuryer aynan SABABINI ko'rishi kerak — "boshqa filial orderi" chalg'ituvchi.
    await expectRpcStatus(
      service.scanAssignOrder(
        { id: 'c1', roles: ['courier'] },
        { qr_token: 'ORD-abc123' },
      ),
      400,
      "Paket hali jo'natilmagan",
    );
  });

  it('P1b: filial allaqachon mos — ortiqcha RPC chaqirilmaydi', async () => {
    const { service, orderClient } = setup({
      order: { branch_id: '10', status: Order_status.RECEIVED },
      branchId: '10',
    });

    await service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

    expect(scanReceiveCalls(orderClient)).toHaveLength(0);
  });

  // ===== ITEM 5 — HQ kuryeri faqat HQ qabul qilgan buyurtmani oladi =====

  const updateCallsOf = (orderClient: { send: jest.Mock }) =>
    orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );

  const hqSetup = (options: Parameters<typeof setup>[0] = {}) =>
    setup({ branchId: '1', branchType: 'HQ', hqBranchId: '1', ...options });

  const scanAsC1 = (service: LogisticsServiceService) =>
    service.scanAssignOrder(
      { id: 'c1', roles: ['courier'] },
      { qr_token: 'ORD-abc123' },
    );

  // Rad etilgan buyurtma butunlay tegilmay qolishi kerak.
  const expectUntouched = (ctx: ReturnType<typeof setup>) => {
    expect(updateCallsOf(ctx.orderClient)).toHaveLength(0);
    expect(scanReceiveCalls(ctx.orderClient)).toHaveLength(0);
    expect(ctx.postRepo.create).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    expect(ctx.postUpdateQb.execute).not.toHaveBeenCalled();
    expect(ctx.activityLog.log).not.toHaveBeenCalled();
  };

  const NOT_ACCEPTED_HQ =
    "Buyurtma hali HQ da qabul qilinmagan (holati: yangi) — uni kuryerga berib bo'lmaydi. Avval HQ registratori buyurtmani qabul qilishi kerak.";
  const IN_TRANSIT =
    "Buyurtma yo'lda — filiallar orasidagi pochta yoki paket ichida. U qabul qilinmaguncha HQ kuryeri uni ololmaydi.";
  const IN_BATCH =
    "Buyurtma paketga joylangan — paket jo'natilib qabul qilinmaguncha HQ kuryeri uni ololmaydi.";
  const NOT_AT_HQ =
    'Buyurtma HQ da emas — boshqa filialda turibdi. HQ kuryeri faqat HQ da turgan buyurtmani oladi.';

  describe('HQ kuryeri', () => {
    it('H1: HQ dagi NEW buyurtma — 400, buyurtma NEW bo‘lib qoladi (hech narsa yozilmaydi)', async () => {
      const ctx = hqSetup({
        order: { branch_id: '1', status: Order_status.NEW },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 400, NOT_ACCEPTED_HQ);
      expectUntouched(ctx);
    });

    it('H2: HQ qabul qilgan (RECEIVED, holder HQ) buyurtma — biriktiriladi, RECEIVED oldi-qadami yo‘q', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.RECEIVED,
          holder_type: 'HQ',
          holder_branch_id: null,
          post_id: 'p-region',
        },
        // Hudud NEW pochtasi (courier '0') — kuryerning pochtasi emas.
        linkedPost: {
          id: 'p-region',
          courier_id: '0',
          status: Post_status.NEW,
        },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(false);
      const updates = updateCallsOf(ctx.orderClient);
      expect(updates).toHaveLength(1);
      expect((updates[0][1] as { dto: Record<string, unknown> }).dto).toEqual(
        expect.objectContaining({
          courier_id: 'c1',
          status: Order_status.ON_THE_ROAD,
          post_id: 'p-open',
        }),
      );
      expect(scanReceiveCalls(ctx.orderClient)).toHaveLength(0);
    });

    it('H3: holder BRANCH, holder_branch_id = HQ — biriktiriladi', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.RECEIVED,
          holder_type: 'BRANCH',
          holder_branch_id: '1',
        },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(false);
      expect(updateCallsOf(ctx.orderClient)).toHaveLength(1);
    });

    it('H4: filialga jo‘natilgan (dispatch) buyurtma — 400 yo‘lda, P1b chaqirilmaydi', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '20',
          holder_type: 'BRANCH',
          holder_branch_id: '20',
          status: Order_status.ON_THE_ROAD,
          courier_id: null,
          post_id: 'p-dispatch',
        },
        linkedPost: {
          id: 'p-dispatch',
          courier_id: '0',
          status: Post_status.SENT,
        },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 400, IN_TRANSIT);
      expectUntouched(ctx);
    });

    it('H5: HQ ga kelayotgan paketdagi buyurtma — 400 yo‘lda, P1b HQ kuryeri uchun o‘chiq', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '30',
          status: Order_status.ON_THE_ROAD,
          current_batch_id: 'b1',
        },
        // P1b chaqirilganida qabul qilib yuborardi — chaqirilmasligi shart.
        receiveByScan: { received: true },
        orderAfterReceive: { branch_id: '1', status: Order_status.RECEIVED },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 400, IN_TRANSIT);
      expectUntouched(ctx);
    });

    it('H5b: PENDING paketdagi (hali HQ da, RECEIVED) buyurtma — "paketga joylangan", "yo‘lda" emas', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.RECEIVED,
          current_batch_id: 'b1',
        },
      });

      try {
        await scanAsC1(ctx.service);
        throw new Error('Expected RpcException');
      } catch (error) {
        expect(error).toBeInstanceOf(RpcException);
        const payload = (error as RpcException).getError() as {
          statusCode?: number;
          message?: string;
        };
        expect(payload).toEqual(
          expect.objectContaining({ statusCode: 400, message: IN_BATCH }),
        );
        expect(payload.message).not.toContain("yo'lda");
      }
      expectUntouched(ctx);
    });

    it('H6: boshqa filialda turgan (RECEIVED) buyurtma — 403 HQ da emas', async () => {
      const ctx = hqSetup({
        order: { branch_id: '20', status: Order_status.RECEIVED },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 403, NOT_AT_HQ);
      expectUntouched(ctx);
    });

    it('H7: boshqa kuryer qo‘lidagi buyurtma (holder_courier_id) — 400', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.RECEIVED,
          holder_courier_id: 'other',
        },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 400, 'boshqa courierga');
      expectUntouched(ctx);
    });

    it('H8: sotilgan buyurtma — 400 "Buyurtma sotilgan"', async () => {
      const ctx = hqSetup({
        order: { branch_id: '1', status: Order_status.SOLD },
      });

      await expectRpcStatus(
        scanAsC1(ctx.service),
        400,
        "Buyurtma sotilgan — uni kuryerga berib bo'lmaydi.",
      );
      expectUntouched(ctx);
    });

    it('H9: o‘z ON_THE_ROAD buyurtmasini qayta skanlash — idempotent, yangilanish yo‘q', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.ON_THE_ROAD,
          courier_id: 'c1',
          holder_courier_id: 'c1',
          holder_branch_id: '1',
          post_id: 'p-open',
        },
        linkedPost: {
          id: 'p-open',
          courier_id: 'c1',
          status: Post_status.SENT,
        },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(true);
      expect(updateCallsOf(ctx.orderClient)).toHaveLength(0);
    });

    it('H10: o‘z WAITING_CUSTOMER buyurtmasi — qayta ON_THE_ROAD biriktiriladi', async () => {
      const ctx = hqSetup({
        order: {
          branch_id: '1',
          status: Order_status.WAITING_CUSTOMER,
          courier_id: 'c1',
          holder_courier_id: 'c1',
          holder_branch_id: '1',
        },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(false);
      const updates = updateCallsOf(ctx.orderClient);
      expect(updates).toHaveLength(1);
      expect((updates[0][1] as { dto: Record<string, unknown> }).dto).toEqual(
        expect.objectContaining({
          courier_id: 'c1',
          status: Order_status.ON_THE_ROAD,
        }),
      );
    });

    it('H11: javobda branch qatori yo‘q — HQ find_hq bilan aniqlanadi va NEW rad etiladi', async () => {
      const ctx = setup({
        branchId: '1',
        hqBranchId: '1',
        omitBranch: true,
        order: { branch_id: '1', status: Order_status.NEW },
      });

      await expectRpcStatus(scanAsC1(ctx.service), 400, NOT_ACCEPTED_HQ);
      expect(ctx.branchClient.send).toHaveBeenCalledWith(
        { cmd: 'branch.find_hq' },
        {},
      );
      expectUntouched(ctx);
    });

    it('H12: branch qatori yo‘q, filial HQ emas — odatdagi filial yo‘li bilan biriktiriladi', async () => {
      const ctx = setup({
        branchId: '10',
        hqBranchId: '1',
        omitBranch: true,
        order: { branch_id: '10', status: Order_status.RECEIVED },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(false);
      expect(updateCallsOf(ctx.orderClient)).toHaveLength(1);
    });

    it('H13: branch qatori yo‘q va find_hq yiqildi — fail closed, hech narsa yozilmaydi', async () => {
      const ctx = setup({
        branchId: '1',
        omitBranch: true,
        findHqError: true,
        order: { branch_id: '1', status: Order_status.NEW },
      });

      await expectRpcStatus(
        scanAsC1(ctx.service),
        403,
        "HQ branchini aniqlab bo'lmadi",
      );
      expectUntouched(ctx);
    });
  });

  describe('filial kuryeri (D1 = YO‘Q — xatti-harakat o‘zgarmaydi)', () => {
    it('B1: o‘z filialidagi NEW buyurtma hamon avto-qabul qilinib biriktiriladi', async () => {
      const ctx = setup({
        branchId: '10',
        branchType: 'REGIONAL',
        order: { branch_id: '10', status: Order_status.NEW },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(result.data.idempotent).toBe(false);
      const updates = updateCallsOf(ctx.orderClient);
      expect(updates).toHaveLength(2);
      expect((updates[0][1] as { dto: Record<string, unknown> }).dto).toEqual({
        status: Order_status.RECEIVED,
      });
      expect((updates[1][1] as { dto: Record<string, unknown> }).dto).toEqual(
        expect.objectContaining({
          courier_id: 'c1',
          status: Order_status.ON_THE_ROAD,
        }),
      );
      // Filial kuryeri uchun find_hq zaxirasi kerak emas (branch.type bor).
      expect(ctx.branchClient.send).not.toHaveBeenCalledWith(
        { cmd: 'branch.find_hq' },
        {},
      );
    });

    it('B2: HYBRID filial kuryeri uchun ham P1b ishlaydi', async () => {
      const ctx = setup({
        branchId: '10',
        branchType: 'HYBRID',
        order: {
          branch_id: '99',
          status: Order_status.ON_THE_ROAD,
          courier_id: null,
        },
        receiveByScan: { received: true },
        orderAfterReceive: { branch_id: '10', status: Order_status.RECEIVED },
      });

      const result: any = await scanAsC1(ctx.service);

      expect(scanReceiveCalls(ctx.orderClient)).toHaveLength(1);
      expect(result.data.order_id).toBe('101');
    });
  });
});
