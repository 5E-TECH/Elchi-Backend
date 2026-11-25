import { of, throwError } from 'rxjs';
import { Workbook, type Cell, type Worksheet } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import type { ShiftReportSnapshot } from './shift-report.builders';
import { ShiftReportService } from './shift-report.service';
import { buildXlsx } from './shift-report.xlsx';

/**
 * Smena Excel'lari (tasdiqlangan dizayn A1 / A1b / A2): qiymatlar, formulalar
 * NATIJASI bilan (Quick Look / telefon 0 ko'rsatmasin), avtomatik holatlar,
 * HQ'ga topshirilgan pul qatori, bo'sh holat.
 */

const at = (time: string) => new Date(`2026-11-24T${time}:00Z`);

const main = (
  patch: Partial<ShiftReportSnapshot> = {},
): ShiftReportSnapshot => ({
  shift_id: '214',
  round: 1,
  cashbox_type: 'main',
  cashbox_user_id: '0',
  opened_at: at('03:57'),
  closed_at: at('16:34'),
  opened_by: '7',
  opened_by_name: 'Dilnoza',
  closed_by: '8',
  closed_by_name: 'Ali',
  close_reason: 'manual',
  cash: {
    opening_balance: 1_000,
    total_income: 900_000,
    total_expense: 300_000,
    expected_balance: 651_000,
    closing_balance: 651_000,
    discrepancy: 0,
  },
  card: {
    opening_balance: 2_000,
    total_income: 100_000,
    total_expense: 10_000,
    expected_balance: 42_000,
    closing_balance: 40_000,
    discrepancy: -2_000,
  },
  accounts: [
    {
      card_id: '1',
      name: 'Humo',
      last4: '4471',
      expected_balance: 42_000,
      entered_balance: 40_000,
      difference: -2_000,
      ai_status: 'mismatch',
    },
  ],
  couriers: [
    {
      courier_id: '501',
      name: null,
      count: 2,
      total: 400_000,
      received: 450_000,
      reversed: 50_000,
      remaining_debt: 70_000,
    },
  ],
  markets: [
    {
      market_id: '601',
      name: '=1+1',
      total: 200_000,
      balance: 5_000,
      payments: [
        {
          history_id: '1',
          amount: 200_000,
          payment_method: 'click_to_market',
          card_name: 'Humo •4471',
          at: at('09:00'),
        },
      ],
    },
  ],
  branches: [
    {
      branch_id: '16',
      name: 'Andijon',
      total: 300_000,
      balance: 9_000,
      payments: [
        {
          history_id: '2',
          amount: 250_000,
          payment_method: 'cash',
          at: at('08:00'),
        },
        {
          history_id: '3',
          amount: 100_000,
          payment_method: 'click',
          at: at('08:30'),
        },
        {
          history_id: '4',
          amount: -50_000,
          payment_method: 'cash',
          at: at('08:40'),
          reversed: true,
        },
      ],
    },
  ],
  between_shifts: {
    from: at('01:00'),
    to: at('03:57'),
    income: 7_000,
    expense: 3_000,
    count: 2,
  },
  ...patch,
});

const branch = (
  patch: Partial<ShiftReportSnapshot> = {},
): ShiftReportSnapshot => ({
  ...main(),
  shift_id: '213',
  cashbox_type: 'branch',
  cashbox_user_id: '16',
  cash: {
    opening_balance: 100,
    total_income: 450_000,
    total_expense: 440_000,
    expected_balance: 10_100,
    closing_balance: 10_000,
    discrepancy: -100,
  },
  card: {
    opening_balance: 0,
    total_income: 0,
    total_expense: 0,
    expected_balance: 0,
    closing_balance: 0,
    discrepancy: null,
  },
  accounts: [],
  branches: undefined,
  between_shifts: null,
  ...patch,
});

/** Formula — natijasi bilan (`cell.value` 0 natijani tashlab yuboradi). */
const plain = (cell: Cell): unknown =>
  cell.formula ? cell.result : cell.value;

const open = async (snapshot: ShiftReportSnapshot) => {
  const workbook = new Workbook();
  const file = await buildXlsx(snapshot);
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(file)).toEqual([]);
  await workbook.xlsx.load(file as never);
  return workbook;
};

/** Qatorlar: birlashtirilgan kataklar bir marta, bo'shsiz, formula — natijasi. */
const rowsOf = (sheet: Worksheet | undefined): unknown[][] => {
  const rows: unknown[][] = [];
  sheet!.eachRow((row) => {
    const values: unknown[] = [];
    row.eachCell((cell) => {
      if (cell.isMerged && cell.master !== cell) return;
      if (cell.value !== null && cell.value !== '') {
        values.push(plain(cell));
      }
    });
    if (values.length) rows.push(values);
  });
  return rows;
};

