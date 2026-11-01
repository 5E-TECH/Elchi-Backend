import { In, IsNull } from 'typeorm';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * Tumanni boshqa viloyatga biriktirish (`PATCH /district/:id`) natijasi
 * viloyat ro'yxatida ko'rinadi: `GET /region` va `GET /region/:id` har
 * viloyat bilan `assignedDistricts` ni (`assigned_region ?? region_id`)
 * qaytaradi; `districts` (geografik, `region_id`) o'zgarmaydi. Avval faqat
 * `districts` qaytardi — ko'chirilgan tuman eski viloyatda qolib ko'rinardi.
 */
describe('GET /region — assignedDistricts (tuman biriktirish ko‘rinadi)', () => {
  const tashkent = { id: '1', name: 'Toshkent', districts: [] as unknown[] };
  const namangan = { id: '7', name: 'Namangan', districts: [] as unknown[] };
  // Chilonzor: geografik Toshkent (1), Namanganga biriktirilgan (7).
  const chilonzor = {
    id: '12',
    name: 'Chilonzor',
    region_id: '1',
    assigned_region: '7',
  };
  // Yunusobod: Toshkentda qolgan.
  const yunusobod = {
    id: '13',
    name: 'Yunusobod',
    region_id: '1',
    assigned_region: '1',
  };
  // Eski qator: biriktirilmagan (NULL) — o'z viloyatiga (Namangan) xizmat qiladi.
  const chust = {
    id: '20',
    name: 'Chust',
    region_id: '7',
    assigned_region: null,
  };

  function setup(regions: unknown[]) {
    const regionRepo = {
      find: jest
        .fn()
        .mockResolvedValue(regions.map((r) => ({ ...(r as object) }))),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          (regions as Array<{ id: string }>).find((r) => r.id === where.id) ??
            null,
        ),
      ),
    };
    const districtRepo = {
      find: jest.fn().mockResolvedValue([chilonzor, yunusobod, chust]),
    };
    const service = new LogisticsServiceService(
      {} as any,
      regionRepo as any,
      districtRepo as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { log: jest.fn(), logChange: jest.fn() } as any,
    );
    return { service, districtRepo };
  }

  type RegionOut = {
    id: string;
    districts: unknown[];
    assignedDistricts: Array<{ name: string }>;
  };
  const names = (list: Array<{ name: string }>) => list.map((d) => d.name);

  it('findAllRegions: ko‘chirilgan tuman YANGI viloyatda, eski viloyatda emas; NULL — o‘z viloyatida', async () => {
    const { service, districtRepo } = setup([tashkent, namangan]);

    const res = (await service.findAllRegions()) as { data: RegionOut[] };
    const byId = new Map(res.data.map((r) => [r.id, r]));

    expect(names(byId.get('7')!.assignedDistricts)).toEqual([
      'Chilonzor',
      'Chust',
    ]);
    expect(names(byId.get('1')!.assignedDistricts)).toEqual(['Yunusobod']);
    // Geografik `districts` relation tegilmagan (mavjud iste'molchilar uchun).
    expect(byId.get('1')!.districts).toEqual([]);
    // Bitta so'rov: biriktirilgan YOKI (NULL va o'z viloyati).
    expect(districtRepo.find).toHaveBeenCalledTimes(1);
    expect(districtRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { assigned_region: In(['1', '7']) },
          { assigned_region: IsNull(), region_id: In(['1', '7']) },
        ],
        relations: ['region'],
      }),
    );
  });

  it('findRegionById: o‘sha viloyatga biriktirilganlar', async () => {
    const { service } = setup([namangan]);
    const res = (await service.findRegionById('7')) as { data: RegionOut };
    expect(res.data.id).toBe('7');
    expect(names(res.data.assignedDistricts)).toEqual(['Chilonzor', 'Chust']);
  });

  it('viloyat yo‘q — tumanlar so‘ralmaydi', async () => {
    const { service, districtRepo } = setup([]);
    const res = (await service.findAllRegions()) as { data: RegionOut[] };
    expect(res.data).toEqual([]);
    expect(districtRepo.find).not.toHaveBeenCalled();
  });
});
