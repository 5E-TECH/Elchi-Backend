/**
 * Excel (.xlsx) workbook building for the gateway export endpoints.
 *
 * Mirrors the legacy PCS exceljs exports (orders, cashbox history, shifts).
 * Services return JSON rows over RMQ; the gateway renders the workbook here,
 * the same split used by the printer endpoints.
 */
import { Workbook } from 'exceljs';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

/**
 * Build a single-sheet workbook. `rows` are keyed by each column's `key`;
 * missing keys render as blank cells. Header row is bold on a light fill.
 */
export async function buildXlsx(
  sheetName: string,
  columns: ExcelColumn[],
  rows: Array<Record<string, unknown>>,
): Promise<Buffer> {
  const wb = new Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);

  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 18,
  }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8E8E8' },
  };
  headerRow.alignment = { vertical: 'middle' };

  for (const row of rows) {
    ws.addRow(row);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function excelDate(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value !== 'string' &&
      typeof value !== 'number' &&
      !(value instanceof Date))
  ) {
    return '';
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return typeof value === 'string' ? value : '';
  }
  // Tashkent local time, human readable
  return d.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
}

export function excelNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
