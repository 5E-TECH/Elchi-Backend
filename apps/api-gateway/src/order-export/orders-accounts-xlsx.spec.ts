import { Workbook } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import {
  ORDERS_ACCOUNTS_COLUMNS,
  buildOrdersAccountsXlsx,
  toOrdersAccountsRow,
} from './orders-accounts-xlsx';

/**
 * `GET /export/orders.xlsx` — hisob ko'rsatkichlari bilan eksport: holat
 * o'zbekcha, kuryer ismi, marketlar bilan hisob, chegaradan oshsa DIQQAT.
 */

type Obj = Record<string, unknown>;

const plain = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const cell = value as {
      formula?: string;
      result?: unknown;
      richText?: Array<{ text: string }>;
    };
    if (cell.richText) return cell.richText.map((part) => part.text).join('');
    if (cell.formula) return cell.result ?? 0;
  }
  return value;
};

const load = async (buffer: Buffer) => {
  const wb = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

const sheetRows = (wb: Workbook, name: string): unknown[][] => {
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as unknown[]).slice(2).map(plain));
  });
  return rows;
};

const col = (key: string) =>
  ORDERS_ACCOUNTS_COLUMNS.findIndex((column) => column.key === key);

const ORDERS: Obj[] = [
  {
    id: '184327',
    status: 'sold',
    total_price: '210000',
    paid_amount: 0,
    to_be_paid: 175000,
    address: 'Guliston mahallasi, 4-uy',
    createdAt: '2026-11-19T11:26:00.000Z',
    courier_id: '26',
    courier: { id: '26', name: 'Jasur Tursunov' },
    market: { id: '1', name: 'Baraka Shop' },
    customer: { name: 'Ali', phone_number: '998901112233' },
    region: { id: '3', name: 'Andijon viloyati' },
    district: { name: 'Asaka' },
  },
  {
    id: '184319',
    status: 'paid',
    total_price: 560000,
    paid_amount: 515000,
    to_be_paid: 515000,
    createdAt: '2026-11-18T04:18:00.000Z',
    courier_id: '77',
    courier: null,
    market: { id: '2', name: 'Nur Elektronika' },
    customer: {
      name: 'Vali',
      phone_number: '+998 ** *** 22',
      region: { name: 'Xorazm viloyati' },
      district: { name: 'Urganch' },
    },
  },
  {
    id: '184315',
    status: 'cancelled (sent)',
    total_price: 890000,
    createdAt: 'notogri-sana',
    market: { id: '1', name: 'Baraka Shop' },
    customer: null,
  },
];

const build = (extra: Obj = {}) =>
  buildOrdersAccountsXlsx({
    rows: ORDERS.map((order, i) => toOrdersAccountsRow(order, i + 1)),
    total: ORDERS.length,
    maxRows: 50_000,
    subtitle: 'Davr: barchasi · Holat: barchasi',
    now: new Date('2026-11-24T23:41:00.000Z'),
    ...extra,
  });

describe('export/orders.xlsx — qator', () => {
  it('holat o‘zbekcha, kuryer ismi (ism yo‘q — #id, kuryer yo‘q — bo‘sh), telefon, sana', () => {
    const [sold, paid, sent] = ORDERS.map((order, i) =>
      toOrdersAccountsRow(order, i + 1),
    );
    expect(sold).toEqual({
      n: 1,
      id: 184327,
      market: 'Baraka Shop',
      customer: 'Ali',
      phone: '+998 90 111 22 33',
      region: 'Andijon viloyati',
      district: 'Asaka',
      address: 'Guliston mahallasi, 4-uy',
      total_price: 210000,
      paid_amount: 0,
      to_be_paid: 175000,
      status: 'Sotilgan',
      created_at: new Date('2026-11-19T16:26:00.000Z'),
      courier: 'Jasur Tursunov',
    });
    expect(paid).toMatchObject({
      status: "To'langan",
      courier: '#77',
      // Yashirilgan telefon — o'zicha.
      phone: '+998 ** *** 22',
      region: 'Xorazm viloyati',
      district: 'Urganch',
    });
    expect(sent).toMatchObject({
      status: "Bekor — jo'natilgan",
      courier: '',
      paid_amount: 0,
      created_at: 'notogri-sana',
    });
  });
});

