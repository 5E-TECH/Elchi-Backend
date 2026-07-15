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
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
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

  it('does not fail or duplicate when courier sends an already sent canceled order', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED_SENT,
            canceled_post_id: '55',
            branch_id: '10',
            courier_id: null,
            holder_type: 'BRANCH',
            holder_branch_id: '10',
            holder_courier_id: null,
            total_price: 1_000_000,
            region_id: '1',
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
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => post),
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

    const response = await service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

    expect(response.statusCode).toBe(200);
    expect(response.data).toEqual({
      post_id: '55',
      order_ids: ['101'],
    });
    expect(
      orderClient.send.mock.calls.some(
        ([pattern]) => pattern.cmd === 'order.update',
      ),
    ).toBe(false);
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('repairs an already sent canceled order that is still held by the courier', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED_SENT,
            canceled_post_id: '55',
            branch_id: '10',
            courier_id: '7',
            holder_type: 'COURIER',
            holder_branch_id: null,
            holder_courier_id: '7',
            total_price: 1_000_000,
            region_id: '1',
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
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => post),
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

    const response = await service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

    expect(response.statusCode).toBe(200);
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: {
          canceled_post_id: '55',
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
        },
      }),
    );
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('repairs an already sent canceled order with a missing holder branch', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED_SENT,
            canceled_post_id: '55',
            branch_id: '10',
            courier_id: null,
            holder_type: 'BRANCH',
            holder_branch_id: null,
            holder_courier_id: null,
            total_price: 1_000_000,
            region_id: '1',
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
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => post),
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

    const response = await service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

    expect(response.statusCode).toBe(200);
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: {
          canceled_post_id: '55',
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
        },
      }),
    );
    expect(postRepo.save).not.toHaveBeenCalled();
  });

  it('reassigns already sent canceled orders when their old post is not active', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED_SENT,
            canceled_post_id: 'old-post',
            total_price: 1_000_000,
            region_id: '1',
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const postRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
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

    const response = await service.createCanceledPost(
      { id: '7', roles: ['courier'] },
      { order_ids: ['101'] },
    );

    expect(response.data).toEqual({
      post_id: '55',
      order_ids: ['101'],
    });
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: {
          canceled_post_id: '55',
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
        },
      }),
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
          status: Order_status.CANCELLED,
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

  it('returns unreceived courier canceled orders back to the courier post', async () => {
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
                  region_id: '14',
                },
                {
                  id: '102',
                  status: Order_status.CANCELLED_SENT,
                  canceled_post_id: '55',
                  total_price: 500_000,
                  region_id: '14',
                },
              ],
            },
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const sourcePost = {
      id: '55',
      courier_id: '7',
      branch_id: '10',
      region_id: '14',
      status: Post_status.CANCELED,
      order_quantity: 2,
      post_total_price: 1_500_000,
    };
    const postRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(sourcePost)
        .mockResolvedValueOnce(null),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => ({ ...post, id: post.id ?? '66' })),
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
      { log: jest.fn(), query: jest.fn() } as any,
    );

    const response = await service.receiveCanceledPost(
      { id: '8', roles: ['manager'], branch_id: '10' },
      '55',
      { order_ids: ['101'] },
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        order_ids: ['101'],
        remaining_order_ids: ['102'],
        requeued_post_ids: ['66'],
      }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '102',
        dto: {
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: '7',
          assigned_at: null,
          canceled_post_id: '66',
        },
      }),
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '55',
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
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
        },
        requester: {
          id: '8',
          roles: ['manager'],
          note: 'Branch canceled post sent to HQ',
        },
      },
    );
  });

  it('uses current holder branch when manager sends a received courier cancellation to HQ', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED,
            branch_id: '1',
            holder_type: 'BRANCH',
            holder_branch_id: '10',
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

    const response = await service.createCanceledPost(
      { id: '8', roles: ['manager'], branch_id: '10' },
      { order_ids: ['101'] },
    );

    expect(response.statusCode).toBe(200);
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '101',
        dto: {
          canceled_post_id: '77',
          status: Order_status.CANCELLED_SENT,
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
        },
      }),
    );
  });

  it('sends a courier cancellation already received by the manager to HQ', async () => {
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({
            id: '101',
            status: Order_status.CANCELLED,
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
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
        },
      }),
    );
  });

  it('keeps canceled orders open when HQ receives the manager post', async () => {
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
          status: Order_status.CANCELLED,
          branch_id: '1',
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        requester: {
          id: '1',
          roles: ['admin'],
          note: 'Canceled order received by HQ and held for market handover',
        },
      },
    );
  });

  it('returns unreceived HQ canceled orders back to the manager branch post', async () => {
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
                  region_id: '14',
                  branch_id: '10',
                  holder_type: 'BRANCH',
                  holder_branch_id: '10',
                },
                {
                  id: '102',
                  status: Order_status.CANCELLED_SENT,
                  canceled_post_id: '77',
                  total_price: 500_000,
                  region_id: '14',
                  branch_id: '10',
                  holder_type: 'BRANCH',
                  holder_branch_id: '10',
                },
              ],
            },
          });
        }
        return of({ statusCode: 200 });
      }),
    };
    const sourcePost = {
      id: '77',
      courier_id: '8',
      branch_id: '1',
      region_id: '14',
      status: Post_status.CANCELED,
      order_quantity: 2,
      post_total_price: 1_500_000,
    };
    const branchClient = {
      send: jest.fn(() => of({ data: { id: '1', type: 'HQ' } })),
    };
    const postRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(sourcePost)
        .mockResolvedValueOnce(null),
      create: jest.fn((payload) => payload),
      save: jest.fn(async (post) => ({ ...post, id: post.id ?? '88' })),
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

    const response = await service.receiveCanceledPost(
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
    expect(postRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        courier_id: '8',
        branch_id: '10',
        region_id: '14',
        status: Post_status.CANCELED,
      }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.update' },
      expect.objectContaining({
        id: '102',
        dto: {
          status: Order_status.CANCELLED_SENT,
          branch_id: '10',
          courier_id: null,
          assigned_at: null,
          canceled_post_id: '88',
        },
      }),
    );
    expect(postRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '77',
        status: Post_status.CANCELED_RECEIVED,
        order_quantity: 0,
        post_total_price: 0,
      }),
    );
  });
});
