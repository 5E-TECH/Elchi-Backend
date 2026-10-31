import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController pagination', () => {
  const makeController = () => {
    const orderClient = { send: jest.fn() };
    const identityClient = { send: jest.fn() };
    const logisticsClient = {
      send: jest.fn().mockReturnValue(
        of({
          data: { data: [], total: 0, page: 1, totalPages: 1, limit: 100 },
        }),
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
    expect(res.totalPages).toBe(3);
    expect(res.from).toBe(1);
    expect(res.to).toBe(25);
    expect(res.has_next).toBe(true);
    expect(res.has_prev).toBe(false);
    expect(res.data[0].status).toBe('cancelled');
    expect(res.data[0].transport_status).toBe('cancelled (sent)');
  });

  it('external orders: fetch_all=true forwarded to order service', async () => {
    const { controller, orderClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 100 }),
    );

    // Andijon E2E: kiruvchi posilka ekrani butun ro'yxatni fetch_all bilan
    // so'raydi (limit=200 emas). Gateway buni order-service'ga uzatishi shart.
    await (controller as any).findAllExternal(
      '121', // market_id
      'new', // status
      undefined, // date
      undefined, // start_day
      undefined, // end_day
      '1', // page
      '100', // limit
      'true', // fetch_all
      { user: { sub: '9', username: 'u', roles: ['admin'] } }, // req
    );

    expect(orderClient.send).toHaveBeenCalled();
    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.fetch_all).toBe(true);
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

  it('manager cancelled tab returns only branch-held unsent cancelled orders', async () => {
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

  const adminReq = {
    user: { sub: '1', username: 'admin', roles: ['admin'] },
  };
  const findAllAsAdmin = (
    controller: any,
    status: string,
    cancelledInventory?: string,
  ) =>
    controller.findAll(
      undefined,
      undefined,
      status,
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
      adminReq,
      undefined,
      undefined,
      undefined,
      undefined,
      cancelledInventory,
    );

  it('HQ cancelled INVENTORY (cancelled_inventory=true) excludes cancellations still in transit', async () => {
    const { controller, orderClient, branchClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10 }),
    );

    await findAllAsAdmin(controller, 'cancelled,cancelled (sent)', 'true');

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

  it.each([
    ['cancelled', ['cancelled']],
    ['cancelled (sent)', ['cancelled (sent)']],
    ['cancelled,sold', ['cancelled', 'sold']],
  ])(
    '⭐ onzwA7CQ: admin oddiy ?status=%s — yashirin holder/post sharti YO`Q, status o`zgarmaydi',
    async (status, expected) => {
      const { controller, orderClient } = makeController();
      orderClient.send.mockReturnValue(
        of({ data: [], total: 0, page: 1, limit: 10 }),
      );

      await findAllAsAdmin(controller, status);

      const { query } = orderClient.send.mock.calls[0][1];
      expect(query.status).toEqual(expected);
      expect(query.holder_type).toBeUndefined();
      expect(query.canceled_post_unassigned).toBeUndefined();
    },
  );

  it('courier cancelled tab returns only unsent cancelled orders for the courier', async () => {
    const { controller, orderClient, logisticsClient, branchClient } =
      makeController();
    orderClient.send.mockReturnValue(
      of({
        data: [
          { id: '77', status: 'cancelled' },
          {
            id: '84',
            status: 'cancelled',
            holder_type: 'COURIER',
            holder_courier_id: '77',
          },
          {
            id: 'partial-child',
            status: 'cancelled',
            post_id: 'old-post',
            courier_id: '77',
            holder_type: 'BRANCH',
            parent_order_id: '75',
            canceled_post_id: null,
          },
        ],
        total: 3,
      }),
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
    expect(payload.query.status).toEqual(['cancelled']);
    expect(payload.query.courier_ids).toEqual(['77']);
    expect(payload.query.holder_courier_ids).toEqual(['77']);
    expect(payload.query.courier_scope).toBe('any');
    expect(payload.query.courier_post_history).toBe(true);
    expect(payload.query.courier_cancelled_tab).toBe(true);
    expect(payload.query.page).toBe(1);
    expect(payload.query.limit).toBe(10);
    expect(payload.query.include_courier_history).toBeUndefined();
    expect(payload.query.canceled_post_unassigned).toBeUndefined();
    expect(payload.query.branch_id).toBeUndefined();
    expect(payload.query.holder_type).toBeUndefined();
    expect(orderClient.send).toHaveBeenCalledTimes(1);
    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(response.data).toEqual([
      { id: '77', status: 'cancelled' },
      {
        id: '84',
        status: 'cancelled',
        holder_type: 'COURIER',
        holder_courier_id: '77',
      },
      {
        id: 'partial-child',
        status: 'cancelled',
        post_id: 'old-post',
        courier_id: '77',
        holder_type: 'BRANCH',
        parent_order_id: null,
        partial_parent_order_id: '75',
        parentOrderId: null,
        partialParentOrderId: '75',
        canceled_post_id: null,
      },
    ]);
    expect(response.total).toBe(3);
    expect(response.page).toBe(1);
    expect(response.limit).toBe(10);
    expect(response.total_pages).toBe(1);
    expect(response.from).toBe(1);
    expect(response.to).toBe(3);
    expect(response.has_next).toBe(false);
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('courier cancelled tab requests page 2 without re-fetching page 1', async () => {
    const { controller, orderClient, logisticsClient } = makeController();
    logisticsClient.send.mockReturnValue(
      throwError(() => new Error('logistics unavailable')),
    );
    orderClient.send.mockReturnValue(
      of({ data: [{ id: '84', status: 'cancelled' }], total: 11 }),
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
      '2',
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
        status: ['cancelled'],
        courier_ids: ['77'],
        page: 2,
        limit: 10,
      }),
    );
    expect(response.data).toEqual([{ id: '84', status: 'cancelled' }]);
    expect(response.total).toBe(11);
    expect(response.has_prev).toBe(true);
    expect(orderClient.send).toHaveBeenCalledTimes(1);
    expect(logisticsClient.send).not.toHaveBeenCalled();
  });

  it('legacy courier cancelled list includes current courier-held cancelled orders only', async () => {
    const { controller, orderClient, logisticsClient } = makeController();
    orderClient.send.mockReturnValue(
      of({
        data: [
          {
            id: '84',
            status: 'cancelled',
            holder_type: 'COURIER',
            holder_courier_id: '77',
          },
          {
            id: 'partial-child',
            status: 'cancelled',
            post_id: 'old-post',
            courier_id: '77',
            holder_type: 'BRANCH',
            parent_order_id: '75',
            canceled_post_id: null,
          },
        ],
        total: 2,
      }),
    );

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

    expect(orderClient.send).toHaveBeenCalledTimes(1);
    expect(orderClient.send.mock.calls[0][1].query).toEqual(
      expect.objectContaining({
        status: ['cancelled'],
        courier_ids: ['77'],
        holder_courier_ids: ['77'],
        courier_scope: 'any',
        page: 1,
        limit: 10,
      }),
    );
    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(response.data.data).toEqual([
      expect.objectContaining({
        id: '84',
        status: 'cancelled',
        holder_type: 'COURIER',
        holder_courier_id: '77',
      }),
      expect.objectContaining({ id: 'partial-child' }),
    ]);
  });

  describe('yKtzKXeM: kuryer ro`yxati `where_deliver` filtri', () => {
    const courier = { user: { sub: '77', username: 'c', roles: ['courier'] } };
    const list = (controller: any, whereDeliver?: string) =>
      controller.findCourierOrdersLegacy(
        'cancelled',
        undefined,
        undefined,
        undefined,
        '1',
        '10',
        courier,
        whereDeliver,
      );

    it('filtr order-service so`roviga uzatiladi, katta harf ham', async () => {
      const { controller, orderClient } = makeController();
      orderClient.send.mockReturnValue(of({ data: [], total: 0 }));

      await list(controller, ' ADDRESS ');

      expect(orderClient.send.mock.calls[0][1].query).toEqual(
        expect.objectContaining({ where_deliver: 'address' }),
      );
    });

    it('berilmasa hammasi: filtr yo`q', async () => {
      const { controller, orderClient } = makeController();
      orderClient.send.mockReturnValue(of({ data: [], total: 0 }));

      await list(controller);

      expect(
        orderClient.send.mock.calls[0][1].query.where_deliver,
      ).toBeUndefined();
    });

    it('noma`lum qiymat: 400, so`rov ketmaydi', async () => {
      const { controller, orderClient } = makeController();

      await expect(list(controller, 'door')).rejects.toThrow('where_deliver');
      expect(orderClient.send).not.toHaveBeenCalled();
    });
  });
});
