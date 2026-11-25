import { Workbook, type Cell, type Worksheet } from 'exceljs';
import {
  buildFinancialBalanceReport,
  type FinancialBalanceReportInput,
} from './financial-balance.report';

/** B3 — Moliyaviy balans daftari (.xlsx): fayl qayta o'qiladi. */

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  createdAt: new Date(Date.UTC(2026, 10, 18, 4, id)).toISOString(),
  source_type: 'sell_profit',
  amount: 100,
  balance_before: 0,
  balance_after: 100,
  comment: null,
  created_by: null,
  order_id: null,
  ...extra,
});

const ledger = () => [
  row(1, { balance_before: 1000, balance_after: 1100, order_id: '48211' }),
  row(2, {
    source_type: 'manual_expense',
    amount: -300,
    balance_before: 1100,
    balance_after: 800,
    expense_category: 'fuel',
    comment: '=1+1',
    created_by: '7',
  }),
  row(3, {
    source_type: 'cancel_extra_cost',
    amount: -50,
    balance_before: 800,
    balance_after: 750,
  }),
  row(4, {
    source_type: 'correction',
    amount: -100,
    balance_before: 750,
    balance_after: 650,
  }),
];

const build = async (extra: Partial<FinancialBalanceReportInput> = {}) => {
  const items = extra.items ?? ledger().reverse();
  const buffer = await buildFinancialBalanceReport({
    items,
    total: items.length,
    limit: 50_000,
    filters: { from_date: '2026-11-18', to_date: '2026-11-24' },
    actors: new Map([['7', { id: '7', name: 'Ali Valiyev', role: null }]]),
    now: new Date('2026-11-25T04:15:00Z'),
    ...extra,
  });
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as never);
  return {
    summary: workbook.getWorksheet('Xulosa')!,
    list: workbook.getWorksheet('Daftar')!,
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

describe('B3 — Moliyaviy balans', () => {
  it('daftar: eskidan yangiga, haqiqiy son, sotuv / bekor manbasi farqlanadi', async () => {
    const { list } = await build();
    expect(list.getRow(6).values).toEqual([
      undefined,
      undefined,
      'ID',
      'Sana',
      'Manba',
      'Kategoriya',
      "O'zgarish, so'm",
      "Oldingi balans, so'm",
      "Keyingi balans, so'm",
      'Izoh',
      'Kim kiritgan',
      'Buyurtma ID',
    ]);
    expect(cells(list, 7, 'BDFGHJK')).toEqual([
      1,
      'Pochta foydasi',
      100,
      1000,
      1100,
      'Avtomatik',
      48211,
    ]);
    expect(cells(list, 8, 'DEFIJ')).toEqual([
      "Qo'lda chiqim",
      "Yoqilg'i",
      -300,
      '=1+1',
      'Ali Valiyev',
    ]);
    expect(list.getCell('D9').value).toBe("Qo'shimcha xarajat (bekor)");
    expect(list.getCell('F11').value).toMatchObject({
      formula: 'SUM(F7:F10)',
      result: -350,
    });
  });

  it('davr boshi / oxiri va «Mos keldi» nazorati', async () => {
    const { summary } = await build();
    expect(cells(summary, 10, 'BEHK')).toEqual([1000, 100, 450, 650]);
    expect(value(summary.getCell('B13'))).toBe(
      'Mos keldi: davr boshi + kirim − chiqim = davr oxiri',
    );
  });

  it('zanjir uzilgan — «Mos kelmadi: farq …» (yashirilmaydi)', async () => {
    const items = ledger();
    items[3].balance_after = 600;
    items[3].balance_before = 700; // o'zgarish −100, lekin zanjir 750 edi
    const { summary } = await build({ items });
    const note = summary.getCell('B13');
    expect(value(note)).toBe('Mos kelmadi: farq 50');
    expect(note.font.color?.argb).toBe('FF95560A');
  });

  it.each([
    ['manba', { source_type: 'manual_expense' }],
    ['kategoriya', { expense_category: 'fuel' }],
    ['kategoriyasiz', { expense_category: 'none' }],
  ])('%s filtri bilan qoldiq va nazorat chiqmaydi', async (_name, filters) => {
    const { summary } = await build({ filters });
    const all = texts(summary);
    expect(all).not.toContain("Davr boshida, so'm");
    expect(all.some((t) => /^Mos kel/.test(t))).toBe(false);
    expect(all).toContain("Kirim − chiqim, so'm");
  });

  it('xarajat kategoriyalari — tuzatishlar kirmaydi, ulush formula bilan', async () => {
    const { summary } = await build();
    const all = texts(summary);
    expect(all).toContain('Xarajat kategoriyalari');
    expect(all).toContain('Kuryer haqi');
    let totalRow = 0;
    summary.eachRow((r, n) => {
      if (r.getCell(2).value === 'JAMI') totalRow = n;
    });
    // 300 (yoqilg'i) + 50 (kuryer haqi); tuzatish (100) yo'q.
    expect(value(summary.getCell(`G${totalRow}`))).toBe(350);
    expect(value(summary.getCell(`J${totalRow}`))).toBe(1);
  });

  it('chegaradan ko`p — DIQQAT, qoldiq bloki yo`q', async () => {
    const { summary, list } = await build({ limit: 2, total: 70_000 });
    const all = texts(summary);
    expect(
      all.some((t) =>
        t.startsWith("DIQQAT: jami 70 000 ta yozuv, faylda eng so'nggi 2 tasi"),
      ),
    ).toBe(true);
    expect(all).not.toContain("Davr boshida, so'm");
    expect(cells(list, 7, 'B')).toEqual([3]);
  });

  it('ism olinmagan — #id; bo`sh davr — fayl ochiladi', async () => {
    const named = await build({ actors: new Map() });
    expect(named.list.getCell('J8').value).toBe('#7');
    const empty = await build({ items: [] });
    expect(empty.list.getCell('B7').value).toBe("Yozuv yo'q");
    expect(texts(empty.summary)).not.toContain('Xarajat kategoriyalari');
  });
});
