import { regions } from './regions-districts.data';
import { satoRegions } from './sato-codes';

/**
 * D1 — seed (`regions-districts.data.ts`) rasmiy SOATO (`sato-codes.ts`)
 * ning HAR birligini qamrashi kerak yoki u shu ro'yxatda ATAYLAB
 * chiqarilgan bo'lishi kerak.
 *
 * ⚠️ Seed servis har ishga tushganda yetishmagan tumanni filial
 * biriktirishisiz qo'shadi (`onModuleInit`). Shuning uchun yangi qator
 * seed'ga faqat ops tasdig'idan keyin kiradi (docs/ai/DISTRICT_GAP_D1.md):
 * qaror qilingan birlik shu ro'yxatdan olib tashlanadi va seed'ga qo'shiladi
 * (yoki qayta nomlanadi) — test buni majburlaydi.
 */
const PENDING_OPS_DECISION: Readonly<Record<string, string>> = {
  '1708212': 'Sharof Rashidov tumani',
  '1708218': 'Zomin tumani',
  '1710245': 'Shahrisabz tumani',
  '1712412': "G'ozg'on shahri",
  '1712244': 'Tomdi tumani',
  '1712248': 'Uchquduq tumani',
  '1714401': 'Namangan shahri',
  '1714229': 'Uychi tumani',
  '1722401': 'Termiz shahri',
  '1724401': 'Guliston shahri',
  '1727413': 'Bekobod shahri',
  '1727415': 'Ohangaron shahri',
  '1727424': "Yangiyo'l shahri",
  '1727253': "O'rtachirchiq tumani",
  '1730401': "Farg'ona shahri",
  '1730408': 'Quvasoy shahri',
  '1730206': "Qo'shtepa tumani",
  '1730230': "O'zbekiston tumani",
  '1733401': 'Urganch shahri',
  '1733406': 'Xiva shahri',
  '1733221': "Tuproqqal'a tumani",
  '1733223': 'Xonqa tumani',
  '1735401': 'Nukus shahri',
  '1735209': "Bo'zatov tumani",
  '1735228': 'Taxiatosh tumani',
};

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
