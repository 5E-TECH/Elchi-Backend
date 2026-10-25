import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * uherIk8r — hudud statistikasi SERVERDA cheklanadi.
 *
 * Avval `logistics.region.stats_all` so'rovchidan qat'i nazar 14 viloyatning
 * hammasi uchun buyurtma/tushumni qaytarardi; cheklov faqat brauzerda edi.
 *   - admin/superadmin → hamma viloyat (regressiya yo'q);
 *   - logist (iOnGbEqi) → faqat o'ziga biriktirilgan viloyatlar
 *     (regions.logist_id = me), tushum (revenue/totalRevenue) YO'Q;
 *   - filial menejeri/registratori, HQ filiali xodimi ham (karta 3-band) →
 *     faqat filial viloyati;
 *   - aniqlab bo'lmasa → hech biri (fail-closed);
 *   - stats/:id — boshqa viloyat → 403;
 *   - my/district-stats — kuryer/menejerning o'z viloyati, PII yo'q.
 */
// iOnGbEqi: 5- va 9-viloyat logist 42 ga biriktirilgan, 3- — boshqa logistga.
const LOGIST_OF: Record<string, string> = { '5': '42', '9': '42', '3': '43' };
const REGIONS = Array.from({ length: 14 }, (_, i) => ({
  id: String(i + 1),
  name: `Viloyat-${i + 1}`,
  sato_code: `17${String(i + 1).padStart(2, '0')}`,
  logist_id: LOGIST_OF[String(i + 1)] ?? null,
  districts: [
    { id: `${i + 1}01`, name: `Tuman-${i + 1}-A`, sato_code: 'A' },
    { id: `${i + 1}02`, name: `Tuman-${i + 1}-B`, sato_code: 'B' },
  ],
}));

const ORDERS = [
  // Surxondaryo analogi — 5-viloyat: 2 ta, bittasi sotilgan
  {
    id: 'o1',
    region_id: '5',
    district_id: '501',
    courier_id: '77',
    status: Order_status.SOLD,
    total_price: 30_000,
  },
  {
    id: 'o2',
    region_id: '5',
    district_id: '502',
    courier_id: '77',
    status: Order_status.CANCELLED,
    total_price: 10_000,
  },
  // Boshqa viloyat (9) — 5-viloyat xodimiga ko'rinmasligi kerak
  {
    id: 'o3',
    region_id: '9',
    district_id: '901',
    courier_id: '88',
    status: Order_status.PAID,
    total_price: 99_000,
  },
];

type BranchReply = {
  branch_id: string;
  branch: { type: string; region_id: string | null };
} | null;

function setup(opts: {
  branchByUser?: Record<string, BranchReply>;
  courierRegion?: Record<string, string | null>;
}) {
  const regionRepo = {
    find: jest.fn((options?: { where?: { logist_id?: string } }) =>
      Promise.resolve(
        REGIONS.filter(
          (r) =>
            options?.where?.logist_id === undefined ||
            r.logist_id === options.where.logist_id,
        ).map((r) => ({ ...r })),
      ),
    ),
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(REGIONS.find((r) => r.id === where.id) ?? null),
    ),
  };
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }, payload: { user_id: string }) => {
      expect(pattern).toEqual({ cmd: 'branch.user.find_by_user' });
      return of({ data: opts.branchByUser?.[payload.user_id] ?? null });
    }),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.courier.find_by_ids') {
        const id = String(payload.ids[0]);
        if (!(id in (opts.courierRegion ?? {}))) return of({ data: [] });
        return of({
          data: [{ id, role: 'courier', region_id: opts.courierRegion![id] }],
        });
      }
      if (pattern.cmd === 'identity.courier.find_all') {
        return of({
          data: {
            items: [
              {
                id: '77',
                name: 'Kuryer Ali',
                phone_number: '+998900000077',
                district_id: '501',
                status: 'active',
              },
            ],
          },
        });
      }
      return of({ data: null });
    }),
  };
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any, // order
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any, // search
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  const findOrders = jest
    .spyOn(service as any, 'findOrders')
    .mockResolvedValue(ORDERS as never);
  return { service, findOrders, branchClient, identityClient };
}

const REGIONAL_MANAGER = { id: '20', roles: ['manager'], branch_id: '7' };
const REGIONAL_REGISTRATOR = { id: '21', roles: ['registrator'] };
const HQ_REGISTRATOR = { id: '22', roles: ['registrator'], branch_id: '1' };
const HQ_MANAGER = { id: '23', roles: ['manager'], branch_id: '1' };
const COURIER = { id: '77', roles: ['courier'] };

const branchByUser: Record<string, BranchReply> = {
  '20': { branch_id: '7', branch: { type: 'REGIONAL', region_id: '5' } },
  '21': { branch_id: '7', branch: { type: 'REGIONAL', region_id: '5' } },
  '22': { branch_id: '1', branch: { type: 'HQ', region_id: '14' } },
  '23': { branch_id: '1', branch: { type: 'HQ', region_id: '14' } },
};

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  }
  throw new Error('RpcException kutilgandi');
}

