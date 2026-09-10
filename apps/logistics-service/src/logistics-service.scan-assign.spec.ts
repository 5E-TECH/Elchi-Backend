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
                  message: "Paket hali jo'natilmagan — posilka filialga yetib kelmagan",
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

    const branchClient = {
      send: jest.fn(() => of({ data: { branch_id: options?.branchId ?? '10' } })),
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
      findOne: jest.fn((query: { where?: { id?: string; courier_id?: string; status?: Post_status } }) => {
        if (query?.where?.id && options?.linkedPost !== undefined) {
          return Promise.resolve(options.linkedPost);
        }
        if (query?.where?.status === Post_status.SENT) {
          return Promise.resolve(
            options?.openPost === undefined
              ? { id: 'p-open', courier_id: 'c1', status: Post_status.SENT, order_quantity: 2, post_total_price: 200000 }
              : options.openPost,
          );
        }
        return Promise.resolve(null);
      }),
      create: jest.fn((payload: Record<string, unknown>) => payload),
      save: jest.fn(async (entity: Record<string, unknown>) => ({
        ...entity,
        id: String(entity.id ?? 'p-new'),
      })),
    };

    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ items: [], meta: { page: 1, limit: 50, total: 0, totalPages: 1 } }),
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

    return { service, orderClient, branchClient, postRepo, postUpdateQb, activityLog };
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
      const payload = (error as RpcException).getError() as { statusCode?: number; message?: string };
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
    expect(postUpdateQb.where).toHaveBeenCalledWith('id = :id', { id: 'p-open' });
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
      service.scanAssignOrder({ id: 'c1', roles: ['courier'] }, { qr_token: 'ORD-abc123' }),
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
      service.scanAssignOrder({ id: 'c1', roles: ['courier'] }, { qr_token: 'ORD-abc123' }),
      400,
      "Order holati noto'g'ri",
    );
  });

  it('returns error when order is already assigned to another courier', async () => {
    const { service } = setup({
      order: { courier_id: 'other-courier' },
    });

    await expectRpcStatus(
      service.scanAssignOrder({ id: 'c1', roles: ['courier'] }, { qr_token: 'ORD-abc123' }),
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
});
