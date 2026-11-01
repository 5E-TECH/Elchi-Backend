/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Not } from 'typeorm';
import { LogisticsServiceService } from './logistics-service.service';
import { CreateDistrictDto } from './dto/create-district.dto';
import { districtCodeFitsRegion, matchDistricts } from './utils/sato-matcher';
import {
  DISTRICT_SATO_UNIQUE_INDEX,
  DistrictSatoCodeUnique1716000000160,
} from '../../../migrations/1716000000160-DistrictSatoCodeUnique';

/**
 * SlMjauWC (N5) — SATO apply boshqa viloyat/tumanning kodini bermaydi,
 * bitta kod = bitta tuman, `districts.sato_code` qisman unique indeks.
 */
const ANDIJON = { id: '1', name: 'Andijon viloyati', sato_code: '1703' };
const NAMANGAN = { id: '2', name: 'Namangan viloyati', sato_code: '1714' };
const TOSH_VIL = { id: '3', name: 'Toshkent viloyati', sato_code: '1727' };

type D = {
  id: string;
  name: string;
  sato_code?: string | null;
  region?: { id: string; name: string; sato_code?: string | null };
};

const matchedCode = (r: ReturnType<typeof matchDistricts>, id: string) =>
  r.matched.find((m) => m.dbId === id)?.satoCode;
const unmatchedReason = (r: ReturnType<typeof matchDistricts>, id: string) =>
  r.unmatched.find((u) => u.dbId === id)?.reason;

describe('SlMjauWC — matchDistricts', () => {
  it("o'z viloyatidagi tumanga kod beradi", () => {
    const r = matchDistricts([
      { id: '10', name: 'Baliqchi', sato_code: null, region: ANDIJON },
    ]);
    expect(matchedCode(r, '10')).toBe('1703206');
  });

  it("boshqa viloyatdan qidirmaydi: Andijon ichida yo'q nom — unmatched", () => {
    // Ilgari: Kosonsoy (Namangan, 1714207) Andijon tumaniga berilardi.
    const r = matchDistricts([
      { id: '11', name: 'Kosonsoy', sato_code: null, region: ANDIJON },
    ]);
    expect(matchedCode(r, '11')).toBeUndefined();
    expect(unmatchedReason(r, '11')).toBe('not_found_in_region');
  });

  it('viloyat rasmiy kodi bo‘yicha topiladi (nom farq qilsa ham)', () => {
    const r = matchDistricts([
      {
        id: '12',
        name: 'Kosonsoy',
        sato_code: null,
        region: { id: '2', name: 'Namangan', sato_code: '1714' },
      },
    ]);
    expect(matchedCode(r, '12')).toBe('1714207');
  });

  it('viloyati topilmasa — region_not_found, boshqa viloyatdan berilmaydi', () => {
    const r = matchDistricts([
      {
        id: '13',
        name: 'Baliqchi',
        sato_code: null,
        region: { id: '9', name: 'Mavjud emas', sato_code: null },
      },
    ]);
    expect(matchedCode(r, '13')).toBeUndefined();
    expect(unmatchedReason(r, '13')).toBe('region_not_found');
  });

  it('kod boshqa tumanda bor bo‘lsa (ro‘yxatda keyinroq kelsa ham) — berilmaydi', () => {
    const rows: D[] = [
      { id: '20', name: 'Baliqchi', sato_code: null, region: ANDIJON },
      {
        id: '21',
        name: 'Eski Baliqchi',
        sato_code: '1703206',
        region: ANDIJON,
      },
    ];
    const r = matchDistricts(rows);
    expect(matchedCode(r, '20')).toBeUndefined();
    expect(unmatchedReason(r, '20')).toBe('code_taken');
    expect(r.matched.filter((m) => m.satoCode === '1703206')).toHaveLength(1);
  });

  it("bitta kodga ikki tuman da'vo qilsa — hech biriga berilmaydi", () => {
    const r = matchDistricts([
      { id: '30', name: 'Baliqchi', sato_code: null, region: ANDIJON },
      { id: '31', name: 'Baliqchi tumani', sato_code: null, region: ANDIJON },
    ]);
    expect(matchedCode(r, '30')).toBeUndefined();
    expect(matchedCode(r, '31')).toBeUndefined();
    expect(unmatchedReason(r, '30')).toBe('ambiguous');
    expect(unmatchedReason(r, '31')).toBe('ambiguous');
  });

  it('aniq nom substring mosligidan ustun (Yangiyo‘l tumani ≠ Yangiyo‘l shahri)', () => {
    const r = matchDistricts([
      { id: '40', name: "Yangiyo'l tumani", sato_code: null, region: TOSH_VIL },
    ]);
    expect(matchedCode(r, '40')).toBe('1727259');
  });

  it('natijada hech qachon bitta kod ikki tumanga berilmaydi', () => {
    const r = matchDistricts([
      { id: '50', name: 'Baliqchi', sato_code: null, region: ANDIJON },
      { id: '51', name: 'Kosonsoy', sato_code: null, region: NAMANGAN },
      { id: '52', name: 'Kosonsoy', sato_code: null, region: ANDIJON },
      { id: '53', name: 'Andijon', sato_code: null, region: ANDIJON },
    ]);
    const codes = r.matched.map((m) => m.satoCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const m of r.matched) {
      const row = [ANDIJON, NAMANGAN].find((reg) =>
        m.satoCode.startsWith(reg.sato_code),
      );
      expect(row).toBeDefined();
    }
  });

  it('districtCodeFitsRegion — viloyat prefiksi darvozasi', () => {
    expect(districtCodeFitsRegion('1703206', { sato_code: '1703' })).toBe(true);
    expect(districtCodeFitsRegion('1714207', { sato_code: '1703' })).toBe(
      false,
    );
    expect(
      districtCodeFitsRegion(
        '1703206',
        { sato_code: '1703' },
        { sato_code: '1714' },
      ),
    ).toBe(false);
  });
});

