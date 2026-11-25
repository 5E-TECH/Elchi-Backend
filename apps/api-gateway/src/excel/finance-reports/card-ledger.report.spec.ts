import { Workbook, type Cell } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import {
  buildCardLedgerReport,
  type CardLedgerReportInput,
} from './card-ledger.report';

/** B4 — Karta ko'chirmasi (.xlsx): fayl qayta o'qiladi. */

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  id: String(n),
  kind: 'income',
  created_at: new Date(Date.UTC(2026, 10, n, 5)).toISOString(),
  amount: 1000,
  delta: 1000,
  balance_after: 6000,
  source_type: 'courier_payment',
  payment_method: 'click',
  counterparty_card_id: null,
  comment: null,
  created_by: '2',
  ...extra,
});

const DATA = {
  cashbox_type: 'main',
  branch_id: null,
  card: {
    id: '5',
    name: 'Asosiy karta',
    kind: 'plastic_card',
    bank_name: 'Namuna bank',
    card_network: 'humo',
    last4: '4417',
    holder_name: 'Dilnoza Karimova',
    balance: 5600,
  },
  // Finance eng yangisini tepada beradi.
  items: [
    item(3, {
      kind: 'transfer_out',
      amount: 400,
      delta: -400,
      balance_after: 5600,
      source_type: undefined,
      payment_method: undefined,
      counterparty_card_id: '9',
      comment: '=HYPERLINK("x")',
      created_by: '99',
    }),
    item(2),
  ],
  summary: {
    opening_balance: 5000,
    closing_balance: 5600,
    total_in: 1000,
    total_out: 400,
    current_balance: 7300,
  },
};

const build = async (extra: Partial<CardLedgerReportInput> = {}) => {
  const buffer = await buildCardLedgerReport({
    data: DATA,
    from_date: '2026-11-01T00:00:00+05:00',
    to_date: '2026-11-24T23:59:59.999+05:00',
    cardNames: new Map([['9', 'Uzcard zaxira']]),
    userNames: new Map([['2', 'Dilnoza Karimova']]),
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

describe("B4 — Karta ko'chirmasi", () => {
  it('karta tafsiloti, davr va qoldiqlar (summary dan), «Mos keldi»', async () => {
    const ws = await build();
    expect(ws.getCell('B2').value).toBe('ELCHI POCHTA');
    const texts: unknown[] = [];
    ws.eachRow((r) =>
      r.eachCell((c) => {
        if (c.master === c) texts.push(value(c));
      }),
    );
    expect(texts).toContain(
      'Asosiy karta · Humo •••• 4417 · Plastik karta · Namuna bank · Egasi: Dilnoza Karimova',
    );
    expect(texts).toContain('01.11 — 24.11.2026');
    expect(texts).toContain('Asosiy kassa');
    expect(
      ['B7', 'E7', 'G7', 'I7', 'K7'].map((c) => value(ws.getCell(c))),
    ).toEqual([7300, 5000, 1000, 400, 5600]);
    expect(value(ws.getCell('B8'))).toBe('25.11.2026 09:20 holatiga');
    expect(value(ws.getCell('K8'))).toBe(
      'Mos keldi: davr boshi + kirim − chiqim',
    );
  });

  it('qatorlar eskidan yangiga: kirim / chiqim alohida, yorliqlar, ismlar, JAMI', async () => {
    const ws = await build();
    expect(ws.getRow(10).values).toEqual([
      undefined,
      undefined,
      '№',
      'Sana',
      'Amal',
      "Kirim, so'm",
      "Chiqim, so'm",
      "Qoldiq, so'm",
      'Manba',
      "To'lov usuli",
      'Qarshi karta',
      'Izoh',
      'Kiritgan',
    ]);
    expect(value(ws.getCell('D11'))).toBe('Davr boshida');
    expect(value(ws.getCell('G11'))).toBe(5000);
    const line = (r: number) =>
      [...'BDEFGHIJKL'].map((c) => value(ws.getCell(`${c}${r}`)));
    expect(line(12)).toEqual([
      1,
      'Kirim',
      1000,
      null,
      6000,
      "Kuryer to'lovi",
      'Karta (Click)',
      null,
      null,
      'Dilnoza Karimova',
    ]);
    expect(line(13)).toEqual([
      2,
      "Kartadan o'tkazma",
      null,
      400,
      5600,
      null,
      null,
      'Uzcard zaxira',
      '=HYPERLINK("x")',
      '#99', // ismi topilmadi — fail-open
    ]);
    expect(ws.getCell('E14').value).toMatchObject({ result: 1000 });
    expect(ws.getCell('G14').value).toMatchObject({
      formula: 'G11+E14-F14',
      result: 5600,
    });
  });

  it('qoldiq mos kelmasa — sariq «Mos kelmadi: farq …»', async () => {
    const ws = await build({
      data: { ...DATA, summary: { ...DATA.summary, opening_balance: 4900 } },
    });
    expect(value(ws.getCell('K8'))).toBe('Mos kelmadi: farq −100');
    expect(ws.getCell('K8').font.color?.argb).toBe('FF95560A');
  });

  it('nomlar olinmasa — #id; filial kartasi — filial nomi; bo`sh ko`chirma ochiladi', async () => {
    const ws = await build({ cardNames: new Map(), userNames: new Map() });
    expect(ws.getCell('J13').value).toBe('#9');
    expect(ws.getCell('L12').value).toBe('#2');
    const empty = await build({
      data: {
        ...DATA,
        items: [],
        cashbox_type: 'branch',
        branch_id: '5',
        summary: {
          opening_balance: 70,
          closing_balance: 70,
          current_balance: 0,
        },
      },
    });
    expect(value(empty.getCell('G11'))).toBe(70);
    expect(value(empty.getCell('K7'))).toBe(70);
    expect(JSON.stringify(empty.getSheetValues())).toContain('Andijon filiali');
  });
});
