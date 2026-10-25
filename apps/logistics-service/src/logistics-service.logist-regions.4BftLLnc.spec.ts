import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * 4BftLLnc — `logistics.region.find_by_logist`: logist doirasining yagona
 * manbasi (regions.logist_id = me). Gateway buyurtmalar, paketlar, kuryerlar
 * va qidiruvni shu to'plam bilan cheklaydi.
 */
const REGIONS = [
  { id: '5', name: 'Samarqand viloyati', logist_id: '42' },
  { id: '9', name: 'Buxoro viloyati', logist_id: '42' },
  { id: '7', name: 'Xorazm viloyati', logist_id: '43' },
  { id: '3', name: 'Navoiy viloyati', logist_id: null },
];

function setup(regions = REGIONS) {
  const regionRepo = {
    find: jest.fn(({ where }: { where?: { logist_id?: string } }) =>
      Promise.resolve(
        regions.filter(
          (region) =>
            where?.logist_id === undefined ||
            region.logist_id === where.logist_id,
        ),
      ),
    ),
  };
  const client = { send: jest.fn(() => of({})) };
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo as any,
    {} as any,
    client as any, // order
    client as any, // branch
    client as any, // identity
    client as any, // search
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  return { service, regionRepo };
}

describe('4BftLLnc — logistics.region.find_by_logist', () => {
  it('faqat logist_id = me viloyatlari (id + nom)', async () => {
    const { service, regionRepo } = setup();
    const res: any = await service.findRegionsByLogist('42');
    expect(regionRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { logist_id: '42' } }),
    );
    expect(res.data).toEqual({
      logist_id: '42',
      region_ids: ['5', '9'],
      regions: [
        { id: '5', name: 'Samarqand viloyati' },
        { id: '9', name: 'Buxoro viloyati' },
      ],
    });
  });

  it('id kanonik: "042" ham 42', async () => {
    const { service } = setup();
    const res: any = await service.findRegionsByLogist('042');
    expect(res.data.region_ids).toEqual(['5', '9']);
  });

  it('biriktirilmagan logist — bo‘sh (xabar: viloyat biriktirilmagan)', async () => {
    const { service } = setup();
    const res: any = await service.findRegionsByLogist('99');
    expect(res.data.region_ids).toEqual([]);
    expect(res.message).toBe('Sizga hali viloyat biriktirilmagan');
  });

  it('yaroqsiz id — bo‘sh, bazaga so‘rov yo‘q', async () => {
    const { service, regionRepo } = setup();
    for (const bad of [undefined, null, '', 'abc', '0', '-1', '1 OR 1=1']) {
      const res: any = await service.findRegionsByLogist(bad);
      expect(res.data.region_ids).toEqual([]);
    }
    expect(regionRepo.find).not.toHaveBeenCalled();
  });

  it('himoya: repo filtri ishlamasa ham begona viloyat qaytmaydi', async () => {
    const regionRepo = {
      find: jest.fn(() => Promise.resolve(REGIONS)),
    };
    const { service } = setup();
    (service as any).regionRepo = regionRepo;
    expect(await service.findLogistRegions('42')).toEqual([
      { id: '5', name: 'Samarqand viloyati' },
      { id: '9', name: 'Buxoro viloyati' },
    ]);
  });
});