describe('export/orders.xlsx — fayl', () => {
  it('logotip, hisob kartalari, ustunlar, JAMI (SUBTOTAL)', async () => {
    const wb = await load(await build());
    const ws = wb.getWorksheet('Buyurtmalar')!;
    expect(ws.getImages()).toHaveLength(1);
    expect(sheetRows(wb, 'Buyurtmalar')[0]).toContain('3 ta buyurtma');
    // Kartalar: jami narx, kerak, to'langan, qoldi.
    expect(sheetRows(wb, 'Buyurtmalar')).toContainEqual(
      expect.arrayContaining([1_660_000, 690_000, 515_000, 175_000]),
    );
    const header = (ws.getRow(9).values as unknown[]).slice(2);
    expect(header).toEqual(ORDERS_ACCOUNTS_COLUMNS.map((c) => c.header));
    expect(header).toContain('Kuryer');
    expect(header).not.toContain('Kuryer ID');
    expect(header).not.toContain('Status');
    const cell = (row: number, key: string) => ws.getCell(row, col(key) + 2);
    expect(cell(10, 'id').value).toBe(184327);
    expect(cell(10, 'total_price').value).toBe(210000);
    expect(cell(10, 'status').value).toBe('Sotilgan');
    expect(cell(10, 'created_at').value).toEqual(
      new Date('2026-11-19T16:26:00.000Z'),
    );
    expect(cell(13, 'n').value).toBe('JAMI');
    expect(cell(13, 'address').value).toMatchObject({
      formula: 'SUBTOTAL(2,B10:B12)',
      result: 3,
    });
    expect(cell(13, 'total_price').value).toMatchObject({
      formula: 'SUBTOTAL(9,J10:J12)',
      result: 1_660_000,
    });
    expect(cell(13, 'paid_amount').value).toMatchObject({
      formula: 'SUBTOTAL(9,K10:K12)',
      result: 515_000,
    });
    expect(cell(13, 'to_be_paid').value).toMatchObject({
      formula: 'SUBTOTAL(9,L10:L12)',
      result: 690_000,
    });
    expect(ws.autoFilter).toBe('B9:O12');
    expect(
      sheetRows(wb, 'Buyurtmalar').some((r) => /^DIQQAT/.test(String(r[0]))),
    ).toBe(false);
  });

  it('«Xulosa»: marketlar bilan hisob — kerak − to‘langan = qoldi (formula)', async () => {
    const wb = await load(await build());
    const ws = wb.getWorksheet('Xulosa')!;
    const rows = sheetRows(wb, 'Xulosa');
    const named = (name: string) => rows.find((row) => row[0] === name)!;
    expect(named('Baraka Shop').filter((v) => typeof v === 'number')).toEqual([
      2, 1_100_000, 175_000, 0, 175_000,
    ]);
    expect(
      named('Nur Elektronika').filter((v) => typeof v === 'number'),
    ).toEqual([1, 560_000, 515_000, 515_000, 0]);
    let left: string | undefined;
    ws.eachRow((row) => {
      if (row.getCell(2).value === 'Baraka Shop') {
        left = row.getCell(8).formula;
      }
    });
    expect(left).toMatch(/^F\d+-G\d+$/);
    // Kartalar: sotilgan (sotilgan + to'langan) va bekor.
    expect(rows).toContainEqual(
      expect.arrayContaining([1_660_000, 770_000, 890_000]),
    );
    expect(named('Andijon viloyati')).toEqual(
      expect.arrayContaining([1, 210_000]),
    );
  });

  it('chegaradan oshgan — DIQQAT tepada, oxirida va «Xulosa» da (ilgari jim qirqilardi)', async () => {
    const wb = await load(await build({ total: 62_340, maxRows: 3 }));
    const rows = sheetRows(wb, 'Buyurtmalar');
    const warnings = rows
      .map((row, index) => [String(row[0]), index] as const)
      .filter(([text]) => text.startsWith('DIQQAT'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0][0]).toContain('62 340');
    const head = rows.findIndex((row) => row[0] === '№');
    const jami = rows.findIndex((row) => row[0] === 'JAMI');
    expect(warnings[0][1]).toBeLessThan(head);
    expect(warnings[1][1]).toBeGreaterThan(jami);
    expect(rows[1]).toContain("filtr bo'yicha jami 62 340 ta");
    expect(
      sheetRows(wb, 'Xulosa').some((r) => /^DIQQAT/.test(String(r[0]))),
    ).toBe(true);
    expect(wb.getWorksheet('Buyurtmalar')!.views[0]).toMatchObject({
      ySplit: 11,
    });
  });

  it('ro‘yxat qisqargan — boshqa DIQQAT', async () => {
    const wb = await load(await build({ total: 5 }));
    expect(
      sheetRows(wb, 'Buyurtmalar').some((r) =>
        String(r[0]).includes("ro'yxat o'zgardi"),
      ),
    ).toBe(true);
  });

  it('katta ro‘yxat oqimli yozuvchi bilan — qiymatlar bir xil, logotipsiz', async () => {
    const wb = await load(await build({ streamFrom: 1 }));
    const ws = wb.getWorksheet('Buyurtmalar')!;
    expect(ws.getImages()).toHaveLength(0);
    expect(ws.getCell('B1').value).toBe('ELCHI POCHTA');
    const memory = await load(await build());
    // Banner (oqimda 3 qator, xotirada 2) dan keyin hammasi bir xil.
    const rowsOf = (book: Workbook, name: string, skip: number) =>
      sheetRows(book, name)
        .slice(skip)
        .map((row) => Array.from(row, (value) => value ?? ''));
    for (const name of ['Buyurtmalar', 'Xulosa']) {
      expect(rowsOf(wb, name, 3)).toEqual(rowsOf(memory, name, 2));
    }
  });

  it('bo‘sh ro‘yxat — fayl ochiladi, JAMI 0', async () => {
    const wb = await load(await build({ rows: [], total: 0 }));
    const rows = sheetRows(wb, 'Buyurtmalar');
    expect(rows.some((r) => r[0] === 'Buyurtma topilmadi')).toBe(true);
    const jami = rows.find((r) => r[0] === 'JAMI')!;
    expect(jami.filter((v) => v === 0)).toHaveLength(4);
  });

  it('matn «=» bilan boshlansa ham matn', async () => {
    const rows = [
      toOrdersAccountsRow(
        { ...ORDERS[0], address: '=cmd|calc', market: { name: '+1' } },
        1,
      ),
    ];
    const ws = (await load(await build({ rows, total: 1 }))).getWorksheet(
      'Buyurtmalar',
    )!;
    const cell = ws.getCell(10, col('address') + 2);
    expect(cell.value).toBe('=cmd|calc');
    expect(cell.formula).toBeUndefined();
    expect(ws.getCell(10, col('market') + 2).value).toBe('+1');
  });
});
