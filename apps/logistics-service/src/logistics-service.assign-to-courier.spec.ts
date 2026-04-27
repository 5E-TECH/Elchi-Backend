import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';
import { Order_status, Post_status } from '@app/common';

describe('LogisticsServiceService assignOrdersToCourier', () => {
  function setup(options?: {
    orders?: Array<Record<string, unknown>>;
    managerBranchId?: string;
    managerRole?: string;
    branchUsers?: Array<Record<string, unknown>>;
    openPost?: Record<string, unknown> | null;
  }) {
    const ordersMap = new Map<string, any>();
    const baseOrders =
      options?.orders ??
      [
        {
          id: '101',
          branch_id: '10',
          status: Order_status.RECEIVED,
          courier_id: null,
          post_id: null,
          total_price: 100000,
          region_id: '1',
        },
        {
          id: '102',
          branch_id: '10',
          status: Order_status.NEW,
          courier_id: null,
          post_id: null,
          total_price: 150000,
          region_id: '1',
        },
      ];

    for (const order of baseOrders) {
      ordersMap.set(String(order.id), { ...order });
    }

    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        if (pattern.cmd === 'order.find_by_id') {
          const row = ordersMap.get(String(payload.id));
          if (!row) {
            throw new Error('not found');
          }
          return of(row);
        }
        if (pattern.cmd === 'order.update') {
          const row = ordersMap.get(String(payload.id));
          if (!row) {
            throw new Error('not found');
          }
          Object.assign(row, payload.dto ?? {});
          return of({ ok: true });
        }
        return of({});
      }),
    };

    const branchClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        if (pattern.cmd === 'branch.user.find_by_user') {
          return of({
            data: {
              branch_id: options?.managerBranchId ?? '10',
              role: options?.managerRole ?? 'MANAGER',
              user_id: payload.user_id,
            },
          });
        }
        if (pattern.cmd === 'branch.user.find_by_branch') {
          return of({
            data:
              options?.branchUsers ??
              [
                { user_id: '44', role: 'COURIER' },
                { user_id: '77', role: 'MANAGER' },
              ],
          });
        }
        return of({ data: null });
      }),
    };

    const postRepo = {
      findOne: jest.fn((query: any) => {
        if (query?.where?.status === Post_status.SENT) {
          return Promise.resolve(
            options?.openPost === undefined
              ? {
                  id: 'p-open',
                  courier_id: '44',
                  status: Post_status.SENT,
                  order_quantity: 3,
                  post_total_price: 300000,
                }
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
      remove: jest.fn(async () => undefined),
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

    return { service, orderClient, branchClient, postRepo, ordersMap };
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

  it('assigns multiple orders to one courier and reuses existing open post', async () => {
    const { service, orderClient, postRepo } = setup();

    const result: any = await service.assignOrdersToCourier(
      { id: '77', roles: ['branch'] },
      { order_ids: ['101', '102'], courier_id: '44' },
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(3);
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p-open',
        order_quantity: 5,
      }),
    );
    expect(result.data.assigned_count).toBe(2);
    expect(result.data.post_id).toBe('p-open');
  });

  it('creates new post when courier has no open SENT post', async () => {
    const { service, postRepo } = setup({ openPost: null });

    const result: any = await service.assignOrdersToCourier(
      { id: '77', roles: ['branch'] },
      { order_ids: ['101', '102'], courier_id: '44' },
    );

    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '44',
        status: Post_status.SENT,
      }),
    );
    expect(result.data.post_created).toBe(true);
    expect(result.data.post_id).toBe('p-new');
  });

  it('fails when orders are from mixed branches (no order update)', async () => {
    const { service, orderClient } = setup({
      orders: [
        {
          id: '101',
          branch_id: '10',
          status: Order_status.RECEIVED,
          courier_id: null,
          post_id: null,
          total_price: 100000,
          region_id: '1',
        },
        {
          id: '102',
          branch_id: '11',
          status: Order_status.NEW,
          courier_id: null,
          post_id: null,
          total_price: 150000,
          region_id: '1',
        },
      ],
    });

    await expectRpcStatus(
      service.assignOrdersToCourier(
        { id: '77', roles: ['branch'] },
        { order_ids: ['101', '102'], courier_id: '44' },
      ),
      400,
      'aralash filial',
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('fails when courier is not COURIER in manager branch', async () => {
    const { service, orderClient } = setup({
      branchUsers: [{ user_id: '44', role: 'OPERATOR' }],
    });

    await expectRpcStatus(
      service.assignOrdersToCourier(
        { id: '77', roles: ['branch'] },
        { order_ids: ['101', '102'], courier_id: '44' },
      ),
      400,
      'COURIER sifatida biriktirilmagan',
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('fails when any order already assigned to another courier', async () => {
    const { service, orderClient } = setup({
      orders: [
        {
          id: '101',
          branch_id: '10',
          status: Order_status.RECEIVED,
          courier_id: null,
          post_id: null,
          total_price: 100000,
          region_id: '1',
        },
        {
          id: '102',
          branch_id: '10',
          status: Order_status.RECEIVED,
          courier_id: '99',
          post_id: 'p-99',
          total_price: 150000,
          region_id: '1',
        },
      ],
    });

    await expectRpcStatus(
      service.assignOrdersToCourier(
        { id: '77', roles: ['branch'] },
        { order_ids: ['101', '102'], courier_id: '44' },
      ),
      400,
      'boshqa courierga biriktirilgan',
    );

    const updateCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
    );
    expect(updateCalls).toHaveLength(0);
  });
});
