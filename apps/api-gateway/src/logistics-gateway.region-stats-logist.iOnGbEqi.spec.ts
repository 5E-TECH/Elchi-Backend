import { firstValueFrom, of } from 'rxjs';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * iOnGbEqi — GET region/stats/all va region/stats/:id: doira logistics'da
 * (logist — faqat o'z viloyatlari, revenue yo'q). Gateway — himoya qatlami:
 * logistics eski versiyada tushum qaytarsa ham logistga pul kaliti chiqmaydi;
 * boshqa rollar javobi o'zgarmaydi.
 */
const statsAll = () => ({
  statusCode: 200,
  data: {
    regions: [
      {
        id: '5',
        name: 'Viloyat-5',
        logist_id: '42',
        totalOrders: 2,
        deliveredOrders: 1,
        cancelledOrders: 1,
        revenue: 30000,
        activeCouriers: 3,
      },
    ],
    summary: {
      totalRegions: 1,
      totalOrders: 2,
      deliveredOrders: 1,
      cancelledOrders: 1,
      totalRevenue: 30000,
    },
  },
});

const statsById = () => ({
  statusCode: 200,
  data: {
    region: { id: '5', name: 'Viloyat-5' },
    summary: { totalOrders: 2, totalRevenue: 30000, activeCouriers: 1 },
    couriers: [{ id: '77', name: 'Kuryer Ali', totalRevenue: 30000 }],
    districts: [{ id: '501', name: 'Tuman', totalRevenue: 30000 }],
  },
});

function setup() {
  const logistics = {
    send: jest.fn((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'logistics.region.stats_all' ? statsAll() : statsById(),
      ),
    ),
  };
  const controller = new LogisticsGatewayController(
    logistics as any,
    { send: jest.fn() } as any,
  );
  return { controller, logistics };
}

const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as any;

describe('iOnGbEqi — region stats (gateway)', () => {
  it('logist: so‘rovchi logistics’ga uzatiladi, javobda revenue/totalRevenue yo‘q', async () => {
    const { controller, logistics } = setup();
    const res: any = await firstValueFrom(
      controller.getAllRegionStats(req('42', ['logist'])),
    );
    expect(logistics.send).toHaveBeenCalledWith(
      { cmd: 'logistics.region.stats_all' },
      expect.objectContaining({
        requester: { id: '42', roles: ['logist'], branch_id: null },
      }),
    );
    expect(JSON.stringify(res)).not.toMatch(/[Rr]evenue/);
    expect(res.data.regions[0]).toEqual(
      expect.objectContaining({ id: '5', totalOrders: 2, activeCouriers: 3 }),
    );
  });

  it('logist: stats/:id — summary/kuryer/tuman totalRevenue yo‘q', async () => {
    const { controller } = setup();
    const res: any = await firstValueFrom(
      controller.getRegionStatsById(req('42', ['logist']), '5'),
    );
    expect(JSON.stringify(res)).not.toMatch(/[Rr]evenue/);
    expect(res.data.couriers[0].name).toBe('Kuryer Ali');
  });

  it('menejer/admin javobi o‘zgarmagan (tushum qoladi)', async () => {
    const { controller } = setup();
    for (const roles of [['manager'], ['admin']]) {
      const all: any = await firstValueFrom(
        controller.getAllRegionStats(req('20', roles)),
      );
      expect(all.data.summary.totalRevenue).toBe(30000);
      const one: any = await firstValueFrom(
        controller.getRegionStatsById(req('20', roles), '5'),
      );
      expect(one.data.couriers[0].totalRevenue).toBe(30000);
    }
  });
});
