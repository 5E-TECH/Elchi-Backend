import 'reflect-metadata';
import { firstValueFrom, of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { POST_SCAN_ROLES } from './auth/post-scan-access';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * X4RzXk1H + dwJX3NjT — `GET /post/scan/:id`:
 *   - logistics `find_by_scan` ga requester (id, roles, branch_id) uzatiladi —
 *     filial/kuryer doirasi o'sha yerda (ilgari faqat `{ id }` ketardi);
 *   - `@Roles` va `/scan/:token` dagi `POST_SCAN_ROLES` bir xil;
 *   - javob rol proyeksiyasidan o'tadi (kuryerga market tarifi chiqmaydi).
 */
describe('X4RzXk1H — GET /post/scan/:id', () => {
  function setup(response: unknown) {
    const logisticsClient = { send: jest.fn(() => of(response)) };
    const identityClient = { send: jest.fn() };
    const controller = new LogisticsGatewayController(
      logisticsClient as never,
      identityClient as never,
    );
    return { controller, logisticsClient };
  }

  it('⭐ requester (id, roles, branch_id) logistics`ga uzatiladi', async () => {
    const { controller, logisticsClient } = setup({
      statusCode: 200,
      data: { id: '91' },
    });

    const res = await firstValueFrom(
      controller.getPostByScan('POST-abc-1', {
        user: { sub: '25', roles: ['manager'], branch_id: '3' },
      }),
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.post.find_by_scan' },
      {
        id: 'POST-abc-1',
        requester: { id: '25', roles: ['manager'], branch_id: '3' },
      },
    );
    expect(res).toEqual({ statusCode: 200, data: { id: '91' } });
  });

  it('`@Roles` — POST_SCAN_ROLES bilan bir xil (market yo`q)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      'getPostByScan',
    );
    const roles = Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
    expect([...roles].sort()).toEqual([...POST_SCAN_ROLES].sort());
    expect(roles).not.toContain('market');
  });

  it('kuryer — orders ichida market_tariff / branch_share chiqmaydi', async () => {
    const { controller } = setup({
      statusCode: 200,
      data: {
        id: '91',
        orders: [
          {
            id: '700',
            market_id: '37',
            status: 'on the road',
            total_price: 65000,
            market_tariff: 20000,
            branch_share: 5000,
          },
        ],
      },
    });

    const res = (await firstValueFrom(
      controller.getPostByScan('POST-abc-1', {
        user: { sub: '26', roles: ['courier'] },
      }),
    )) as { data: { orders: Array<Record<string, unknown>> } };

    expect(res.data.orders[0]).toEqual({
      id: '700',
      market_id: '37',
      status: 'on the road',
      total_price: 65000,
    });
  });
});
