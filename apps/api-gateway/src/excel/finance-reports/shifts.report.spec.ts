import { Workbook, type Cell, type Worksheet } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import { buildShiftsReport, type ShiftsReportInput } from './shifts.report';

/** B2 — Smenalar (.xlsx): fayl qayta o'qiladi. */

const at = (day: number, hour: number) =>
  new Date(Date.UTC(2026, 10, day, hour - 5)).toISOString();

const shift = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  status: 'closed',
  cashbox_user_id: '0',
  opened_at: at(id, 8),
  closed_at: at(id, 20),
  opened_by: '3',
  opened_by_name: 'Dilnoza Karimova',
  opened_by_system: false,
  closed_by: '4',
  closed_by_name: 'Ali Valiyev',
  closed_by_system: false,
  opening_balance_cash: 1000,
  opening_balance_card: 500,
  total_income_cash: 300,
  total_income_card: 200,
  total_expense_cash: 100,
  total_expense_card: 50,
  closing_balance_cash: 1200,
  closing_balance_card: 650,
  discrepancy_cash: 0,
  discrepancy_card: 0,
  comment: null,
  ...extra,
});

const build = async (
  items: Array<Record<string, unknown>>,
  extra: Partial<ShiftsReportInput> = {},
) => {
  const buffer = await buildShiftsReport({
    items,
    total: items.length,
    limit: 50_000,
    filters: { from_date: '2026-11-01', to_date: '2026-11-25' },
    branchNames: new Map([['5', 'Andijon filiali']]),
    now: new Date('2026-11-25T04:10:00Z'),
    ...extra,
  });
  const workbook = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await workbook.xlsx.load(buffer as never);
  return {
    summary: workbook.getWorksheet('Xulosa')!,
    list: workbook.getWorksheet('Smenalar')!,
  };
};

/** `cell.value` 0 natijani tashlab yuboradi (exceljs) — `cell.result`. */
const value = (cell: Cell): unknown =>
  cell.formula ? cell.result : cell.value;
const cells = (ws: Worksheet, r: number, columns: string) =>
  [...columns].map((c) => value(ws.getCell(`${c}${r}`)));
const texts = (ws: Worksheet): string[] => {
  const out: string[] = [];
  ws.eachRow((r) =>
    r.eachCell((cell) => {
      const v = value(cell);
      if (cell.master === cell && typeof v === 'string') out.push(v);
    }),
  );
  return out;
};

