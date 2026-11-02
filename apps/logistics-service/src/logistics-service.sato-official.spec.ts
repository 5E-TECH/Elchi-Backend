/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * «Yangi tuman qo'shish» formasi kodni rasmiy SOATO ro'yxatidan oladi
 * (`GET district/sato-official/:regionId`): admin kodni yoddan bilmaydi.
 */
type Holder = { id: string; name: string; sato_code: string };

function setup(
  regionsById: Record<string, unknown>,
  districtHolders: Holder[] = [],
  regionHolders: Holder[] = [],
) {
  const inCodes = (where: { sato_code?: { value?: unknown } }) =>
    (where?.sato_code?.value as string[] | undefined) ?? [];
  const districtRepo = {
    find: jest.fn((opts: { where: { sato_code?: { value?: unknown } } }) =>
      Promise.resolve(
        districtHolders.filter((h) =>
          inCodes(opts.where).includes(h.sato_code),
        ),
      ),
    ),
  };
  const regionRepo = {
    findOne: jest.fn((opts: { where: { id: string } }) =>
      Promise.resolve(regionsById[opts.where.id] ?? null),
    ),
    find: jest.fn((opts: { where: { sato_code?: { value?: unknown } } }) =>
      Promise.resolve(
        regionHolders.filter((h) => inCodes(opts.where).includes(h.sato_code)),
      ),
    ),
  };
  const client = () =>
    ({ send: jest.fn(() => of({})), emit: jest.fn(() => of({})) }) as any;
  const service = new LogisticsServiceService(
    {} as any,
    regionRepo as any,
    districtRepo as any,
    client(),
    client(),
    client(),
    client(),
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  return { service, districtRepo, regionRepo };
}

const TOSH_VIL = { id: '3', name: 'Toshkent', sato_code: '1727' };

describe('listOfficialDistrictSatoCodes', () => {
  it("viloyatning rasmiy tumanlarini kodi bilan beradi (O'rtachirchiq — 1727253)", async () => {
    const { service } = setup({ '3': TOSH_VIL });
    const res: any = await service.listOfficialDistrictSatoCodes('3');
    expect(res.data.region_id).toBe('3');
    expect(res.data.region_sato_code).toBe('1727');
    expect(res.data.items).toContainEqual({
      name: "O'rtachirchiq tumani",
      sato_code: '1727253',
      taken_by: null,
    });
    expect(
      res.data.items.every((item: { sato_code: string }) =>
        /^1727\d{3}$/.test(item.sato_code),
      ),
    ).toBe(true);
  });

  it('band kod — kim egallagani bilan (tuman ham, viloyat ham)', async () => {
    const { service } = setup(
      { '3': TOSH_VIL },
      [{ id: '40', name: 'Bekobod sh.', sato_code: '1727413' }],
      [{ id: '77', name: 'Xato viloyat', sato_code: '1727401' }],
    );
    const res: any = await service.listOfficialDistrictSatoCodes('3');
    const byCode = (code: string) =>
      res.data.items.find((i: { sato_code: string }) => i.sato_code === code);
    expect(byCode('1727413').taken_by).toEqual({
      kind: 'district',
      id: '40',
      name: 'Bekobod sh.',
    });
    expect(byCode('1727401').taken_by).toEqual({
      kind: 'region',
      id: '77',
      name: 'Xato viloyat',
    });
    expect(byCode('1727253').taken_by).toBeNull();
  });

  it("viloyat kodi bo'lmasa nomi bo'yicha topadi", async () => {
    const { service } = setup({
      '2': { id: '2', name: 'Namangan viloyati', sato_code: null },
    });
    const res: any = await service.listOfficialDistrictSatoCodes('2');
    expect(res.data.region_sato_code).toBe('1714');
    expect(
      res.data.items.some(
        (i: { sato_code: string }) => i.sato_code === '1714207',
      ),
    ).toBe(true);
  });

  it("rasmiy ro'yxatda yo'q viloyat — bo'sh ro'yxat (kod qo'lda)", async () => {
    const { service, districtRepo } = setup({
      '9': { id: '9', name: 'Kodsiz viloyat', sato_code: null },
    });
    const res: any = await service.listOfficialDistrictSatoCodes('9');
    expect(res.data).toEqual({
      region_id: '9',
      region_sato_code: null,
      items: [],
    });
    expect(districtRepo.find).not.toHaveBeenCalled();
  });

  it.each(['404', 'abc', ''])('viloyat topilmasa 404 (%p)', async (id) => {
    const { service, regionRepo } = setup({ '3': TOSH_VIL });
    let status: number | undefined;
    try {
      await service.listOfficialDistrictSatoCodes(id);
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      status = ((err as RpcException).getError() as { statusCode?: number })
        .statusCode;
    }
    expect(status).toBe(404);
    if (id !== '404') expect(regionRepo.findOne).not.toHaveBeenCalled();
  });
});
