/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { LogisticsServiceService } from './logistics-service.service';
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
  function setup(rows: D[], holderFor: Record<string, unknown> = {}) {
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
    const regionRepo = {
      findOne: jest.fn().mockResolvedValue(ANDIJON),
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
    return { service, districtRepo };
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

  it('createDistrict: 23505 poygasi — 409; bo‘sh kod NULL yoziladi', async () => {
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

    await service.createDistrict({
      name: 'Kodsiz',
      region_id: '1',
      sato_code: '  ',
    } as any);
    expect(districtRepo.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ sato_code: null }),
    );
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