/** Hamma formula hisoblangan natija bilan yozilgan. */
const expectFormulaResults = (workbook: Workbook) => {
  let formulas = 0;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (!cell.formula) return;
        formulas += 1;
        expect([cell.address, typeof cell.result]).toEqual([
          cell.address,
          'number',
        ]);
        expect(cell.formula).not.toContain('NaN');
        expect(cell.formula).not.toContain('undefined');
      });
    });
  }
  expect(formulas).toBeGreaterThan(0);
};

describe('A1 — asosiy kassa', () => {
  it('⭐ xulosa: naqd, karta, jami; farq va holat; formulalar natijasi bilan', async () => {
    const workbook = await open(main());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Xulosa',
      'Filiallar',
      'Kuryerlar',
      'Marketlar',
      'Kartalar',
    ]);
    expectFormulaResults(workbook);
    const rows = rowsOf(workbook.getWorksheet('Xulosa'));
    expect(rows).toEqual(
      expect.arrayContaining([
        ['ELCHI POCHTA', 'Asosiy kassa — smena hisoboti', 'Smena #214'],
        ['24.11.2026 · 08:57–21:34', "Qo'lda yopilgan"],
        [
          'Ochgan',
          'Dilnoza',
          'Ochilgan',
          // Excel sanasi — Toshkent soati (03:57 UTC → 08:57).
          new Date('2026-11-24T08:57:00Z'),
        ],
        ["Ochilish qoldig'i", 1_000, 2_000, 3_000],
        ['Kirim (+)', 900_000, 100_000, 1_000_000],
        ['Chiqim (−)', 300_000, 10_000, 310_000],
        ["Naqd ↔ karta o'tkazma (±)", 50_000, -50_000, 0],
        ['Kutilgan qoldiq', 651_000, 42_000, 693_000],
        ['Sanalgan (topshirilgan)', 651_000, 40_000, 691_000],
        ['Farq', 0, -2_000, -2_000],
        ['Holat', 'Mos', 'Kamomad', 'Kamomad'],
      ]),
    );
    // Ko'rsatkichlar: sanalgan, farq, kirim, chiqim.
    expect(rows).toContainEqual([691_000, -2_000, 1_000_000, 310_000]);
    expect(rows).toContainEqual([
      "Kartada kamomad bor. Naqd pul mos. Qaysi kartada — «Kartalar» varag'ida.",
    ]);
    // Smenalar orasida: oraliq, kirim, chiqim, soni.
    expect(rows).toContainEqual([
      new Date('2026-11-24T06:00:00Z'),
      new Date('2026-11-24T08:57:00Z'),
      7_000,
      3_000,
      2,
    ]);
    // Manbalar: yalpi qabul; qaytarilgani chiqimda; qolgani — «Boshqa».
    expect(rows).toEqual(
      expect.arrayContaining([
        [
          'Filiallardan qabul',
          350_000,
          0.35,
          "Marketlarga to'lov",
          200_000,
          200 / 310,
        ],
        [
          'Kuryerlardan qabul',
          450_000,
          0.45,
          'Filialga qaytarilgan',
          50_000,
          50 / 310,
        ],
        ['Marketdan qaytgan', 0, 0, 'Kuryerga qaytarilgan', 50_000, 50 / 310],
        ['Boshqa kirim', 200_000, 0.2, 'Boshqa chiqim', 10_000, 10 / 310],
        ['JAMI', 1_000_000, 1, 'JAMI', 310_000, 1],
      ]),
    );
  });

  it('filial / market / kuryer / karta varaqlari: summa — son, `=` — matn', async () => {
    const workbook = await open(main());
    const branches = rowsOf(workbook.getWorksheet('Filiallar'));
    expect(branches).toContainEqual([
      1,
      'Andijon',
      2,
      250_000,
      100_000,
      50_000,
      300_000,
      1,
      9_000,
    ]);
    expect(branches).toContainEqual([
      new Date('2026-11-24T13:40:00Z'),
      'Naqd',
      -50_000,
      'Qaytarildi',
    ]);
    const markets = workbook.getWorksheet('Marketlar');
    expect(rowsOf(markets)).toContainEqual([
      1,
      '=1+1',
      "1 ta to'lov",
      200_000,
      5_000,
    ]);
    expect(rowsOf(markets)).toContainEqual([
      new Date('2026-11-24T14:00:00Z'),
      "Kartaga o'tkazma",
      'Humo •4471',
      200_000,
    ]);
    // Nomi `=` bilan boshlangan market — formula emas, matn.
    markets!.eachRow((row) => {
      row.eachCell((cell) => expect(cell.formula).not.toBe('1+1'));
    });
    expect(rowsOf(workbook.getWorksheet('Kuryerlar'))).toContainEqual([
      1,
      '#501',
      2,
      450_000,
      50_000,
      400_000,
      1,
      70_000,
    ]);
    expect(rowsOf(workbook.getWorksheet('Kartalar'))).toContainEqual([
      1,
      'Humo •4471',
      42_000,
      40_000,
      -2_000,
      'Mos emas',
    ]);
  });

  it('A1b: avtomatik yopilgan, sanalmagan; smenani tizim ochgan', async () => {
    const snapshot = main({
      close_reason: 'auto',
      closed_by: null,
      closed_by_name: null,
      opened_by: null,
      opened_by_name: null,
      opened_by_system: true,
      between_shifts: null,
      cash: { ...main().cash, closing_balance: 0, discrepancy: null },
      card: { ...main().card, closing_balance: 0, discrepancy: null },
      accounts: main().accounts.map((account) => ({
        ...account,
        entered_balance: null,
        difference: null,
        ai_status: 'not_required',
      })),
    });
    const workbook = await open(snapshot);
    expectFormulaResults(workbook);
    const rows = rowsOf(workbook.getWorksheet('Xulosa'));
    expect(rows).toEqual(
      expect.arrayContaining([
        ['24.11.2026 · 08:57–21:34', 'Avtomatik yopilgan'],
        [
          'Yopilish',
          'Avtomatik — 21:34, kassir yopmagan',
          'Yopilgan',
          new Date('2026-11-24T21:34:00Z'),
        ],
        [693_000, 'sanalmadi', 1_000_000, 310_000],
        ['Sanalgan (topshirilgan)', 'sanalmadi', 'sanalmadi', 'sanalmadi'],
        ['Farq', '—', '—', '—'],
        ['Holat', 'Sanalmadi', 'Sanalmadi', 'Sanalmadi'],
      ]),
    );
    expect(rows.find((row) => row[0] === 'Ochgan')?.[1]).toBe(
      'Tizim (avtomatik)',
    );
    expect(JSON.stringify(rows)).toContain(
      'Avtomatik yopildi — 21:34, kassir yopmagan. Naqd ham, kartalar ham sanalmagan',
    );
    expect(JSON.stringify(rows)).not.toContain('Smenalar orasida');
    expect(rowsOf(workbook.getWorksheet('Kartalar'))).toContainEqual([
      1,
      'Humo •4471',
      42_000,
      '—',
      '—',
      'Tasdiqlanmagan',
    ]);
  });

  it('bo‘sh va eski (kutilgan qoldiqsiz) smena ham quriladi', async () => {
    const block = {
      opening_balance: null,
      total_income: null,
      total_expense: null,
      expected_balance: null,
      closing_balance: null,
      discrepancy: null,
    };
    const workbook = await open(
      main({
        closed_at: null,
        cash: block,
        card: block,
        accounts: [],
        couriers: [],
        markets: [],
        branches: [],
        between_shifts: null,
      }),
    );
    expectFormulaResults(workbook);
    expect(workbook.worksheets.map((sheet) => sheet.name)).not.toContain(
      'Filiallar',
    );
    expect(rowsOf(workbook.getWorksheet('Xulosa'))).toContainEqual([
      'Kutilgan qoldiq',
      0,
      0,
      0,
    ]);
    expect(rowsOf(workbook.getWorksheet('Kartalar'))).toContainEqual([
      "Karta yo'q",
    ]);
    expect(rowsOf(workbook.getWorksheet('Marketlar'))).toContainEqual([
      "To'lov yo'q",
    ]);
  });
});

