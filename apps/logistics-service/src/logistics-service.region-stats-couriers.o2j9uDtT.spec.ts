/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { of, throwError } from 'rxjs';
import { Order_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * o2j9uDtT — GET /region/stats/all (logistics.region.stats_all) har viloyat
 * elementida `activeCouriers` (faqat status = 'active') va `totalCouriers`.
 * Ilgari maydon umuman yo'q edi — xarita tooltipi doim "Kuryerlar: 0".
 * Sonlar identity'dan BITTA `identity.courier.region_counts` so'rovida
 * (viloyatlar soniga bog'liq emas); identity javob bermasa — null (yolg'on
 * 0 emas).
 */
const REGIONS = [
  {
    id: '3',
    name: 'Andijon',
    sato_code: '1703',
    logist_id: null,
    districts: [],
  },
  {
    id: '6',
    name: 'Buxoro',
    sato_code: '1706',
    logist_id: null,
    districts: [],
  },
  {
    id: '9',
    name: 'Jizzax',
    sato_code: '1708',
    logist_id: null,
    districts: [],
  },
];

function setup(identityReply: (payload: any) => unknown) {
  const regionRepo = {
    find: jest.fn(() => Promise.resolve(REGIONS.map((r) => ({ ...r })))),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.courier.region_counts') {
        return identityReply(payload);
      }
      return of({ data: null });
    }),
  };
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({})) } as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  jest.spyOn(service as any, 'findOrders').mockResolvedValue([
    {
      id: 'o1',
      region_id: '6',
      status: Order_status.SOLD,
      total_price: 30_000,
    },
  ] as never);
  return { service, identityClient };
}

const ADMIN = { id: '1', roles: ['admin'] };

describe('o2j9uDtT — region stats/all: activeCouriers', () => {
  it('⭐ har viloyat elementida activeCouriers; kuryeri bor viloyatda > 0, faqat faollar', async () => {
    const { service, identityClient } = setup(() =>
      of({
        data: [
          // Buxoro: 2 kuryer, 1 tasi nofaol → faol 1 (BeePost: "Couriers: 1").
          { region_id: '6', total: 2, active: 1 },
          { region_id: '3', total: 0, active: 0 },
        ],
      }),
    );

    const res: any = await service.getAllRegionsStats(
      undefined,
      undefined,
      ADMIN,
    );

    for (const region of res.data.regions) {
      expect(region).toHaveProperty('activeCouriers');
      expect(region).toHaveProperty('totalCouriers');
    }
    const byId = (id: string) =>
      res.data.regions.find((r: any) => String(r.id) === id);
    expect(byId('6')).toMatchObject({
      activeCouriers: 1,
      totalCouriers: 2,
      totalOrders: 1,
      deliveredOrders: 1,
    });
    expect(byId('3')).toMatchObject({ activeCouriers: 0, totalCouriers: 0 });
    // Javobda qatori yo'q viloyat — 0 (identity har viloyatga qator beradi).
    expect(byId('9')).toMatchObject({ activeCouriers: 0, totalCouriers: 0 });

    const countCalls = identityClient.send.mock.calls.filter(
      ([pattern]: any[]) => pattern.cmd === 'identity.courier.region_counts',
    );
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0][1]).toEqual({ region_ids: ['3', '6', '9'] });
  });

  it.each([
    ['timeout/xato', () => throwError(() => new Error('identity down'))],
    ['buzuq javob', () => of({ data: null })],
  ])(
    '%s — activeCouriers null (yolg`on 0 emas), qolgan statistika joyida',
    async (_label, reply) => {
      const { service } = setup(reply);

      const res: any = await service.getAllRegionsStats(
        undefined,
        undefined,
        ADMIN,
      );

      expect(res.statusCode).toBe(200);
      for (const region of res.data.regions) {
        expect(region.activeCouriers).toBeNull();
        expect(region.totalCouriers).toBeNull();
      }
      expect(res.data.summary.totalRevenue).toBe(30_000);
    },
  );

  it('viloyat doirasi bo`sh (fail-closed) — identity so`ralmaydi', async () => {
    const { service, identityClient } = setup(() => of({ data: [] }));
    jest
      .spyOn(service as any, 'resolveRegionStatsScope')
      .mockResolvedValue({ all: false, regionId: null });

    const res: any = await service.getAllRegionsStats(undefined, undefined, {
      id: '99',
      roles: ['manager'],
    });

    expect(res.data.regions).toEqual([]);
    expect(
      identityClient.send.mock.calls.some(
        ([pattern]: any[]) => pattern.cmd === 'identity.courier.region_counts',
      ),
    ).toBe(false);
  });
});