describe('uherIk8r — getAllRegionsStats doirasi', () => {
  it.each([
    ['admin', { id: '1', roles: ['admin'] }],
    ['superadmin', { id: '1', roles: ['superadmin'] }],
    ["requester yo'q (ichki chaqiruv)", undefined],
  ])('%s → 14 viloyat (regressiya yo‘q)', async (_label, requester) => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getAllRegionsStats(
      undefined,
      undefined,
      requester as any,
    );
    expect(res.data.regions).toHaveLength(14);
    expect(res.data.summary.totalRevenue).toBe(30_000 + 99_000);
  });

  // uherIk8r (karta 3-band): ADMIN/SUPERADMIN (va BeePost bo'yicha LOGIST)
  // dan boshqa HAMMA — HQ filial xodimi ham — faqat o'z viloyatini ko'radi.
  it.each([
    ['HQ registrator', HQ_REGISTRATOR],
    ['HQ menejeri', HQ_MANAGER],
  ])(
    '⭐ %s → faqat HQ filiali viloyati (14), boshqa viloyat tushumi yo‘q',
    async (_label, requester) => {
      const { service } = setup({ branchByUser });
      const res: any = await service.getAllRegionsStats(
        undefined,
        undefined,
        requester,
      );
      expect(res.data.regions.map((r: any) => r.id)).toEqual(['14']);
      expect(res.data.summary).toEqual(
        expect.objectContaining({ totalRegions: 1 }),
      );
      expect(JSON.stringify(res.data)).not.toContain('Viloyat-5');
    },
  );

  it.each([
    ['filial menejeri', REGIONAL_MANAGER],
    ['filial registratori', REGIONAL_REGISTRATOR],
  ])(
    '%s → faqat o‘z viloyati, boshqa viloyat tushumi yo‘q',
    async (_label, requester) => {
      const { service } = setup({ branchByUser });
      const res: any = await service.getAllRegionsStats(
        undefined,
        undefined,
        requester,
      );
      expect(res.data.regions.map((r: any) => r.id)).toEqual(['5']);
      expect(res.data.regions[0]).toEqual(
        expect.objectContaining({
          totalOrders: 2,
          deliveredOrders: 1,
          revenue: 30_000,
        }),
      );
      expect(res.data.summary).toEqual(
        expect.objectContaining({ totalRegions: 1, totalRevenue: 30_000 }),
      );
      expect(JSON.stringify(res.data)).not.toContain('Viloyat-9');
    },
  );

  it("kuryer (o'tish davri flagi bilan gateway o'tkazsa) → faqat o'z viloyati", async () => {
    const { service } = setup({ courierRegion: { '77': '5' } });
    const res: any = await service.getAllRegionsStats(
      undefined,
      undefined,
      COURIER,
    );
    expect(res.data.regions.map((r: any) => r.id)).toEqual(['5']);
    expect(res.data.summary.totalRevenue).toBe(30_000);
  });

  // iOnGbEqi (ega LG-S3/LG-S1): logist — faqat o'z viloyatlari, tushumsiz.
  it('⭐ logist 2 viloyatga biriktirilgan → 2 qator, revenue/totalRevenue YO‘Q', async () => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getAllRegionsStats(undefined, undefined, {
      id: '42',
      roles: ['logist'],
    });
    expect(res.data.regions.map((r: any) => r.id).sort()).toEqual(['5', '9']);
    for (const row of res.data.regions) {
      expect(row).not.toHaveProperty('revenue');
      expect(row.logist_id).toBe('42');
    }
    expect(res.data.regions.find((r: any) => r.id === '5')).toEqual(
      expect.objectContaining({
        totalOrders: 2,
        deliveredOrders: 1,
        cancelledOrders: 1,
      }),
    );
    expect(res.data.summary).not.toHaveProperty('totalRevenue');
    expect(res.data.summary).toEqual(
      expect.objectContaining({
        totalRegions: 2,
        totalOrders: 3,
        deliveredOrders: 2,
        cancelledOrders: 1,
      }),
    );
    const body = JSON.stringify(res.data);
    expect(body).not.toMatch(/[Rr]evenue/);
    expect(body).not.toContain('Viloyat-3');
    expect(body).not.toContain('99000');
  });

  it('viloyat biriktirilmagan logist → bo‘sh ro‘yxat, buyurtmalar so‘ralmaydi', async () => {
    const { service, findOrders } = setup({ branchByUser });
    const res: any = await service.getAllRegionsStats(undefined, undefined, {
      id: '77777',
      roles: ['logist'],
    });
    expect(res.data.regions).toEqual([]);
    expect(res.data.summary).not.toHaveProperty('totalRevenue');
    expect(findOrders).not.toHaveBeenCalled();
  });

  it('filialga biriktirilmagan menejer → hech bir viloyat (fail-closed)', async () => {
    const { service, findOrders } = setup({ branchByUser: {} });
    const res: any = await service.getAllRegionsStats(undefined, undefined, {
      id: '99',
      roles: ['manager'],
    });
    expect(res.data.regions).toEqual([]);
    expect(res.data.summary.totalRevenue).toBe(0);
    expect(findOrders).not.toHaveBeenCalled();
  });
});

