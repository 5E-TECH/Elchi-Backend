import { of } from 'rxjs';
import { Order_status, Post_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

describe('LogisticsServiceService createCanceledPost', () => {
  it('marks canceled orders as sent with the courier requester', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED,
            total_price: 1_000_000,
            region_id: '1',
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => ({ ...post, id: post.id ?? '55' })),
    };
    const branchClient = {
      send: jest.fn(() =>
        of({
          data: {
            branch_id: '10',
            role: 'COURIER',
          },
        }),
      ),
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
      {} as any,
      activityLog as any,
    );

    await service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      {
        id: '101',
        dto: {
          canceled_post_id: '55',
          status: Order_status.CANCELLED_SENT,
        },
        requester: {
          id: '7',
          roles: ['courier'],
          note: 'Canceled post created',
        },
      },
    );
    expect(postRepo.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branch_id: '10',
        status: Post_status.CANCELED,
        order_quantity: 1,
        post_total_price: 1_000_000,
      }),
    );
  });

  it('keeps received branch orders sent until HQ receives them', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_all') {
          return of({
            data: {
              data: [
                {
                  id: '101',
                  status: Order_status.CANCELLED_SENT,
                  canceled_post_id: '55',
                  total_price: 1_000_000,
                },
              ],
            },
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '55',
        courier_id: '7',
        branch_id: '10',
        status: Post_status.CANCELED,
        order_quantity: 1,
        post_total_price: 1_000_000,
      }),
      save: jest.fn(async (post) => post),
    };
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1', type: 'HQ' } })),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      {} as any,
      activityLog as any,
    );

    await service.receiveCanceledPost(
      { id: '8', roles: ['manager'], branch_id: '10' },
      '55',
      { order_ids: ['101'] },
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      {
        id: '101',
        dto: {
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        requester: {
          id: '8',
          roles: ['manager'],
          note: 'Canceled order received by branch manager',
        },
      },
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Post_status.CANCELED_RECEIVED,
        order_quantity: 0,
        post_total_price: 0,
      }),
    );
  });

  it('creates an HQ canceled post from the manager branch', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED,
            branch_id: '10',
            total_price: 1_000_000,
            region_id: '1',
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1', type: 'HQ' } })),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => ({ ...post, id: post.id ?? '77' })),
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
      {} as any,
      activityLog as any,
    );

    const response = await service.createCanceledPost(
      { id: '8', roles: ['manager'], branch_id: '10' },
      { order_ids: ['101'] },
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        post_id: '77',
        source_branch_id: '10',
        destination_branch_id: '1',
      }),
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        branch_id: '1',
        status: Post_status.CANCELED,
      }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      {
        id: '101',
        dto: {
          canceled_post_id: '77',
          status: Order_status.CANCELLED_SENT,
        },
        requester: {
          id: '8',
          roles: ['manager'],
          note: 'Branch canceled post sent to HQ',
        },
      },
    );
  });

  it('sends a courier cancellation already received by the manager to HQ', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED_SENT,
            branch_id: '10',
            canceled_post_id: null,
            total_price: 1_000_000,
            region_id: '1',
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1', type: 'HQ' } })),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => ({ ...post, id: post.id ?? '77' })),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      {} as any,
      { log: jest.fn(), query: jest.fn() } as any,
    );

    await service.createCanceledPost(
      { id: '8', roles: ['manager'], branch_id: '10' },
      { order_ids: ['101'] },
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: {
          canceled_post_id: '77',
          status: Order_status.CANCELLED_SENT,
        },
      }),
    );
  });

  it('closes canceled orders when HQ receives the manager post', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_all') {
          return of({
            data: {
              data: [
                {
                  id: '101',
                  status: Order_status.CANCELLED_SENT,
                  canceled_post_id: '77',
                  total_price: 1_000_000,
                },
              ],
            },
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1', type: 'HQ' } })),
    };
    const postRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '77',
        courier_id: '8',
        branch_id: '1',
        status: Post_status.CANCELED,
        order_quantity: 1,
        post_total_price: 1_000_000,
      }),
      save: jest.fn(async (post) => post),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      branchClient as any,
      {} as any,
      {} as any,
      { log: jest.fn(), query: jest.fn() } as any,
    );

    await service.receiveCanceledPost({ id: '1', roles: ['admin'] }, '77', {
      order_ids: ['101'],
    });

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      {
        id: '101',
        dto: {
          status: Order_status.CLOSED,
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        requester: {
          id: '1',
          roles: ['admin'],
          note: 'Canceled order received by HQ',
        },
      },
    );
  });
});
