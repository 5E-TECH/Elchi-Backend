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
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    const service = new LogisticsServiceService(
      postRepo as any,
      {} as any,
      {} as any,
      orderClient as any,
      {} as any,
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
        status: Post_status.CANCELED,
        order_quantity: 1,
        post_total_price: 1_000_000,
      }),
    );
  });
});
