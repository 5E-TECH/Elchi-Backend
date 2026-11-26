import { Workbook, type Cell, type Worksheet } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import {
  buildCashboxReport,
  type CashboxReportInput,
} from './cashbox-report.report';

/** B5 (asosiy kassa) / B6 (filial kassasi) hisoboti: fayl qayta o'qiladi. */

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  createdAt: new Date(Date.UTC(2026, 10, 24, 4, id)).toISOString(),
  operation_type: 'income',
  source_type: 'courier_payment',
  source_user_id: '40',
  source_user: { name: 'Jasur Tursunov' },
  payment_method: 'cash',
  amount: 100,
  created_by: '3',
  created_by_user: { name: 'Dilnoza Karimova' },
  comment: null,
  cashbox_id: '1',
  ...extra,
});

const MAIN = { cashbox: { cashbox_type: 'main', user_id: '0' } };
const BRANCH = { cashbox: { cashbox_type: 'branch', user_id: '5' } };

/** Boshida naqd 1000, karta 500; oxirida naqd 1200, karta 450. */
const mainRows = () => [
  row(1, {
    ...MAIN,
    amount: 300,
    balance_after: 1800,
    balance_cash_after: 1300,
    balance_card_after: 500,
  }),
  row(2, {
    ...MAIN,
    source_type: 'branch_to_main',
    source_user_id: '5',
    source_user: null,
    payment_method: 'click',
    amount: 200,
    balance_after: 2000,
    balance_cash_after: 1300,
    balance_card_after: 700,
  }),
  row(3, {
    ...MAIN,
    operation_type: 'expense',
    source_type: 'market_payment',
    source_user: { name: 'Baraka Shop' },
    payment_method: 'click',
    amount: 250,
    comment: '=SUM(A1)',
    balance_after: 1750,
    balance_cash_after: 1300,
    balance_card_after: 450,
  }),
  row(4, {
    ...MAIN,
    operation_type: 'expense',
    source_type: 'manual_expense',
    source_user: null,
    source_user_id: null,
    amount: 100,
    expense_category_name: 'Ovqat',
    created_by: '99',
    created_by_user: null,
    balance_after: 1650,
    balance_cash_after: 1200,
    balance_card_after: 450,
  }),
];

