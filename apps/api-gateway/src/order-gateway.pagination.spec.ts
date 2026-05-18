import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController pagination', () => {
  const makeController = () => {
    const orderClient = { send: jest.fn() };
    const identityClient = { send: jest.fn() };
    const logisticsClient = { send: jest.fn() };
    const branchClient = { send: jest.fn() };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );
    return { controller, orderClient, branchClient };
  };

  // findAll() 14 ta pozitsion argument oladi: 11 ta filtr query + page + limit + req.
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
      of({ data: [{ id: '1' }], total: 51, page: 1, limit: 25 }),
    );

    const res: any = await callFindAll(controller, '1', '25', {
      user: { sub: '1', username: 'u', roles: ['admin'] },
    });

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.limit).toBe(25);
    expect(res.total_pages).toBe(3);
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
});