describe('A2 — filial kassasi', () => {
  it('⭐ nom lentada; «HQ’ga topshirilgan» alohida, «Boshqa chiqim» — shuni ayirib', async () => {
    const workbook = await open(
      branch({
        branch_name: 'Andijon',
        hq_transfers: { count: 2, total: 150_000, reversed: 0 },
      }),
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Xulosa',
      'Kuryerlar',
      'Marketlar',
    ]);
    expectFormulaResults(workbook);
    const rows = rowsOf(workbook.getWorksheet('Xulosa'));
    expect(rows).toEqual(
      expect.arrayContaining([
        ['ELCHI POCHTA', 'Andijon filiali kassasi', 'Smena #213'],
        ["Ochilish qoldig'i", 100],
        ['Kutilgan qoldiq', 10_100],
        ['Sanalgan (topshirilgan)', 10_000],
        ['Farq', -100],
        ['Holat', 'Kamomad'],
        ["Marketlarga to'lov", 200_000, 200 / 440],
        ["HQ'ga topshirilgan (2 ta)", 150_000, 150 / 440],
        ['Kuryerga qaytarilgan', 50_000, 50 / 440],
        ['Boshqa chiqim', 40_000, 40 / 440],
        ['JAMI', 440_000, 1],
      ]),
    );
    expect(rows).toContainEqual([10_000, -100]);
    expect(rows).toContainEqual([450_000, 440_000]);
    expect(workbook.getWorksheet('Kuryerlar')!.getCell('D3').value).toContain(
      'Andijon filiali',
    );
  });

  it('HQ’dan qaytgani — kirimda; topshirilgan — yalpi; jamilar smena bilan mos', async () => {
    const rows = rowsOf(
      (
        await open(
          branch({
            branch_name: 'Andijon',
            hq_transfers: { count: 2, total: 120_000, reversed: 30_000 },
            cash: { ...branch().cash, total_income: 480_000 },
          }),
        )
      ).getWorksheet('Xulosa'),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        ['Kuryerlardan qabul', 450_000, 450 / 480],
        ["HQ'dan qaytgan (bekor qilingan)", 30_000, 30 / 480],
        ['JAMI', 480_000, 1],
        ["HQ'ga topshirilgan (2 ta)", 150_000, 150 / 440],
        ['Boshqa chiqim', 40_000, 40 / 440],
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain('Boshqa kirim');
  });

  it('nom va HQ summasi olinmagan — «Filial kassasi #id», bitta «Boshqa chiqim»', async () => {
    const rows = rowsOf(
      (
        await open(branch({ branch_name: null, hq_transfers: null }))
      ).getWorksheet('Xulosa'),
    );
    expect(rows).toContainEqual([
      'ELCHI POCHTA',
      'Filial kassasi #16',
      'Smena #213',
    ]);
    expect(rows).toContainEqual([
      "Boshqa chiqim (HQ'ga topshirish, xarajat)",
      190_000,
      190 / 440,
    ]);
    expect(JSON.stringify(rows)).not.toContain("HQ'ga topshirilgan");
  });

  it('HQ’ga topshirilmagan — qator yo‘q', async () => {
    const rows = rowsOf(
      (
        await open(
          branch({ hq_transfers: { count: 0, total: 0, reversed: 0 } }),
        )
      ).getWorksheet('Xulosa'),
    );
    expect(rows).toContainEqual(['Boshqa chiqim', 190_000, 190 / 440]);
    expect(JSON.stringify(rows)).not.toContain("HQ'ga");
  });

  it('⭐ filial faylida asosiy kassa / boshqa filial ma’lumoti chiqmaydi', async () => {
    // Snapshot'da (xato bilan) bo'lsa ham filial fayli ularni o'qimaydi.
    const workbook = await open(
      branch({
        branch_name: 'Andijon',
        branches: main().branches!.map((slice) => ({
          ...slice,
          name: 'Samarqand',
          balance: 777_777,
        })),
        accounts: main().accounts,
      }),
    );
    const all = JSON.stringify(
      workbook.worksheets.map((sheet) => [
        sheet.name,
        sheet.headerFooter,
        sheet.getSheetValues(),
      ]),
    );
    for (const foreign of ['Samarqand', '777777', 'Asosiy kassa', 'Mos emas']) {
      expect(all).not.toContain(foreign);
    }
  });
});

