import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';
import { Order_status, Post_status } from '@app/common';

describe('LogisticsServiceService scanAssignOrder', () => {
  function setup(options?: {
    order?: Record<string, unknown>;
    branchId?: string;
    openPost?: Record<string, unknown> | null;
    linkedPost?: Record<string, unknown> | null;
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

    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_qr') {
          return of({ data: order });
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

    const postRepo = {
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

    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
    );

    return { service, orderClient, branchClient, postRepo };
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
    const { service, orderClient, postRepo } = setup();

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
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p-open',
        order_quantity: 3,
      }),
    );
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
});