describe('B2 — Smenalar', () => {
  it('ustunlar: Kassa, Ochgan, Yopgan; naqd / karta guruhlari; eskidan yangiga', async () => {
    const { list } = await build([shift(2), shift(1)]);
    expect(list.getCell('I6').value).toBe("NAQD, SO'M");
    expect(list.getCell('N6').value).toBe("KARTA, SO'M");
    expect(list.getRow(7).values).toEqual([
      undefined,
      undefined,
      'ID',
      'Kassa',
      'Ochilgan',
      'Ochgan',
      'Yopilgan',
      'Yopgan',
      'Holat',
      'Ochilish',
      'Kirim',
      'Chiqim',
      'Yopilish',
      'Farq',
      'Ochilish',
      'Kirim',
      'Chiqim',
      'Yopilish',
      'Farq',
      'Izoh',
    ]);
    expect(list.views[0]).toMatchObject({ state: 'frozen', ySplit: 7 });
    expect(cells(list, 8, 'BCEGHIJKLMNOPQR')).toEqual([
      1,
      'Asosiy kassa',
      'Dilnoza Karimova',
      'Ali Valiyev',
      'Yopilgan',
      1000,
      300,
      100,
      1200,
      0,
      500,
      200,
      50,
      650,
      0,
    ]);
    expect((list.getCell('D8').value as Date).toISOString()).toBe(
      '2026-11-01T08:00:00.000Z',
    );
    expect(list.getCell('J10').value).toMatchObject({
      formula: 'SUM(J8:J9)',
      result: 600,
    });
  });

  it('tizim ochgan / yopgan — «Tizim»; ism yo`q — #id; filial nomi; nomi olinmagan filial — #id', async () => {
    const { list } = await build([
      shift(1, {
        opened_by: null,
        opened_by_name: null,
        opened_by_system: true,
        closed_by: null,
        closed_by_name: null,
        closed_by_system: true,
      }),
      shift(2, { opened_by_name: null, cashbox_user_id: '5' }),
      shift(3, { cashbox_user_id: '9' }),
      shift(4, { cashbox_user_id: null }),
    ]);
    expect(cells(list, 8, 'CEG')).toEqual(['Asosiy kassa', 'Tizim', 'Tizim']);
    expect(cells(list, 9, 'CE')).toEqual(['Andijon filiali', '#3']);
    expect(list.getCell('C10').value).toBe('Filial #9');
    expect(list.getCell('C11').value).toBe('Asosiy kassa');
  });

  it('sanalmagan — «Sanalmadi», soxta kamomad yo`q; farq faqat discrepancy_* dan', async () => {
    const { list, summary } = await build([
      shift(1, {
        closing_balance_cash: 0,
        closing_balance_card: 0,
        discrepancy_cash: null,
        discrepancy_card: null,
      }),
      shift(2, { closing_balance_cash: 1150, discrepancy_cash: -50 }),
      shift(3, { closing_balance_card: 660, discrepancy_card: 10 }),
    ]);
    expect(cells(list, 8, 'LMQR')).toEqual([
      'Sanalmadi',
      null,
      'Sanalmadi',
      null,
    ]);
    expect(list.getCell('M9').value).toBe(-50);
    expect(cells(summary, 9, 'BEHK')).toEqual([3, 1500, 450, -50]);
    expect(value(summary.getCell('K10'))).toBe('1 ta holat');
    expect(value(summary.getCell('B10'))).toBe('3 yopilgan · 0 ochiq');
    expect(texts(summary)).toContain('3 ta smena'); // farqli va sanalmagan
    expect(texts(summary)).toContain('Sanalmadi');
  });

  it('ochiq smena — yopilish / farq bo`sh, hali yozilmagan yig`indi 0 bo`lib chiqmaydi', async () => {
    const { list, summary } = await build([
      shift(1, {
        status: 'open',
        closed_at: null,
        closed_by: null,
        closed_by_name: null,
        total_income_cash: 0,
        total_income_card: 0,
        total_expense_cash: 0,
        total_expense_card: 0,
        closing_balance_cash: 0,
        closing_balance_card: 0,
        discrepancy_cash: null,
        discrepancy_card: null,
      }),
    ]);
    expect(cells(list, 8, 'FGHIJKLM')).toEqual([
      null,
      null,
      'Ochiq',
      1000,
      null,
      null,
      null,
      null,
    ]);
    expect(texts(summary)).toContain("Farqli smena yo'q");
    expect(value(summary.getCell('B10'))).toBe('0 yopilgan · 1 ochiq');
  });

  it('filial smenasi (bitta jami): karta ustunlari bo`sh — «Sanalmadi» emas; eslatma bor', async () => {
    const { list, summary } = await build([
      shift(1, {
        cashbox_user_id: '5',
        opening_balance_card: 0,
        total_income_card: 0,
        total_expense_card: 0,
        closing_balance_card: 0,
        discrepancy_card: null,
        closing_balance_cash: 1100,
        discrepancy_cash: -100,
      }),
    ]);
    expect(cells(list, 8, 'NOPQR')).toEqual([null, null, null, null, null]);
    expect(texts(list)).not.toContain('Sanalmadi');
    expect(
      texts(summary).some((t) => t.startsWith('Filial smenasi bitta jami')),
    ).toBe(true);
    expect(texts(summary)).toContain('Andijon filiali');
  });

  it('171 dan oldingi smena: farq yo`q, sanalgan summa bor — summa ko`rinadi', async () => {
    const { list } = await build([
      shift(1, { discrepancy_cash: null, discrepancy_card: null }),
    ]);
    expect(cells(list, 8, 'LMQR')).toEqual([1200, null, 650, null]);
  });

  it('chegaradan ko`p — DIQQAT va eng so`nggi smenalar', async () => {
    const { list, summary } = await build([shift(1), shift(2), shift(3)], {
      limit: 2,
    });
    expect(
      texts(summary).some((t) => t.startsWith('DIQQAT: jami 3 ta smena')),
    ).toBe(true);
    expect(cells(list, 8, 'B')).toEqual([2]);
    expect(cells(list, 9, 'B')).toEqual([3]);
  });

  it('farqli smena juda ko`p — oxirgi 200 tasi va ochiq eslatma', async () => {
    const many = Array.from({ length: 205 }, (_, i) =>
      shift(i + 1, {
        opened_at: new Date(1_780_000_000_000 + i * 3_600_000).toISOString(),
        closed_at: new Date(1_780_000_000_000 + i * 3_700_000).toISOString(),
        discrepancy_cash: -1,
      }),
    );
    const { summary } = await build(many);
    expect(texts(summary)).toContain(
      "Eng so'nggi 200 tasi ko'rsatildi, qolgan 5 tasi — «Smenalar» varag'ida.",
    );
  });

  it('bo`sh davr — fayl ochiladi', async () => {
    const { list, summary } = await build([], { filters: { status: 'open' } });
    expect(list.getCell('B8').value).toBe("Smena yo'q");
    expect(texts(summary)).toContain('Ochiq');
    expect(cells(summary, 9, 'BEHK')).toEqual([0, 0, 0, 0]);
  });
});
