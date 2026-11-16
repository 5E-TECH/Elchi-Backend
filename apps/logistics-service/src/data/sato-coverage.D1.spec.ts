import { regions } from './regions-districts.data';
import { satoRegions } from './sato-codes';

/**
 * D1 — seed (`regions-districts.data.ts`) rasmiy SOATO (`sato-codes.ts`)
 * ning HAR birligini qamrashi kerak yoki u shu ro'yxatda ATAYLAB
 * chiqarilgan bo'lishi kerak.
 *
 * Seed servis har ishga tushganda yetishmagan tumanni qo'shadi
 * (`onModuleInit`): MAVJUD viloyatga qo'shilgan qator filialga avtomatik
 * biriktiriladi va `assignment_review_required` belgisini oladi (D1, ega
 * qarori 2026-11-14 — docs/ai/DISTRICT_GAP_D1.md). 25 birlikning hammasi
 * seed'da; yangi rasmiy birlik paydo bo'lsa — seed'ga qo'shing yoki shu
 * ro'yxatga sababi bilan yozing.
 */
const PENDING_OPS_DECISION: Readonly<Record<string, string>> = {};

const seedCodes = new Set(
  regions.flatMap((r) => r.districts.map((d) => d.sato_code)),
);
const official = satoRegions.flatMap((r) => r.districts);

describe('D1: seed rasmiy SOATO birliklarini qamraydi', () => {
  it('rasmiy ro‘yxat 206 birlik', () => {
    expect(official).toHaveLength(206);
  });

  it('har rasmiy birlik seed’da bor yoki PENDING_OPS_DECISION da', () => {
    const missing = official
      .filter((d) => !seedCodes.has(d.sato_code))
      .filter((d) => !(d.sato_code in PENDING_OPS_DECISION))
      .map((d) => `${d.sato_code} ${d.name}`);
    expect(missing).toEqual([]);
  });

  it('seed’ga qo‘shilgan birlik PENDING ro‘yxatidan olib tashlangan', () => {
    const stale = Object.keys(PENDING_OPS_DECISION).filter((c) =>
      seedCodes.has(c),
    );
    expect(stale).toEqual([]);
  });

  it('PENDING kodlari rasmiy ro‘yxatda va nomlari mos', () => {
    for (const [code, name] of Object.entries(PENDING_OPS_DECISION)) {
      expect(official.find((d) => d.sato_code === code)?.name).toBe(name);
    }
  });

  it('seed’da rasmiy bo‘lmagan kod yo‘q', () => {
    const officialCodes = new Set(official.map((d) => d.sato_code));
    const extra = [...seedCodes].filter(
      (c) => c !== null && !officialCodes.has(c),
    );
    expect(extra).toEqual([]);
  });
});
