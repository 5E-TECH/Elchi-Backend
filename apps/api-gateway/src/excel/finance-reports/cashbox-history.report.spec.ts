import { Workbook, type Cell, type Worksheet } from 'exceljs';
import {
  buildCashboxHistoryReport,
  type CashboxHistoryReportInput,
} from './cashbox-history.report';
import { periodText } from './report-labels';

/** B1 — Kassa tarixi (.xlsx): fayl qayta o'qiladi. */

const at = (day: number, hour = 9, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, hour - 5, minute)).toISOString();

const MAIN = { id: '1', cashbox_type: 'main', user_id: '0' };

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  createdAt: at(18, 9, id),
  operation_type: 'income',
  source_type: 'courier_payment',
  payment_method: 'cash',
  amount: 100,
  balance_after: 1100,
  balance_cash_after: 1100,
  balance_card_after: 0,
  comment: null,
  cashbox_id: '1',
  cashbox: MAIN,
  ...extra,
});

/** Zanjir: boshida naqd 1000, karta 500. */
const chainRows = () => [
  row(1, {
    amount: 300,
    balance_after: 1800,
    balance_cash_after: 1300,
    balance_card_after: 500,
  }),
  row(2, {
    operation_type: 'expense',
    source_type: 'market_payment',
    payment_method: 'click',
    amount: 200,
    balance_after: 1600,
    balance_cash_after: 1300,
    balance_card_after: 300,
    comment: '=HYPERLINK("http://x")',
  }),
  row(3, {
    source_type: 'branch_to_main',
    payment_method: 'click_to_market',
    amount: 50,
    balance_after: 1650,
    balance_cash_after: 1300,
    balance_card_after: 350,
  }),
];

const build = async (extra: Partial<CashboxHistoryReportInput> = {}) => {
  const items = extra.items ?? chainRows().reverse();
  const buffer = await buildCashboxHistoryReport({
    items,
    total: items.length,
    limit: 50_000,
    filters: {
      cashbox_type: 'main',
      from_date: '2026-11-18',
      to_date: '2026-11-24',
    },
    branchNames: new Map([['5', 'Andijon filiali']]),
    now: new Date('2026-11-25T04:05:00Z'),
    ...extra,
  });
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as never);
  return {
    summary: workbook.getWorksheet('Xulosa')!,
    list: workbook.getWorksheet('Harakatlar')!,
  };
};

/** `cell.value` 0 natijani tashlab yuboradi (exceljs) — `cell.result`. */
const value = (cell: Cell): unknown =>
  cell.formula ? cell.result : cell.value;

/** Varaqdagi hamma matn / natija (birlashtirilgan katak bir marta). */
const texts = (ws: Worksheet): unknown[] => {
  const out: unknown[] = [];
  ws.eachRow((r) =>
    r.eachCell((cell) => {
      if (cell.master === cell) out.push(value(cell));
    }),
  );
  return out;
};

const rowOf = (ws: Worksheet, label: string): number => {
  let found = 0;
  ws.eachRow((r, n) => {
    if (!found && value(r.getCell(2)) === label) found = n;
  });
  return found;
};