describe('uherIk8r — getRegionDetailedStats doirasi', () => {
  it('filial menejeri boshqa viloyat id bilan → 403', async () => {
    const { service } = setup({ branchByUser });
    const err = await rpcError(
      service.getRegionDetailedStats(
        '9',
        undefined,
        undefined,
        REGIONAL_MANAGER,
      ),
    );
    expect(err.statusCode).toBe(403);
  });

  it('filial menejeri o‘z viloyati bilan → 200', async () => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getRegionDetailedStats(
      '5',
      undefined,
      undefined,
      REGIONAL_MANAGER,
    );
    expect(res.data.region.id).toBe('5');
  });

  it('admin istalgan viloyat → 200 (tushum bilan, o‘zgarmagan)', async () => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getRegionDetailedStats(
      '9',
      undefined,
      undefined,
      { id: '1', roles: ['admin'] },
    );
    expect(res.data.region.id).toBe('9');
    expect(res.data.summary.totalRevenue).toBe(99_000);
  });

  it('⭐ logist: o‘z viloyati → 200, totalRevenue hech qayerda yo‘q', async () => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getRegionDetailedStats(
      '5',
      undefined,
      undefined,
      { id: '42', roles: ['logist'] },
    );
    expect(res.data.region.id).toBe('5');
    expect(res.data.summary).not.toHaveProperty('totalRevenue');
    expect(res.data.summary).toEqual(
      expect.objectContaining({ totalOrders: 2, deliveredOrders: 1 }),
    );
    expect(res.data.couriers.length).toBeGreaterThan(0);
    for (const row of [...res.data.couriers, ...res.data.districts]) {
      expect(row).not.toHaveProperty('totalRevenue');
    }
    // Kuryer ismi/telefoni (logist nazorati uchun) qoladi.
    expect(res.data.couriers[0]).toEqual(
      expect.objectContaining({ name: 'Kuryer Ali' }),
    );
    expect(JSON.stringify(res.data)).not.toMatch(/[Rr]evenue/);
  });

  it('⛔ logist: boshqa logistning yoki biriktirilmagan viloyat → 403', async () => {
    const { service } = setup({ branchByUser });
    for (const regionId of ['3', '14']) {
      const err = await rpcError(
        service.getRegionDetailedStats(regionId, undefined, undefined, {
          id: '42',
          roles: ['logist'],
        }),
      );
      expect(err.statusCode).toBe(403);
    }
  });

  it('⭐ HQ registrator/menejer: boshqa viloyat → 403, o‘z (HQ) viloyati → 200', async () => {
    const { service } = setup({ branchByUser });
    for (const requester of [HQ_REGISTRATOR, HQ_MANAGER]) {
      const err = await rpcError(
        service.getRegionDetailedStats('9', undefined, undefined, requester),
      );
      expect(err.statusCode).toBe(403);
      const res: any = await service.getRegionDetailedStats(
        '14',
        undefined,
        undefined,
        requester,
      );
      expect(res.data.region.id).toBe('14');
    }
  });
});

describe('uherIk8r — getMyRegionDistrictStats (GET /region/my/district-stats)', () => {
  it('kuryer → faqat o‘z viloyati; boshqa viloyat nomi va kuryer PII yo‘q', async () => {
    const { service } = setup({ courierRegion: { '77': '5' } });
    const res: any = await service.getMyRegionDistrictStats(
      undefined,
      undefined,
      COURIER,
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.region).toEqual({
      id: '5',
      name: 'Viloyat-5',
      satoCode: '1705',
    });
    expect(res.data.summary).toEqual(
      expect.objectContaining({
        totalOrders: 2,
        deliveredOrders: 1,
        cancelledOrders: 1,
        pendingOrders: 0,
        totalRevenue: 30_000,
        districtsCount: 2,
      }),
    );
    expect(res.data.districts.map((d: any) => d.id).sort()).toEqual([
      '501',
      '502',
    ]);
    const body = JSON.stringify(res.data);
    expect(body).not.toContain('Viloyat-9');
    expect(body).not.toContain('Kuryer Ali');
    expect(body).not.toContain('+998900000077');
  });

  it('menejer → filial viloyati', async () => {
    const { service } = setup({ branchByUser });
    const res: any = await service.getMyRegionDistrictStats(
      undefined,
      undefined,
      REGIONAL_MANAGER,
    );
    expect(res.data.region.id).toBe('5');
  });

  it('viloyat biriktirilmagan kuryer → 200 bo‘sh holat', async () => {
    const { service } = setup({ courierRegion: { '77': null } });
    const res: any = await service.getMyRegionDistrictStats(
      undefined,
      undefined,
      COURIER,
    );
    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 200,
        message: 'Sizga viloyat biriktirilmagan',
        data: { region: null, summary: null, districts: [] },
      }),
    );
  });
});
