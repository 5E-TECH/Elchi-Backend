import { firstValueFrom, of } from 'rxjs';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * YfrqN70i — GET /post va GET /post/courier/old-posts filtrlari logistics
 * payloadiga yetadi. Avval gateway faqat page/limit/status/branch_id ni
 * o'qirdi — region_id/courier_id/startDate/endDate jimgina tashlanardi va
 * mavjud bo'lmagan viloyat ham 59 qator qaytarardi.
 */
describe("YfrqN70i — pochta ro'yxati filtrlari gatewaydan o'tadi", () => {
  const setup = () => {
    const logisticsClient = {
      send: jest.fn(() => of({ statusCode: 200, data: { data: [] } })),
    };
    const controller = new LogisticsGatewayController(
      logisticsClient as never,
      { send: jest.fn() } as never,
    );
    return { controller, logisticsClient };
  };

  it('GET /post — region_id, courier_id, startDate, endDate, has_orders uzatiladi', async () => {
    const { controller, logisticsClient } = setup();
    await firstValueFrom(
      controller.getAllPosts(
        '2',
        '20',
        'Received',
        undefined,
        { user: { sub: '7', roles: ['superadmin'] } },
        ' 3 ',
        '119',
        '2026-08-01',
        '2026-08-31',
        'true',
      ),
    );
    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.find_all' },
      {
        query: {
          page: 2,
          limit: 20,
          status: 'received',
          branch_id: undefined,
          region_id: '3',
          courier_id: '119',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
          has_orders: 'true',
        },
        requester: { id: '7', roles: ['superadmin'] },
      },
    );
  });

  it("GET /post — filtrsiz so'rov avvalgidek (yangi kalitlar undefined)", async () => {
    const { controller, logisticsClient } = setup();
    await firstValueFrom(
      controller.getAllPosts(undefined, undefined, undefined, undefined, {
        user: { sub: '7', roles: ['admin'] },
      }),
    );
    const payload = (logisticsClient.send.mock.calls[0] as unknown[])[1] as {
      query: Record<string, unknown>;
    };
    expect(payload.query).toMatchObject({
      page: 1,
      limit: 8,
      region_id: undefined,
      courier_id: undefined,
      startDate: undefined,
      endDate: undefined,
      has_orders: undefined,
    });
  });

  it('GET /post/courier/old-posts — region_id/status/sana uzatiladi, courier_id — JWT', async () => {
    const { controller, logisticsClient } = setup();
    await firstValueFrom(
      controller.getOldPostsForCourier(
        '1',
        '50',
        { user: { sub: '119', roles: ['courier'] } },
        '3',
        'CANCELED',
        '2026-08-01',
        '2026-08-31',
        undefined,
      ),
    );
    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.old_for_courier' },
      {
        page: 1,
        limit: 50,
        region_id: '3',
        status: 'canceled',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        has_orders: undefined,
        requester: { id: '119', roles: ['courier'] },
      },
    );
  });
});
