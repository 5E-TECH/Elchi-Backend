import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * PUvKXWVw — `GET /orders/cancel-reasons/stats` ROL DOIRASI (gateway).
 *
 *   • market — FAQAT o'z buyurtmalari: `market_id` tokendan, so'rovdagi
 *     boshqa `market_id` e'tiborsiz (begona marketni ko'rmaydi);
 *   • menejer — FAQAT o'z filiali (biriktirish), so'rovdagi `branch_id`
 *     e'tiborsiz; biriktirilmagan bo'lsa 400;
 *   • superadmin/admin — so'rov parametrlari o'zgarishsiz.
 * Davr va `group_by` o'zgarishsiz order-service'ga uzatiladi (Toshkent kuni
 * hisobi — `cancel-reason-stats.PUvKXWVw.pg.spec.ts`).
 */
describe('PUvKXWVw — cancel-reasons/stats rol doirasi', () => {
  function setup(branchAssignment: unknown = null) {
    const orderClient = {
      send: jest.fn(() => of({ total: 0, by_reason: [] })),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: branchAssignment })),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      branchClient as any,
    );
    const call = (
      user: Record<string, unknown>,
      query: {
        startDate?: string;
        endDate?: string;
        market_id?: string;
        branch_id?: string;
        group_by?: string;
      } = {},
    ) =>
      controller.cancelReasonStats(
        { user } as any,
        query.startDate,
        query.endDate,
        query.market_id,
        query.branch_id,
        query.group_by,
      );
    const payload = () =>
      (orderClient.send.mock.calls[0] as unknown[] | undefined)?.[1];
    return { call, orderClient, branchClient, payload };
  }

  it('⭐ market — market_id tokendan; begona market_id e`tiborsiz', async () => {
    const h = setup();
    await h.call(
      { sub: '16', roles: ['market'] },
      {
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        market_id: '999',
        group_by: 'courier',
      },
    );
    expect(h.orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.analytics.cancel_reasons' },
      {
        startDate: '2026-10-15',
        endDate: '2026-10-15',
        market_id: '16',
        branch_id: undefined,
        group_by: 'courier',
      },
    );
  });

  it('⭐ menejer — filial JWT biriktirishidan; so`rovdagi branch_id e`tiborsiz', async () => {
    const h = setup();
    await h.call(
      { sub: '25', roles: ['manager'], branch_id: '3' },
      { branch_id: '77' },
    );
    expect(h.payload()).toMatchObject({ branch_id: '3' });
  });

  it('menejer JWT da filialsiz — branch-service biriktirishi; yo`q bo`lsa 400', async () => {
    const ok = setup({ branch_id: '5', role: 'MANAGER' });
    await ok.call({ sub: '25', roles: ['manager'] });
    expect(ok.payload()).toMatchObject({ branch_id: '5' });

    const none = setup(null);
    await expect(
      none.call({ sub: '25', roles: ['manager'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(none.orderClient.send).not.toHaveBeenCalled();
  });

  it('superadmin — market_id / branch_id / group_by o`zgarishsiz', async () => {
    const h = setup();
    await h.call(
      { sub: '1', roles: ['superadmin'] },
      { market_id: ' 501 ', branch_id: '15', group_by: ' region ' },
    );
    expect(h.payload()).toEqual({
      startDate: undefined,
      endDate: undefined,
      market_id: '501',
      branch_id: '15',
      group_by: 'region',
    });
  });
});