describe('ShiftReportService — filial snapshot’i (fail-open)', () => {
  const service = (branchClient: unknown, manager: unknown = {}) => {
    const instance = new ShiftReportService(
      { manager } as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      { send: jest.fn() } as never,
      undefined,
      { send: jest.fn() } as never,
      branchClient as never,
    );
    const warn = jest
      .spyOn(
        (instance as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    return { instance, warn };
  };

  it('HQ summasi so‘rovi yiqilsa — null (hisobot yiqilmaydi)', async () => {
    const { instance, warn } = service(undefined, {
      createQueryBuilder: () => {
        throw new Error('db down');
      },
    });
    await expect(
      (
        instance as unknown as {
          hqTransfers: (window: unknown) => Promise<unknown>;
        }
      ).hqTransfers((qb: unknown) => qb),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('filial nomi: olinmasa null', async () => {
    const name = (client: unknown) =>
      (
        service(client).instance as unknown as {
          branchName: (id: string) => Promise<string | null>;
        }
      ).branchName('16');
    await expect(
      name({ send: jest.fn(() => throwError(() => new Error('down'))) }),
    ).resolves.toBeNull();
    await expect(
      name({ send: jest.fn(() => of({ data: { name: ' Andijon ' } })) }),
    ).resolves.toBe('Andijon');
  });
});