describe('SlMjauWC — applyDistrictSatoCodes / create / update', () => {
  /** `regionHolderFor` — shu SOATO kodli VILOYAT (kod → viloyat). */
  function setup(
    rows: D[],
    holderFor: Record<string, unknown> = {},
    regionHolderFor: Record<string, unknown> = {},
  ) {
    const districtRepo = {
      find: jest.fn((opts: { where?: Record<string, unknown> }) =>
        Promise.resolve(
          opts?.where && 'id' in opts.where ? [] : rows.map((r) => ({ ...r })),
        ),
      ),
      findOne: jest.fn((opts: { where: Record<string, unknown> }) =>
        Promise.resolve(
          (opts.where.sato_code &&
            holderFor[String(opts.where.sato_code as string)]) ??
            null,
        ),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn((e: Record<string, unknown>) => ({ ...e })),
      save: jest.fn((e: Record<string, unknown>) =>
        Promise.resolve({ id: '99', ...e }),
      ),
    };
    const regionsById: Record<string, unknown> = {
      '1': ANDIJON,
      '2': NAMANGAN,
      '3': TOSH_VIL,
      // Rasmiy kodi yo'q viloyat — prefiks tekshirilmaydi.
      '9': { id: '9', name: 'Kodsiz viloyat', sato_code: null },
    };
    const regionRepo = {
      // `where` ga qarab: id — viloyat, sato_code — kodni egallagan viloyat.
      findOne: jest.fn((opts: { where: Record<string, unknown> }) =>
        Promise.resolve(
          (opts.where.id !== undefined
            ? regionsById[String(opts.where.id as string)]
            : regionHolderFor[String(opts.where.sato_code as string)]) ?? null,
        ),
      ),
    };
    const activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    const service = new LogisticsServiceService(
      {} as any,
      regionRepo as any,
      districtRepo as any,
      { send: jest.fn(() => of({})), emit: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})), emit: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})), emit: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})), emit: jest.fn(() => of({})) } as any,
      activityLog as any,
    );
    jest
      .spyOn(service as any, 'syncDistrictToSearch')
      .mockResolvedValue(undefined);
    return { service, districtRepo, regionRepo, activityLog };
  }

  async function errorOf(p: Promise<unknown>): Promise<any> {
    try {
      await p;
      return undefined;
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      return (err as RpcException).getError();
    }
  }

  async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
    try {
      await p;
      return undefined;
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      return ((err as RpcException).getError() as { statusCode?: number })
        .statusCode;
    }
  }

  it("faqat o'chirilmagan tumanlar o'qiladi", async () => {
    const { service, districtRepo } = setup([]);
    await service.applyDistrictSatoCodes();
    await service.matchDistrictSatoCodes();
    for (const call of districtRepo.find.mock.calls) {
      expect(call[0].where).toEqual(
        expect.objectContaining({ isDeleted: false }),
      );
    }
  });

  it("yozishdan oldin qayta tekshiradi: kod boshqa tumanda bo'lsa — skipped", async () => {
    const { service, districtRepo } = setup(
      [{ id: '10', name: 'Baliqchi', sato_code: null, region: ANDIJON }],
      { '1703206': { id: '77', sato_code: '1703206' } },
    );
    const res: any = await service.applyDistrictSatoCodes();
    expect(districtRepo.update).not.toHaveBeenCalled();
    expect(res.data.appliedCount).toBe(0);
    expect(res.data.skipped).toEqual([
      expect.objectContaining({
        id: '10',
        sato_code: '1703206',
        reason: 'code_taken',
      }),
    ]);
  });

  it('unique violation (23505) — skipped, qolganlari yoziladi', async () => {
    const { service, districtRepo } = setup([
      { id: '10', name: 'Baliqchi', sato_code: null, region: ANDIJON },
      { id: '11', name: 'Kosonsoy', sato_code: null, region: NAMANGAN },
    ]);
    districtRepo.update
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
      .mockResolvedValueOnce({ affected: 1 });
    const res: any = await service.applyDistrictSatoCodes();
    expect(res.data.appliedCount).toBe(1);
    expect(res.data.applied).toEqual([
      expect.objectContaining({ id: '11', sato_code: '1714207' }),
    ]);
    expect(res.data.skipped).toEqual([
      expect.objectContaining({ id: '10', reason: 'code_taken' }),
    ]);
  });

  it("boshqa viloyatning kodi yozilmaydi (cross-region fallback yo'q)", async () => {
    const { service, districtRepo } = setup([
      { id: '11', name: 'Kosonsoy', sato_code: null, region: ANDIJON },
    ]);
    const res: any = await service.applyDistrictSatoCodes();
    expect(districtRepo.update).not.toHaveBeenCalled();
    expect(res.data.unmatched).toEqual([
      expect.objectContaining({ dbId: '11', reason: 'not_found_in_region' }),
    ]);
  });

  it('createDistrict: 23505 poygasi — 409', async () => {
    const { service, districtRepo } = setup([]);
    districtRepo.findOne.mockResolvedValue(null);
    districtRepo.save.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { driverError: { code: '23505' } }),
    );
    expect(
      await statusOf(
        service.createDistrict({
          name: 'Yangi',
          region_id: '1',
          sato_code: '1703206',
        } as any),
      ),
    ).toBe(409);
  });

  /**
   * Mahsulot egasi: yangi tuman SOATO kodisiz qo'shilmaydi (ilgari bo'sh
   * kod NULL yozilardi) va kod tizimda takrorlanmaydi.
   */
  it.each([[undefined], [''], ['   '], [null]])(
    'createDistrict: SOATO kodi %p — 400 «majburiy», yozilmaydi',
    async (sato_code) => {
      const { service, districtRepo } = setup([]);
      const err = await errorOf(
        service.createDistrict({
          name: 'Kodsiz',
          region_id: '1',
          sato_code,
        } as CreateDistrictDto),
      );
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe('Tuman SOATO kodi majburiy');
      expect(err.data).toEqual({ reason: 'sato_code_required' });
      expect(districtRepo.create).not.toHaveBeenCalled();
      expect(districtRepo.save).not.toHaveBeenCalled();
    },
  );

  it.each([['170320'], ['17032060'], ['1703 206'], ['17O3206'], ['1703']])(
    'createDistrict: 7 raqam emas (%p) — 400 sato_code_format',
    async (sato_code) => {
      const { service, districtRepo } = setup([]);
      const err = await errorOf(
        service.createDistrict({
          name: 'Yangi',
          region_id: '1',
          sato_code,
        }),
      );
      expect(err.statusCode).toBe(400);
      expect(err.data).toEqual({ reason: 'sato_code_format' });
      expect(districtRepo.save).not.toHaveBeenCalled();
    },
  );

  it('createDistrict: kod kesiladi (trim) va yoziladi (NULL emas); jurnalda ham', async () => {
    const { service, districtRepo, activityLog } = setup([]);
    const res: any = await service.createDistrict({
      name: ' Yangi tuman ',
      region_id: '1',
      sato_code: ' 1703206 ',
    });
    expect(res.statusCode).toBe(201);
    expect(districtRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Yangi tuman',
        sato_code: '1703206',
        region_id: '1',
      }),
    );
    expect(res.data.sato_code).toBe('1703206');
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        new_value: expect.objectContaining({ sato_code: '1703206' }),
      }),
    );
  });

  it("createDistrict: rasmiy ro'yxatda yo'q, lekin viloyat prefiksi mos kod — qabul qilinadi", async () => {
    const { service, districtRepo } = setup([]);
    // 1703999 — Andijon (1703) prefiksi, sato-codes.ts da yo'q (yangi tuman).
    const res: any = await service.createDistrict({
      name: 'Yangi tuman',
      region_id: '1',
      sato_code: '1703999',
    });
    expect(res.statusCode).toBe(201);
    expect(districtRepo.save).toHaveBeenCalledTimes(1);
  });

  it('createDistrict: boshqa viloyat prefiksi — 400 region_prefix_mismatch, kutilgan prefiks bilan', async () => {
    const { service, districtRepo } = setup([]);
    // Kosonsoy (Namangan, 1714207) Andijon viloyatiga.
    const err = await errorOf(
      service.createDistrict({
        name: 'Kosonsoy',
        region_id: '1',
        sato_code: '1714207',
      }),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('1703');
    expect(err.data).toEqual({
      reason: 'region_prefix_mismatch',
      details: { expected_prefix: '1703' },
    });
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it("createDistrict: viloyatning rasmiy kodi yo'q — prefiks tekshirilmaydi", async () => {
    const { service } = setup([]);
    const res: any = await service.createDistrict({
      name: 'Yangi',
      region_id: '9',
      sato_code: '1799001',
    });
    expect(res.statusCode).toBe(201);
  });

  it('createDistrict: kod boshqa tumanda bor — 409, yozilmaydi', async () => {
    const { service, districtRepo } = setup([], {
      '1703206': { id: '77', name: 'Baliqchi', sato_code: '1703206' },
    });
    const err = await errorOf(
      service.createDistrict({
        name: 'Yangi',
        region_id: '1',
        sato_code: '1703206',
      }),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Bunday SOATO kodli tuman allaqachon mavjud');
    expect(districtRepo.findOne).toHaveBeenCalledWith({
      where: { sato_code: '1703206' },
    });
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it('createDistrict: kod viloyatda bor — 409 (himoya), yozilmaydi', async () => {
    const { service, districtRepo, regionRepo } = setup(
      [],
      {},
      {
        '1703206': { id: '5', name: 'Xato viloyat', sato_code: '1703206' },
      },
    );
    const err = await errorOf(
      service.createDistrict({
        name: 'Yangi',
        region_id: '1',
        sato_code: '1703206',
      }),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Bunday SOATO kodli viloyat allaqachon mavjud');
    expect(regionRepo.findOne).toHaveBeenCalledWith({
      where: { sato_code: '1703206' },
    });
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it('updateDistrictSatoCode: 23505 poygasi — 409', async () => {
    const { service, districtRepo } = setup([]);
    districtRepo.findOne
      .mockResolvedValueOnce({ id: '10', name: 'Baliqchi', sato_code: null })
      .mockResolvedValueOnce(null);
    districtRepo.save.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: '23505' }),
    );
    expect(
      await statusOf(
        service.updateDistrictSatoCode('10', { sato_code: '1703206' } as any),
      ),
    ).toBe(409);
  });

  /** Andijon (1) dagi tuman, Namangan (2) ga biriktirilgan (xizmat viloyati). */
  const baliqchi = () => ({
    id: '10',
    name: 'Baliqchi',
    sato_code: null,
    region_id: '1',
    assigned_region: '2',
  });

  it.each([['170320'], ['17032060'], ['abcdefg'], ['   ']])(
    'updateDistrictSatoCode: noto‘g‘ri kod (%p) — 400, yozilmaydi',
    async (sato_code) => {
      const { service, districtRepo } = setup([]);
      districtRepo.findOne.mockResolvedValueOnce(baliqchi());
      expect(
        await statusOf(service.updateDistrictSatoCode('10', { sato_code })),
      ).toBe(400);
      expect(districtRepo.save).not.toHaveBeenCalled();
    },
  );

  it('updateDistrictSatoCode: prefiks GEOGRAFIK viloyat bo‘yicha (assigned_region emas)', async () => {
    const { service, districtRepo, regionRepo } = setup([]);
    districtRepo.findOne.mockResolvedValueOnce(baliqchi());
    // Namangan (assigned_region) kodi — rad etiladi.
    const err = await errorOf(
      service.updateDistrictSatoCode('10', { sato_code: '1714207' }),
    );
    expect(err.statusCode).toBe(400);
    expect(err.data).toEqual({
      reason: 'region_prefix_mismatch',
      details: { expected_prefix: '1703' },
    });
    expect(regionRepo.findOne).toHaveBeenCalledWith({ where: { id: '1' } });
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it('updateDistrictSatoCode: o‘zidan boshqa tumanda bor — 409; o‘zi hisobga olinmaydi', async () => {
    const { service, districtRepo } = setup([], {
      '1703206': { id: '77', name: 'Eski Baliqchi', sato_code: '1703206' },
    });
    districtRepo.findOne.mockResolvedValueOnce(baliqchi());
    const err = await errorOf(
      service.updateDistrictSatoCode('10', { sato_code: '1703206' }),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Bunday SOATO kodli tuman allaqachon mavjud');
    expect(districtRepo.findOne).toHaveBeenLastCalledWith({
      where: { sato_code: '1703206', id: Not('10') },
    });
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it('updateDistrictSatoCode: kod viloyatda bor — 409', async () => {
    const { service, districtRepo } = setup(
      [],
      {},
      {
        '1703206': { id: '5', sato_code: '1703206' },
      },
    );
    districtRepo.findOne.mockResolvedValueOnce(baliqchi());
    const err = await errorOf(
      service.updateDistrictSatoCode('10', { sato_code: '1703206' }),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Bunday SOATO kodli viloyat allaqachon mavjud');
    expect(districtRepo.save).not.toHaveBeenCalled();
  });

  it('updateDistrictSatoCode: to‘g‘ri kod kesiladi va yoziladi', async () => {
    const { service, districtRepo } = setup([]);
    districtRepo.findOne.mockResolvedValueOnce(baliqchi());
    const res: any = await service.updateDistrictSatoCode('10', {
      sato_code: ' 1703206 ',
    });
    expect(res.statusCode).toBe(200);
    expect(districtRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '10', sato_code: '1703206' }),
    );
  });
});

describe('SlMjauWC — migratsiya 1716000000160', () => {
  it('takroriy kod bo‘lsa yiqilmaydi: indeks DO blokida shartli yaratiladi', async () => {
    const queries: string[] = [];
    const qr = { query: jest.fn((sql: string) => queries.push(sql)) };
    await new DistrictSatoCodeUnique1716000000160('lg_test').up(qr as any);
    const sql = queries.join('\n');
    expect(sql).toContain('HAVING count(*) > 1');
    expect(sql).toContain('RAISE WARNING');
    expect(sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${DISTRICT_SATO_UNIQUE_INDEX}"[\\s\\S]*"lg_test"\\."districts"[\\s\\S]*"is_deleted" = false`,
      ),
    );
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);

    queries.length = 0;
    await new DistrictSatoCodeUnique1716000000160('lg_test').down(qr as any);
    expect(queries[0]).toContain(
      `DROP INDEX IF EXISTS "lg_test"."${DISTRICT_SATO_UNIQUE_INDEX}"`,
    );
  });

  it('noto‘g‘ri sxema nomi rad etiladi', () => {
    expect(() => new DistrictSatoCodeUnique1716000000160('x"; drop')).toThrow();
  });
});
