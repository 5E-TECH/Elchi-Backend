import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController pagination', () => {
  const makeController = () => {
    const orderClient = { send: jest.fn() };
    const identityClient = { send: jest.fn() };
    const logisticsClient = {
      send: jest.fn().mockReturnValue(
        of({ data: { data: [], total: 0, page: 1, totalPages: 1, limit: 100 } }),
      ),
    };
    const branchClient = { send: jest.fn() };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );
    return { controller, orderClient, logisticsClient, branchClient };
  };

  // Test uchun faqat page/limit/req kerak, qolgan filtrlar undefined.
  const callFindAll = (
    controller: OrderGatewayController,
    page: string | undefined,
    limit: string | undefined,
    req: unknown,
  ) =>
    controller.findAll(
      undefined, // market_id
      undefined, // customer_id
      undefined, // status
      undefined, // search
      undefined, // start_day
      undefined, // end_day
      undefined, // courier
      undefined, // region_id
      undefined, // district_id
      undefined, // branch_id
      undefined, // courier_ids
      undefined, // fetch_all
      undefined, // source
      page,
      limit,
      req as any,
    );

  it('default limit=10 and page=1 for list endpoint', async () => {
    const { controller, orderClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10 }),
    );

    const res: any = await callFindAll(controller, undefined, undefined, {
      user: { sub: '1', username: 'u', roles: ['admin'] },
    });

    expect(orderClient.send).toHaveBeenCalled();
    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.page).toBe(1);
    expect(payload.query.limit).toBe(10);
    expect(res.total_pages).toBe(0);
  });

  it('allowed limits are accepted (25/50/100)', async () => {
    const { controller, orderClient } = makeController();
    orderClient.send.mockReturnValue(
      of({
        data: [{ id: '1', status: 'cancelled (sent)' }],
        total: 51,
        page: 1,
        limit: 25,
      }),
    );

    const res: any = await callFindAll(controller, '1', '25', {
      user: { sub: '1', username: 'u', roles: ['admin'] },
    });

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.limit).toBe(25);
    expect(res.total_pages).toBe(3);
    expect(res.data[0].status).toBe('cancelled');
    expect(res.data[0].transport_status).toBeUndefined();
  });

  it('invalid limit rejected with 400', async () => {
    const { controller } = makeController();
    // findAll — async metod: noto'g'ri limit rejected promise qaytaradi,
    // sinxron throw emas. Shuning uchun .rejects bilan tekshiriladi.
    await expect(
      callFindAll(controller, '1', '15', {
        user: { sub: '1', username: 'u', roles: ['admin'] },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('manager cancelled tab returns only received branch cancellations', async () => {
    const { controller, orderClient, branchClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10 }),
    );

    await controller.findAll(
      undefined,
      undefined,
      'cancelled,cancelled (sent)',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      {
        user: {
          sub: '55',
          username: 'manager',
          roles: ['manager'],
          branch_id: '16',
        },
      },
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query).toEqual(
      expect.objectContaining({
        status: ['cancelled'],
        branch_id: '16',
        holder_type: 'BRANCH',
        canceled_post_unassigned: true,
      }),
    );
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('HQ cancelled tab excludes cancellations still in transit', async () => {
    const { controller, orderClient, branchClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10 }),
    );

    await controller.findAll(
      undefined,
      undefined,
      'cancelled,cancelled (sent)',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      {
        user: {
          sub: '1',
          username: 'admin',
          roles: ['admin'],
        },
      },
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query).toEqual(
      expect.objectContaining({
        status: ['cancelled'],
        holder_type: 'HQ',
        canceled_post_unassigned: true,
      }),
    );
    expect(payload.query.branch_id).toBeUndefined();
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('courier cancelled tab excludes orders in active canceled posts', async () => {
    const { controller, orderClient, logisticsClient, branchClient } =
      makeController();
    logisticsClient.send
      .mockReturnValueOnce(
        of({
          data: {
            data: [{ id: 'post-1' }],
            totalPages: 2,
            page: 1,
            limit: 100,
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            data: [{ id: 'old-post' }],
            totalPages: 2,
            page: 2,
            limit: 100,
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: [{ id: 'active-canceled-post' }],
        }),
      );
    orderClient.send.mockImplementation((_pattern, payload) => {
      if (payload?.query?.post_ids) {
        return of({
          data: [
            { id: '84', post_id: 'old-post', status: 'cancelled' },
            {
              id: '99',
              post_id: 'old-post',
              status: 'cancelled (sent)',
              canceled_post_id: 'active-canceled-post',
            },
          ],
          total: 2,
        });
      }
      return of({
        data: [{ id: '77', status: 'cancelled (sent)' }],
        total: 1,
      });
    });

    const response: any = await controller.findAll(
      undefined,
      undefined,
      'cancelled,cancelled (sent)',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      {
        user: {
          sub: '77',
          username: 'courier',
          roles: ['courier', 'branch'],
        },
      },
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.status).toEqual(['cancelled', 'cancelled (sent)']);
    expect(payload.query.courier_ids).toEqual(['77']);
    expect(payload.query.include_courier_history).toBe(true);
    expect(payload.query.canceled_post_unassigned).toBeUndefined();
    expect(payload.query.branch_id).toBeUndefined();
    expect(payload.query.holder_type).toBeUndefined();
    expect(orderClient.send.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.anything(),
          expect.objectContaining({
            query: expect.objectContaining({
              status: ['cancelled', 'cancelled (sent)'],
              post_ids: ['post-1', 'old-post'],
            }),
          }),
        ]),
      ]),
    );
    expect(response.data).toEqual([
      { id: '77', status: 'cancelled (sent)' },
      { id: '84', post_id: 'old-post', status: 'cancelled' },
    ]);
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('courier cancelled tab still works when logistics post history is unavailable', async () => {
    const { controller, orderClient, logisticsClient } = makeController();
    logisticsClient.send.mockReturnValue(
      throwError(() => new Error('logistics unavailable')),
    );
    orderClient.send.mockReturnValue(
      of({ data: [{ id: '84', status: 'cancelled' }], total: 1 }),
    );

    const response: any = await controller.findAll(
      undefined,
      undefined,
      'cancelled,cancelled (sent)',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      {
        user: {
          sub: '77',
          username: 'courier',
          roles: ['courier', 'branch'],
        },
      },
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query).toEqual(
      expect.objectContaining({
        status: ['cancelled', 'cancelled (sent)'],
        courier_ids: ['77'],
        include_courier_history: true,
      }),
    );
    expect(response.data).toEqual([{ id: '84', status: 'cancelled' }]);
  });

  it('legacy courier cancelled list includes exact cancelled orders from every post page', async () => {
    const { controller, orderClient, logisticsClient } = makeController();
    logisticsClient.send
      .mockReturnValueOnce(
        of({ data: { data: [{ id: 'new-post' }], totalPages: 2 } }),
      )
      .mockReturnValueOnce(
        of({ data: { data: [{ id: 'old-post' }], totalPages: 2 } }),
      )
      .mockReturnValueOnce(
        of({ data: [{ id: 'active-canceled-post' }] }),
      );
    orderClient.send.mockImplementation((_pattern, payload) => {
      if (payload?.query?.post_ids) {
        return of({
          data: [{ id: '84', post_id: 'old-post', status: 'cancelled' }],
          total: 1,
        });
      }
      return of({ data: [], total: 0 });
    });

    const response: any = await controller.findCourierOrdersLegacy(
      'cancelled',
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      {
        user: {
          sub: '77',
          username: 'courier',
          roles: ['courier'],
        },
      },
    );

    const orderQueries = orderClient.send.mock.calls
      .map((call) => call[1]?.query)
      .filter(Boolean);
    expect(orderQueries).toContainEqual(
      expect.objectContaining({
        status: ['cancelled', 'cancelled (sent)'],
        courier_ids: ['77'],
        include_courier_history: true,
      }),
    );
    expect(orderQueries).toContainEqual(
      expect.objectContaining({
        status: ['cancelled', 'cancelled (sent)'],
        post_ids: ['new-post', 'old-post'],
      }),
    );
    expect(logisticsClient.send).toHaveBeenCalledTimes(3);
    expect(response.data.data).toEqual([
      expect.objectContaining({ id: '84', status: 'cancelled' }),
    ]);
  });
});