const build = async (extra: Partial<CashboxReportInput> = {}) => {
  const items = extra.items ?? mainRows().reverse();
  const buffer = await buildCashboxReport({
    kind: 'main',
    items,
    total: items.length,
    limit: 50_000,
    balances: { total: 1650, cash: 1200, card: 450 },
    untilNow: true,
    period: '24.11.2026',
    branchNames: new Map([['5', 'Andijon filiali']]),
    now: new Date('2026-11-25T04:20:00Z'),
    ...extra,
  });
  const workbook = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await workbook.xlsx.load(buffer as never);
  return workbook.worksheets[0];
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
const rowOf = (ws: Worksheet, label: string): number => {
  let found = 0;
  ws.eachRow((r, n) => {
    if (found) return;
    if ([2, 3].some((c) => value(r.getCell(c)) === label)) found = n;
  });
  return found;
};

describe('B5 — asosiy kassa hisoboti', () => {
  it('kartalar, kassa harakati va «Kassa balansiga teng»', async () => {
    const ws = await build();
    expect(ws.name).toBe('Asosiy kassa');
    expect(cells(ws, 7, 'BDFHI')).toEqual([1650, 1200, 450, 500, 350]);
    expect(cells(ws, 12, 'BDEG')).toEqual(['Davr boshida', 1000, 500, 1500]);
    expect(cells(ws, 13, 'BDEG')).toEqual(['Kirim', 300, 200, 500]);
    expect(cells(ws, 14, 'BDEG')).toEqual(['Chiqim', 100, 250, 350]);
    expect(cells(ws, 15, 'BDEGH')).toEqual([
      'Davr oxirida (balans)',
      1200,
      450,
      1650,
      'Kassa balansiga teng',
    ]);
    expect((ws.getCell('H15').value as { formula: string }).formula).toContain(
      'G15-(B7)',
    );
    expect(ws.getCell('H15').font.color?.argb).toBe('FF12704F');
    // Kartalar jadval jamiga bog'langan.
    expect(ws.getCell('H7').value).toMatchObject({
      formula: `G${rowOf(ws, 'Jami kirim')}`,
    });
    expect(ws.getCell('D13').value).toMatchObject({
      formula: `D${rowOf(ws, 'Jami kirim')}`,
    });
  });

  it('kirim / chiqim: qarshi tomon (kuryer, filial, market, manba), kategoriya, kiritgan', async () => {
    const ws = await build();
    const first = rowOf(ws, 'Qayerdan') + 1;
    expect(cells(ws, first, 'BCDEFGHI')).toEqual([
      1,
      'Jasur Tursunov',
      300,
      null,
      null,
      300,
      "Kuryer to'lovi",
      'Dilnoza Karimova',
    ]);
    expect(cells(ws, first + 1, 'CDEGH')).toEqual([
      'Andijon filiali',
      null,
      200,
      200,
      "Filialdan HQ'ga o'tkazma",
    ]);
    const out = rowOf(ws, 'Qayerga') + 1;
    expect(cells(ws, out, 'CEH')).toEqual(['Baraka Shop', 250, '=SUM(A1)']);
    expect(cells(ws, out + 1, 'CDHI')).toEqual([
      "Qo'lda chiqim",
      100,
      'Ovqat',
      '#99',
    ]);
    expect(cells(ws, rowOf(ws, 'Jami chiqim'), 'DEG')).toEqual([100, 250, 350]);
    expect(texts(ws)).toEqual(
      expect.arrayContaining(['Topshirdi', 'Qabul qildi', 'Sana']),
    );
  });

  it('filial nomi olinmasa — manba yorlig`i (fail-open)', async () => {
    const ws = await build({ branchNames: new Map() });
    expect(value(ws.getCell(`C${rowOf(ws, 'Qayerdan') + 2}`))).toBe(
      "Filialdan HQ'ga o'tkazma",
    );
  });

  it('balans mos kelmasa — sariq «Mos kelmadi: farq …»', async () => {
    const ws = await build({
      balances: { total: 1580, cash: 1130, card: 450 },
    });
    expect(value(ws.getCell('H15'))).toBe('Mos kelmadi: farq 70');
    expect(ws.getCell('H15').font.color?.argb).toBe('FF95560A');
  });

  it('naqd ↔ karta o`tkazmasi alohida qatorda — soxta farq yo`q', async () => {
    const ws = await build({ balances: { total: 1650, cash: 900, card: 750 } });
    expect(cells(ws, 15, 'BDEG')).toEqual([
      "Naqd ↔ karta o'tkazmasi",
      -300,
      300,
      0,
    ]);
    expect(cells(ws, 16, 'DEGH')).toEqual([
      900,
      750,
      1650,
      'Kassa balansiga teng',
    ]);
  });

  it('o`tgan davr — hozirgi balans bilan solishtirilmaydi, u alohida aytiladi', async () => {
    const ws = await build({
      untilNow: false,
      balances: { total: 9000, cash: 8000, card: 1000 },
      shiftLabel: 'Smena №16 · 24.11 08:02 — 24.11 20:14',
    });
    expect(cells(ws, 6, 'B')).toEqual(["Davr oxirida, so'm"]);
    expect(cells(ws, 7, 'BDF')).toEqual([1650, 1200, 450]);
    expect(value(ws.getCell('H15'))).toBe(
      'Oxirgi operatsiyadan keyingi qoldiq',
    );
    const all = texts(ws);
    expect(all).not.toContain('Kassa balansiga teng');
    expect(all).toContain('Smena №16 · 24.11 08:02 — 24.11 20:14');
    expect(all).toContain(
      "Hozirgi kassa balansi (25.11.2026 09:20 holatiga): 9 000 so'm — naqd 8 000, karta 1 000.",
    );
  });

  it('o`tgan davrda ham zanjir farqi yashirilmaydi', async () => {
    const rows = mainRows();
    rows[3].balance_after = 1640;
    const ws = await build({ items: rows, untilNow: false });
    expect(value(ws.getCell('H15'))).toBe('Mos kelmadi: farq 10');
  });

  it('marketga o`tkazma — «Boshqa» ustuni va izohi; qoldiq o`zgarmaydi', async () => {
    const rows = [
      ...mainRows(),
      row(5, {
        ...MAIN,
        source_type: 'branch_to_main',
        source_user: null,
        source_user_id: '5',
        payment_method: 'click_to_market',
        amount: 70,
        balance_after: 1720,
        balance_cash_after: 1200,
        balance_card_after: 520,
      }),
      row(6, {
        ...MAIN,
        operation_type: 'expense',
        source_type: 'market_payment',
        payment_method: 'click_to_market',
        amount: 70,
        balance_after: 1650,
        balance_cash_after: 1200,
        balance_card_after: 450,
      }),
    ];
    const ws = await build({ items: rows });
    expect(cells(ws, 13, 'F')).toEqual([70]);
    expect(cells(ws, 15, 'DEFGH')).toEqual([
      1200,
      450,
      0,
      1650,
      'Kassa balansiga teng',
    ]);
    expect(texts(ws).some((t) => t.startsWith('«Boshqa»'))).toBe(true);
  });

  it("⭐ 2026-11-26: «Filiallar orqali marketlarga» — menejer to'lovlari alohida (balansga kirmaydi); qaytarilgani belgilangan", async () => {
    const branchRow = (id: number, extra: Record<string, unknown>) =>
      row(id, {
        operation_type: 'expense',
        source_type: 'market_payment',
        cashbox_id: '21',
        cashbox: { cashbox_type: 'branch', user_id: '5' },
        source_user: { name: 'Baraka Shop' },
        created_by_user: { name: 'Filial menejeri' },
        ...extra,
      });
    const ws = await build({
      branchMarketItems: [
        branchRow(11, {
          payment_method: 'click_to_market',
          amount: 300,
          route: {
            variant: 'courier_click_branch',
            cashbox_type: 'branch',
            branch_id: '5',
            courier: { id: '209', name: 'Ali Valiyev' },
            market: { id: '77', name: 'Baraka Shop' },
          },
        }),
        branchRow(12, {
          payment_method: 'cash',
          amount: 200,
          route: {
            variant: 'market_branch',
            cashbox_type: 'branch',
            branch_id: '5',
            courier: null,
            market: { id: '77', name: 'Baraka Shop' },
          },
          correction: {
            role: 'original',
            action: 'reverse',
            related_history_id: '13',
          },
        }),
      ],
    });
    const all = texts(ws);
    expect(all).toEqual(
      expect.arrayContaining([
        'Filiallar orqali marketlarga',
        "2 ta to'lov",
        "Kuryer Ali Valiyev → Baraka Shop (o'tkazma, Andijon filiali menejeri yozgan)",
        "Kuryer Ali Valiyev o'tkazmasi",
        'Andijon filiali kassasi → Baraka Shop',
        "Filial kassasidan to'lov · Qaytarilgan",
        'Filial menejeri',
      ]),
    );
    expect(
      all.some((t) =>
        t.startsWith("Bu bo'lim asosiy kassa balansiga kirmaydi"),
      ),
    ).toBe(true);
    // Bo'lim jami — 500, asosiy kassa kartalari (kirim / chiqim) o'zgarmaydi.
    const section = rowOf(ws, 'Filiallar orqali marketlarga');
    let total: unknown = null;
    ws.eachRow((r, n) => {
      if (n > section && value(r.getCell(3)) === "Jami (ma'lumot uchun)") {
        total = value(r.getCell(7));
        expect(r.getCell(7).formula).toMatch(/^SUM\(G\d+:G\d+\)$/);
      }
    });
    expect(total).toBe(500);
    expect(cells(ws, 15, 'DEFGH')).toEqual(cells(await build(), 15, 'DEFGH'));
  });

  it('2026-11-26: bo`lim berilmasa / bo`sh — chizilmaydi; teskari qator izohida «Qaytarish (#…)»', async () => {
    expect(texts(await build())).not.toContain('Filiallar orqali marketlarga');
    expect(texts(await build({ branchMarketItems: [] }))).not.toContain(
      'Filiallar orqali marketlarga',
    );
    const rows: Array<Record<string, unknown>> = mainRows();
    rows[2] = {
      ...rows[2],
      correction: {
        role: 'original',
        action: 'reverse',
        related_history_id: '9',
      },
    };
    const all = texts(await build({ items: rows }));
    expect(all.some((t) => t.endsWith(' · Qaytarilgan'))).toBe(true);
  });

  it('chegaradan ko`p — DIQQAT, balans nazorati chiqmaydi', async () => {
    const ws = await build({ limit: 2, total: 51_000 });
    const all = texts(ws);
    expect(
      all.some((t) => t.startsWith('DIQQAT: jami 51 000 ta operatsiya')),
    ).toBe(true);
    expect(all).not.toContain('Kassa harakati');
    expect(all.some((t) => /Mos kel|balansiga teng/.test(t))).toBe(false);
  });

  it('bugun amal yo`q — qoldiqlar joriy, jadvallar «Operatsiya yo`q»', async () => {
    const ws = await build({ items: [] });
    expect(cells(ws, 7, 'BDFHI')).toEqual([1650, 1200, 450, 0, 0]);
    expect(cells(ws, 15, 'DEGH')).toEqual([
      1200,
      450,
      1650,
      'Kassa balansiga teng',
    ]);
    expect(texts(ws).filter((t) => t === "Operatsiya yo'q")).toHaveLength(2);
  });

  it('o`tgan davrda amal yo`q — davrdan oldingi qoldiq; u olinmasa — «—»', async () => {
    const known = await build({
      items: [],
      untilNow: false,
      previous: { total: 800, cash: 500, card: 300 },
    });
    expect(cells(known, 7, 'BDF')).toEqual([800, 500, 300]);
    const unknown = await build({ items: [], untilNow: false, previous: null });
    expect(cells(unknown, 7, 'BDF')).toEqual(['—', '—', '—']);
    expect(texts(unknown)).not.toContain('Kassa harakati');
  });
});

describe('B6 — filial kassasi hisoboti (bitta jami)', () => {
  const branchRows = () => [
    row(1, {
      ...BRANCH,
      amount: 300,
      balance_after: 800,
      balance_cash_after: 800,
      balance_card_after: 0,
    }),
    row(2, {
      ...BRANCH,
      payment_method: 'click',
      amount: 100,
      balance_after: 900,
      balance_cash_after: 900,
      balance_card_after: 0,
    }),
    row(3, {
      ...BRANCH,
      operation_type: 'expense',
      source_type: 'branch_to_main',
      source_user_id: '5',
      source_user: null,
      amount: 600,
      balance_after: 300,
      balance_cash_after: 300,
      balance_card_after: 0,
    }),
  ];
  const buildBranch = (extra: Partial<CashboxReportInput> = {}) =>
    build({
      kind: 'branch',
      branchName: 'Andijon',
      items: branchRows(),
      balances: { total: 300, cash: null, card: null },
      ...extra,
    });

  it('balans bitta jami, «Mos keldi»; usul ustunlari qoladi (Q2)', async () => {
    const ws = await buildBranch();
    expect(ws.name).toBe('Filial kassasi');
    const all = texts(ws);
    expect(all).toContain('Andijon kassasi');
    expect(all).toContain('Filial kassasi hisoboti');
    expect(all).not.toContain("Naqd qoldiq, so'm");
    expect(all).not.toContain("Karta qoldiq, so'm");
    expect(all).not.toContain('Kassa harakati');
    expect(cells(ws, 7, 'BDFHI')).toEqual([300, 500, 400, 600, -200]);
    expect(value(ws.getCell('B10'))).toBe(
      'Mos keldi: davr boshi + kirim − chiqim = kassa balansi',
    );
    const first = rowOf(ws, 'Qayerdan') + 1;
    expect(cells(ws, first, 'CDEH')).toEqual([
      'Jasur Tursunov',
      300,
      null,
      "Kuryerdan filialga o'tkazma",
    ]);
    expect(cells(ws, first + 1, 'DE')).toEqual([null, 100]);
    // Filial o'z faylida HQ o'tkazmasini manba yorlig'i bilan ko'radi.
    expect(value(ws.getCell(`C${rowOf(ws, 'Qayerga') + 1}`))).toBe(
      "Filialdan HQ'ga o'tkazma",
    );
    expect(all).toContain('Filial menejeri');
  });

  it('balans mos kelmasa — sariq eslatma', async () => {
    const ws = await buildBranch({
      balances: { total: 250, cash: null, card: null },
    });
    expect(value(ws.getCell('B10'))).toBe('Mos kelmadi: farq 50');
    expect(ws.getCell('B10').font.color?.argb).toBe('FF95560A');
  });

  it('o`tgan davr — nazorat chiqmaydi; hozirgi balans bitta jami', async () => {
    const ws = await buildBranch({
      untilNow: false,
      balances: { total: 7777, cash: null, card: null },
    });
    const all = texts(ws);
    expect(all.some((t) => /^Mos kel/.test(t))).toBe(false);
    expect(all).toContain(
      "Hozirgi kassa balansi (25.11.2026 09:20 holatiga): 7 777 so'm.",
    );
    expect(cells(ws, 7, 'B')).toEqual([300]);
  });

  it('filial nomi olinmasa — «Filial kassasi»', async () => {
    const ws = await buildBranch({ branchName: null });
    expect(texts(ws)).toContain('Filial kassasi');
  });
});