describe('B1 — Kassa tarixi', () => {
  it("harakatlar eskidan yangiga: haqiqiy son va sana, o'zbekcha yorliq, JAMI formula", async () => {
    const { list } = await build();
    expect(list.getRow(6).values).toEqual(
      expect.arrayContaining([
        '№',
        'Sana',
        'Kassa',
        'Amal turi',
        'Manba',
        "To'lov usuli",
        "Kirim, so'm",
        "Chiqim, so'm",
        "Balans, so'm",
        "Naqd balans, so'm",
        "Karta balans, so'm",
        'Izoh',
      ]),
    );
    // Toshkent vaqti (UTC 04:01 → 09:01).
    expect((list.getCell('C7').value as Date).toISOString()).toBe(
      '2026-11-18T09:01:00.000Z',
    );
    expect(list.getCell('D7').value).toBe('Asosiy kassa');
    expect(list.getCell('E7').value).toBe('Kirim');
    expect(list.getCell('F7').value).toBe("Kuryer to'lovi");
    expect(list.getCell('G8').value).toBe('Karta (Click)');
    expect(list.getCell('F9').value).toBe("Filialdan marketga o'tkazma");
    expect(list.getCell('H7').value).toBe(300);
    expect(list.getCell('H8').value).toBeNull();
    expect(list.getCell('I8').value).toBe(200);
    expect(list.getCell('J9').value).toBe(1650);
    expect(list.getCell('H10').value).toMatchObject({
      formula: 'SUM(H7:H9)',
      result: 350,
    });
    // Formula ko'rinishidagi izoh — matn bo'lib qoladi.
    expect(list.getCell('M8').value).toBe('=HYPERLINK("http://x")');
    expect(list.autoFilter).toBeTruthy();
    expect(list.views[0]).toMatchObject({ state: 'frozen', ySplit: 6 });
  });

  it('bitta kassa, faqat davr filtri — qoldiq va «Mos keldi» nazorati', async () => {
    const { summary } = await build();
    expect(value(summary.getCell('B10'))).toBe(1500);
    expect(value(summary.getCell('E10'))).toBe(350);
    expect(value(summary.getCell('H10'))).toBe(200);
    expect(value(summary.getCell('K10'))).toBe(1650);
    const q = rowOf(summary, "Boshlang'ich qoldiq");
    expect(
      ['E', 'H', 'K'].map((c) => value(summary.getCell(`${c}${q}`))),
    ).toEqual([1000, 500, 1500]);
    const total = rowOf(summary, 'Oxirgi qoldiq');
    expect(
      ['E', 'H', 'K'].map((c) => value(summary.getCell(`${c}${total}`))),
    ).toEqual([1300, 350, 1650]);
    const note = summary.getCell(`B${total + 1}`);
    expect(value(note)).toMatch(/^Mos keldi/);
    expect((note.value as { formula: string }).formula).toContain('ROUND(');
    expect(note.font.color?.argb).toBe('FF12704F');
    // Manba bo'yicha — jami formulalari bilan.
    const t = rowOf(summary, 'JAMI');
    expect(value(summary.getCell(`G${t}`))).toBe(350);
    expect(value(summary.getCell(`I${t}`))).toBe(200);
    expect(value(summary.getCell(`K${t}`))).toBe(150);
  });

  it('zanjir uzilgan — sariq «Mos kelmadi: farq …» (yashirilmaydi)', async () => {
    const rows = chainRows();
    rows[2].balance_after = 1640;
    const { summary } = await build({ items: rows });
    const note = summary.getCell(`B${rowOf(summary, 'Oxirgi qoldiq') + 1}`);
    expect(value(note)).toBe('Mos kelmadi: farq 10');
    expect(note.font.color?.argb).toBe('FF95560A');
  });

  it("naqd ↔ karta o'tkazmasi (tarixda qator yo'q) alohida qatorda, jami mos", async () => {
    const rows = chainRows();
    // 2- va 3-qator orasida 400 naqd kartaga o'tkazilgan.
    Object.assign(rows[2], {
      balance_cash_after: 900,
      balance_card_after: 750,
    });
    const { summary } = await build({ items: rows });
    const m = rowOf(summary, "Naqd ↔ karta o'tkazmasi");
    expect(m).toBeGreaterThan(0);
    expect(
      ['E', 'H', 'K'].map((c) => value(summary.getCell(`${c}${m}`))),
    ).toEqual([-400, 400, 0]);
    const total = rowOf(summary, 'Oxirgi qoldiq');
    expect(
      ['E', 'H', 'K'].map((c) => value(summary.getCell(`${c}${total}`))),
    ).toEqual([900, 750, 1650]);
    expect(value(summary.getCell(`B${total + 1}`))).toMatch(/^Mos keldi/);
  });

  it("bir vaqtdagi amallar: zanjir createdAt emas, yozilish tartibidan — soxta farq yo'q", async () => {
    const rows = chainRows();
    // 3-qator tranzaksiyasi 1-qatordan OLDIN boshlangan, lekin keyin yozilgan.
    rows[2].createdAt = at(18, 8);
    const { summary, list } = await build({ items: rows });
    expect(list.getCell('H7').value).toBe(50); // ro'yxat — sana bo'yicha
    expect(value(summary.getCell('B10'))).toBe(1500);
    expect(value(summary.getCell('K10'))).toBe(1650);
    expect(
      value(summary.getCell(`B${rowOf(summary, 'Oxirgi qoldiq') + 1}`)),
    ).toMatch(/^Mos keldi/);
  });

  it.each([
    ['amal turi', { operation_type: 'income' }],
    ['manba', { source_type: 'sell' }],
    ['manbalar', { sourceTypes: 'sell,cancel' }],
    ['qarshi tomon', { source_user_id: '7' }],
  ])('%s filtri bilan qoldiq bloki chiqmaydi', async (_name, filter) => {
    const { summary } = await build({
      filters: { cashbox_id: '1', ...filter },
    });
    const all = texts(summary).map(String);
    expect(all).not.toContain("Boshlang'ich qoldiq, so'm");
    expect(all.some((t) => /Mos kel|Qoldiq harakati/.test(t))).toBe(false);
    expect(all).toContain("Kirim − chiqim, so'm");
  });

  it('bir nechta kassa — qoldiq bloki yo`q, kassa nomi va ID har qatorda', async () => {
    const { summary, list } = await build({
      filters: {},
      items: [
        ...chainRows(),
        row(4, {
          cashbox_id: '12',
          cashbox: { cashbox_type: 'branch', user_id: '5' },
        }),
        row(5, {
          cashbox_id: '13',
          cashbox: { cashbox_type: 'branch', user_id: '9' },
        }),
        row(6, {
          cashbox_id: '14',
          cashbox: {
            cashbox_type: 'couriers',
            user_id: '77',
            user: { name: 'Vali Aliyev' },
          },
        }),
      ],
    });
    expect(texts(summary).map(String)).not.toContain('Qoldiq harakati');
    expect(
      ['D7', 'D10', 'D11', 'D12'].map((c) => list.getCell(c).value),
    ).toEqual([
      'Asosiy kassa · #1',
      'Andijon filiali · #12',
      // Filial nomi olinmagan (fail-open).
      'Filial #9 · #13',
      'Vali Aliyev · #14',
    ]);
    // Filial kassasida kuryer to'lovi boshqacha ataladi.
    expect(list.getCell('F10').value).toBe("Kuryerdan filialga o'tkazma");
  });

  it('filial kassasi — naqd / karta ajratmasi yo`q, faqat jami', async () => {
    const cashbox = { cashbox_type: 'branch', user_id: '5' };
    const { summary } = await build({
      filters: { cashbox_id: '1' },
      items: [
        row(1, {
          cashbox,
          payment_method: 'click',
          amount: 300,
          balance_after: 900,
          balance_cash_after: 900,
        }),
        row(2, {
          cashbox,
          operation_type: 'expense',
          amount: 100,
          balance_after: 800,
          balance_cash_after: 800,
        }),
      ],
    });
    const all = texts(summary).map(String);
    expect(all).not.toContain("Naqd, so'm");
    const total = rowOf(summary, 'Oxirgi qoldiq');
    expect(value(summary.getCell(`K${total}`))).toBe(800);
    expect(value(summary.getCell(`B${total + 1}`))).toMatch(/^Mos keldi/);
  });

  it('chegaradan ko`p — DIQQAT, eng so`nggi qatorlar, qoldiq bloki yo`q', async () => {
    const { summary, list } = await build({ limit: 2, total: 61_204 });
    const all = texts(summary).map(String);
    expect(
      all.some((t) =>
        t.startsWith(
          "DIQQAT: jami 61 204 ta harakat, faylda eng so'nggi 2 tasi",
        ),
      ),
    ).toBe(true);
    expect(all).not.toContain('Qoldiq harakati');
    // Eng eski qator tushib qoladi.
    expect(list.getCell('I7').value).toBe(200);
    expect(list.getCell('H8').value).toBe(50);
    expect(list.getCell('B9').value).toBe('JAMI');
  });

  it('eski yozuvda ajratma NULL — bo`sh katak (soxta 0 emas)', async () => {
    const { list, summary } = await build({
      items: [row(1, { balance_cash_after: null, balance_card_after: null })],
    });
    expect(list.getCell('K7').value).toBeNull();
    expect(list.getCell('L7').value).toBeNull();
    expect(texts(summary).map(String)).not.toContain("Naqd, so'm");
  });

  it('bo`sh davr — fayl ochiladi, formulasiz', async () => {
    const { summary, list } = await build({ items: [] });
    expect(list.getCell('B7').value).toBe("Harakat yo'q");
    expect(value(summary.getCell('E10'))).toBe(0);
    expect(texts(summary).map(String)).not.toContain('Qoldiq harakati');
  });
});

describe('davr matni', () => {
  it.each([
    ['2026-11-18', '2026-11-24', '18.11 — 24.11.2026'],
    ['2025-12-30', '2026-01-02', '30.12.2025 — 02.01.2026'],
    ['2026-11-24', '2026-11-24', '24.11.2026'],
    ['2026-11-24', undefined, '24.11.2026 dan'],
    [undefined, '2026-11-24', '24.11.2026 gacha'],
    [undefined, undefined, 'Butun davr'],
    // Kun chegarasidagi lahza — faqat sana.
    [
      '2026-11-01T00:00:00+05:00',
      '2026-11-24T23:59:59.999+05:00',
      '01.11 — 24.11.2026',
    ],
    [
      '2026-11-24T03:00:00Z',
      '2026-11-24T15:30:00Z',
      '24.11.2026 08:00 — 24.11.2026 20:30',
    ],
  ])('%s … %s → %s', (from, to, expected) => {
    expect(periodText(from, to)).toBe(expected);
  });
});
