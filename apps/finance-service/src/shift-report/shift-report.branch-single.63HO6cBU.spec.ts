import { Workbook } from 'exceljs';
import {
  buildSuperadminMessage,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import { buildXlsx } from './shift-report.file';

/**
 * 63HO6cBU (P0) — filial smenasi bitta jami: smena hisoboti xabari va XLSX
 * da «Karta» qatori / bo'limi va «Kartalar» varag'i yo'q, «Jami» bor. MAIN
 * smenasi — avvalgidek (naqd + karta).
 */
const block = (value: number) => ({
  opening_balance: value,
  total_income: 0,
  total_expense: 0,
  expected_balance: value,
  closing_balance: value,
  discrepancy: 0,
});

const snapshot = (cashbox_type: 'main' | 'branch'): ShiftReportSnapshot =>
  ({
    shift_id: '7',
    round: 1,
    cashbox_type,
    cashbox_user_id: cashbox_type === 'main' ? '0' : '15',
    opened_at: '2026-11-19T05:00:00Z',
    closed_at: '2026-11-19T13:00:00Z',
    opened_by: '8',
    opened_by_name: 'Menejer',
    closed_by: '8',
    closed_by_name: 'Menejer',
    close_reason: 'manual',
    cash: block(150_000),
    card: block(0),
    accounts: [],
    couriers: [],
    markets: [],
  }) as unknown as ShiftReportSnapshot;

describe('63HO6cBU — filial smenasi hisoboti bitta jami', () => {
  it('superadmin xabari: filialda «Jami», karta qatori yo`q; MAIN — naqd + karta', () => {
    const branch = buildSuperadminMessage(snapshot('branch'), null);
    expect(branch.body).toContain("Jami: 150 000 so'm");
    expect(branch.body).not.toMatch(/Karta:|Naqd:/);
    expect(branch.data.card_discrepancy).toBeNull();
    const main = buildSuperadminMessage(snapshot('main'), null);
    expect(main.body).toContain('Naqd:');
    expect(main.body).toContain('Karta:');
  });

  it('XLSX: filialda «Kartalar» varag`i va KARTA bo`limi yo`q, JAMI bor', async () => {
    const read = async (buffer: Buffer) => {
      const workbook = new Workbook();
      await workbook.xlsx.load(buffer as never);
      return workbook;
    };
    const branch = await read(await buildXlsx(snapshot('branch')));
    expect(branch.worksheets.map((sheet) => sheet.name)).toEqual([
      'Xulosa',
      'Kuryerlar',
      'Marketlar',
    ]);
    const labels: string[] = [];
    branch.getWorksheet('Xulosa')!.eachRow((row) => {
      labels.push(row.getCell(1).text);
    });
    expect(labels).toContain('JAMI');
    expect(labels).not.toContain('KARTA');
    const main = await read(await buildXlsx(snapshot('main')));
    expect(main.worksheets.map((sheet) => sheet.name)).toContain('Kartalar');
  });
});
