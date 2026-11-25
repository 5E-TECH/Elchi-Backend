import type { Alignment, Borders, Cell, CellValue, Worksheet } from 'exceljs';
import {
  REPORT_COLORS as C,
  REPORT_FMT,
  REPORT_TONES,
  addBanner,
  columnLetter,
  eachCell,
  edge,
  formula,
  lastColumn,
  reportFont,
  solid,
  toExcelDate,
  type ReportBanner,
  type ReportTone,
} from '@app/report-kit';
import { PAYMENT_METHOD_LABELS } from './shift-report.builders';

/**
 * Smena Excel'lari (A1–A4) uchun bloklar: `@app/report-kit` uslubida, lekin
 * ustun oralig'i aniq berilgan (bitta qatorda ikki jadval, guruhlangan ro'yxat,
 * moliyaviy hisob, hisob-faktura uslubidagi yakun).
 */

/** Manfiy rang `[Red]` emas — danger tokeni shriftdan beriladi. */
export const SHIFT_FMT = {
  ...REPORT_FMT,
  som: '#,##0;-#,##0;0',
  /** 0 — «—». */
  somDash: '#,##0;-#,##0;"—";@',
  signed: '+#,##0;-#,##0;0',
  count: '#,##0" ta"',
} as const;
const F = SHIFT_FMT;

/** Ulush chizig'i rangi. */
const BAR = 'FF6F8BEA';

/** [birinchi, oxirgi] Excel ustuni. */
export type Span = readonly [number, number];

/** Katakdagi son (formula — natijasi). */
export const numberOf = (value: CellValue | undefined): number => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'result' in value) {
    return typeof value.result === 'number' ? value.result : 0;
  }
  return 0;
};

/** Quick Look (telefon) 0 ni ishorali formatda «+0» ko'rsatadi — oddiy format. */
export const moneyFmt = (value: CellValue | undefined, fmt?: string): string =>
  numberOf(value) === 0 ? F.som : (fmt ?? F.som);

const isNegative = (value: CellValue | undefined) => numberOf(value) < 0;

/** Pul yig'indisi (tiyin aniqligida, bo'sh — 0). */
export const sumOf = <T>(
  rows: readonly T[],
  pick: (row: T) => number | null | undefined,
): number =>
  Math.round(rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0) * 100) / 100;

const capitalize = (value: string) =>
  value ? value[0].toUpperCase() + value.slice(1) : value;

export const methodTitle = (method: string): string =>
  capitalize(PAYMENT_METHOD_LABELS[method] ?? method);

export const isCashLine = (line: { payment_method: string }): boolean =>
  line.payment_method === 'cash';

/** Qatordagi oraliqni birlashtiradi va birinchi katagini qaytaradi. */
const spanCell = (ws: Worksheet, row: number, [a, b]: Span): Cell => {
  if (b > a) ws.mergeCells(row, a, row, b);
  return ws.getCell(row, a);
};

/** Lenta; uzun nom (filial / market) kesilmasin — kichraytiriladi. */
export function addShiftBanner(ws: Worksheet, o: ReportBanner): number {
  const next = addBanner(ws, o);
  for (let column = 3; column <= lastColumn(ws); column += 1) {
    const cell = ws.getCell(2, column);
    if (cell.value !== o.title) continue;
    cell.alignment = { vertical: 'middle', shrinkToFit: true };
    break;
  }
  return next;
}

/** Bo'lim sarlavhasi — berilgan ustunlar oralig'ida. */
export function addSectionAt(
  ws: Worksheet,
  row: number,
  [c1, c2]: Span,
  title: string,
  o: { note?: string; split?: number; color?: string } = {},
): number {
  ws.getRow(row).height = 22;
  const split = o.note ? (o.split ?? Math.floor((c1 + c2) / 2)) : c2;
  const a = spanCell(ws, row, [c1, split]);
  a.value = title;
  a.font = reportFont({ size: 11.5, bold: true, color: o.color ?? C.navy });
  a.alignment = { vertical: 'middle' };
  if (o.note) {
    const b = spanCell(ws, row, [split + 1, c2]);
    b.value = o.note;
    b.font = reportFont({ size: 9, color: C.subtle });
    b.alignment = { vertical: 'middle', horizontal: 'right' };
  }
  eachCell(ws, row, c1, row, c2, (cell) => {
    cell.border = { bottom: edge(C.navy, 'medium') };
  });
  return row + 1;
}

export interface ShiftMetaItem {
  label: string;
  value: CellValue;
  fmt?: string;
  tone?: ReportTone;
}

/** «Yorliq — qiymat» juftliklari; slot — [yorliq oralig'i, qiymat oralig'i]. */
export function addMetaAt(
  ws: Worksheet,
  row: number,
  items: readonly ShiftMetaItem[],
  slots: ReadonlyArray<readonly [Span, Span]>,
): number {
  items.forEach((item, i) => {
    const [labelAt, valueAt] = slots[i % slots.length];
    const r = row + Math.floor(i / slots.length);
    ws.getRow(r).height = 19;
    const a = spanCell(ws, r, labelAt);
    a.value = item.label;
    a.font = reportFont({ size: 9, color: C.muted });
    a.alignment = { vertical: 'middle' };
    const b = spanCell(ws, r, valueAt);
    b.value = item.value;
    b.font = reportFont({
      bold: true,
      color: item.tone ? REPORT_TONES[item.tone][0] : C.text,
    });
    b.alignment = {
      vertical: 'middle',
      horizontal: 'left',
      shrinkToFit: !item.fmt,
    };
    if (item.fmt) b.numFmt = item.fmt;
    eachCell(ws, r, labelAt[0], r, valueAt[1], (cell) => {
      cell.border = { bottom: edge() };
    });
  });
  const end = row + Math.ceil(items.length / slots.length);
  ws.getRow(end).height = 10;
  return end + 1;
}

export interface ShiftKpi {
  at: Span;
  label: string;
  value: CellValue;
  fmt?: string;
  tone?: ReportTone;
  sub?: string;
  size?: number;
}

/** Ko'rsatkich kartalari (aniq ustunlarda). Qiymat katagi — `row + 1`. */
export function addKpisAt(
  ws: Worksheet,
  row: number,
  items: readonly ShiftKpi[],
): number {
  ws.getRow(row).height = 17;
  ws.getRow(row + 1).height = 26;
  ws.getRow(row + 2).height = 16;
  for (const item of items) {
    const [start, end] = item.at;
    const [fg, bg] = item.tone
      ? REPORT_TONES[item.tone]
      : ([C.text, C.sunken] as const);
    for (let d = 0; d < 3; d += 1) {
      spanCell(ws, row + d, item.at);
      const border: Partial<Borders> = {
        ...(start > 2 ? { left: edge(C.white, 'thick') } : {}),
        ...(d === 0
          ? { top: edge(item.tone ? fg : C.borderStrong, 'medium') }
          : {}),
      };
      eachCell(ws, row + d, start, row + d, end, (cell) => {
        cell.fill = solid(bg);
        cell.border = border;
      });
    }
    const label = ws.getCell(row, start);
    label.value = item.label;
    label.font = reportFont({ size: 8.5, color: C.muted });
    label.alignment = { vertical: 'middle', indent: 1 };
    const value = ws.getCell(row + 1, start);
    value.value = item.value;
    value.font = reportFont({ size: item.size ?? 15, bold: true, color: fg });
    value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    value.numFmt = moneyFmt(item.value, item.fmt);
    const sub = ws.getCell(row + 2, start);
    sub.value = item.sub ?? '';
    sub.font = reportFont({ size: 8, color: C.subtle });
    sub.alignment = { vertical: 'top', indent: 1 };
  }
  ws.getRow(row + 3).height = 8;
  return row + 4;
}

export interface StatementRow {
  label: string;
  /** Summa kataklari (yorliqdan keyingi ustunlar). */
  cells: ReadonlyArray<CellValue | ((row: number) => CellValue)>;
  /** sub — oraliq jami, final — yakun, status — holat qatori. */
  kind?: 'sub' | 'final' | 'status';
  fmt?: string;
  tone?: ReportTone;
  /** Har katak uchun alohida ton. */
  tones?: ReadonlyArray<ReportTone | undefined>;
}

const statementBorder = (kind: StatementRow['kind']): Partial<Borders> => {
  if (kind === 'sub') return { top: edge(C.action), bottom: edge(C.action) };
  if (kind === 'final') return { top: edge(C.navy, 'medium') };
  if (kind === 'status') return { bottom: edge(C.navy, 'medium') };
  return { bottom: edge() };
};

const statementFill = (
  kind: StatementRow['kind'],
  tone: ReportTone | undefined,
): string => {
  if (kind === 'sub') return C.actionSoft;
  if (kind === 'final' || kind === 'status') {
    return tone ? REPORT_TONES[tone][1] : C.sunken;
  }
  return C.white;
};

/** Moliyaviy hisob jadvali: yorliq ustuni + summa ustunlari. */
export function addStatement(
  ws: Worksheet,
  row: number,
  columns: ReadonlyArray<{ header: string; at: Span }>,
  rows: readonly StatementRow[],
): number {
  ws.getRow(row).height = 24;
  columns.forEach((column, i) => {
    const header = spanCell(ws, row, column.at);
    eachCell(ws, row, column.at[0], row, column.at[1], (cell) => {
      cell.fill = solid(C.navy);
    });
    header.value = column.header;
    header.font = reportFont({ size: 9, bold: true, color: C.white });
    header.alignment = {
      vertical: 'middle',
      horizontal: i ? 'right' : 'left',
      indent: 1,
    };
  });
  let r = row + 1;
  for (const item of rows) {
    const { kind } = item;
    const strong = kind === 'sub' || kind === 'final';
    ws.getRow(r).height =
      kind === 'final' ? 24 : kind === 'sub' ? 22 : kind === 'status' ? 18 : 20;
    const border = statementBorder(kind);
    columns.forEach((column, i) => {
      const cell = spanCell(ws, r, column.at);
      const raw = i ? item.cells[i - 1] : item.label;
      const value = typeof raw === 'function' ? raw(r) : raw;
      const tone = i ? (item.tones ? item.tones[i - 1] : item.tone) : undefined;
      const background = solid(statementFill(kind, tone));
      eachCell(ws, r, column.at[0], r, column.at[1], (c) => {
        c.fill = background;
        c.border = border;
      });
      cell.value = value;
      cell.font = reportFont({
        size: kind === 'status' ? 9 : kind === 'final' ? 11 : 10,
        bold: strong || kind === 'status' || Boolean(tone),
        color: tone
          ? REPORT_TONES[tone][0]
          : i && isNegative(value)
            ? C.danger
            : strong
              ? C.navy
              : C.text,
      });
      cell.alignment = {
        vertical: 'middle',
        horizontal: i ? 'right' : 'left',
        indent: 1,
      };
      if (i) cell.numFmt = moneyFmt(value, item.fmt);
    });
    r += 1;
  }
  ws.getRow(r).height = 10;
  return r + 1;
}

export interface GroupedLine {
  at: Date | string;
  amount: number;
  payment_method: string;
  card_name?: string | null;
  reversed?: boolean;
}

export interface PaymentGroup {
  name: string;
  /** To'lovlar soni (qaytarish qatorlarisiz). */
  count: number;
  net: number;
  balance: number | null;
  lines: readonly GroupedLine[];
}

export type GroupedKey =
  'n' | 'name' | 'method' | 'card' | 'amount' | 'note' | 'balance';

export interface GroupedColumn {
  key: GroupedKey;
  header: string;
  at: Span;
  align?: Alignment['horizontal'];
}

/** Formula matni chegarasi (Excel — 8192 belgi) ga yetmasin. */
const MAX_PLUS_TERMS = 200;

const groupValue = (
  key: GroupedKey,
  group: PaymentGroup,
  index: number,
  headRow: number,
  amountLetter: string,
): CellValue => {
  switch (key) {
    case 'n':
      return index + 1;
    case 'name':
      return group.name;
    case 'method':
      return `${group.count} ta to'lov`;
    case 'amount':
      return group.lines.length
        ? formula(
            `SUM(${amountLetter}${headRow + 1}:${amountLetter}${headRow + group.lines.length})`,
            group.net,
          )
        : group.net;
    case 'balance':
      return group.balance ?? '—';
    default:
      return null;
  }
};

const lineValue = (key: GroupedKey, line: GroupedLine): CellValue => {
  switch (key) {
    case 'name':
      return toExcelDate(line.at) ?? '—';
    case 'method':
      return methodTitle(line.payment_method);
    case 'card':
      return line.card_name || (isCashLine(line) ? '' : '—');
    case 'amount':
      return line.amount;
    case 'note':
      return line.reversed ? 'Qaytarildi' : '';
    default:
      return null;
  }
};

const lineColor = (
  key: GroupedKey,
  line: GroupedLine,
  value: CellValue,
): string => {
  if (key === 'note' || (key === 'amount' && isNegative(value))) {
    return C.danger;
  }
  if (key === 'method') return isCashLine(line) ? C.text : C.info;
  return key === 'name' || key === 'card' ? C.muted : C.text;
};

/**
 * Guruhlangan to'lovlar: guruh qatori (soni, sof jami — formula, qoldiq) va
 * uning to'lovlari; oxirida JAMI.
 */
export function addGroupedPayments(
  ws: Worksheet,
  row: number,
  columns: readonly GroupedColumn[],
  groups: readonly PaymentGroup[],
): number {
  const first = columns[0].at[0];
  const last = columns[columns.length - 1].at[1];
  ws.pageSetup.printTitlesRow = `${row}:${row}`;
  ws.properties.outlineProperties = {
    summaryBelow: false,
    summaryRight: false,
  };
  ws.getRow(row).height = 24;
  for (const column of columns) {
    const header = spanCell(ws, row, column.at);
    eachCell(ws, row, column.at[0], row, column.at[1], (cell) => {
      cell.fill = solid(C.navy);
      cell.border = { right: edge(C.navyLine) };
    });
    header.value = column.header;
    header.font = reportFont({ size: 9, bold: true, color: C.white });
    header.alignment = {
      vertical: 'middle',
      horizontal: column.align ?? 'left',
      indent: column.align === 'center' ? 0 : 1,
    };
  }
  let r = row + 1;
  if (!groups.length) {
    const empty = spanCell(ws, r, [first, last]);
    eachCell(ws, r, first, r, last, (cell) => {
      cell.border = { bottom: edge() };
    });
    empty.value = "To'lov yo'q";
    empty.font = reportFont({ italic: true, color: C.subtle });
    empty.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(r).height = 24;
    return r + 2;
  }

  const put = (
    column: GroupedColumn,
    value: CellValue,
    o: {
      background: string;
      border: Partial<Borders>;
      bold: boolean;
      size: number;
      color: string;
      indent?: number;
    },
  ) => {
    const cell = spanCell(ws, r, column.at);
    eachCell(ws, r, column.at[0], r, column.at[1], (c) => {
      c.fill = solid(o.background);
      c.border = o.border;
    });
    cell.value = value;
    cell.font = reportFont({ bold: o.bold, size: o.size, color: o.color });
    cell.alignment = {
      vertical: 'middle',
      horizontal: column.align ?? 'left',
      indent: column.align === 'center' ? 0 : (o.indent ?? 1),
    };
    if (value instanceof Date) cell.numFmt = F.dateTime;
    else if (column.key === 'amount' || column.key === 'balance') {
      cell.numFmt = F.som;
    }
  };

  const amountColumn = columns.find((column) => column.key === 'amount');
  const amountLetter = columnLetter(amountColumn?.at[0] ?? first);
  const heads: number[] = [];
  const headBorder: Partial<Borders> = {
    top: edge(C.borderStrong),
    bottom: edge(C.borderStrong),
  };
  const lineBorder: Partial<Borders> = { bottom: edge() };
  groups.forEach((group, index) => {
    heads.push(r);
    ws.getRow(r).height = 21;
    for (const column of columns) {
      const { key } = column;
      const value = groupValue(key, group, index, r, amountLetter);
      const quiet = key === 'method' || key === 'n';
      put(column, value, {
        background: C.sunken,
        border: headBorder,
        bold: !quiet,
        size: key === 'method' ? 9 : 10,
        color: quiet ? C.muted : isNegative(value) ? C.danger : C.navy,
      });
    }
    r += 1;
    for (const line of group.lines) {
      ws.getRow(r).height = 18;
      ws.getRow(r).outlineLevel = 1;
      const background = line.reversed ? C.dangerSoft : C.white;
      for (const column of columns) {
        const { key } = column;
        const value = lineValue(key, line);
        put(column, value, {
          background,
          border: lineBorder,
          bold: key === 'note',
          size: key === 'note' ? 9 : 10,
          color: lineColor(key, line, value),
          indent: key === 'name' ? 2 : 1,
        });
      }
      r += 1;
    }
  });

  ws.getRow(r).height = 22;
  const totalBorder: Partial<Borders> = {
    top: edge(C.action, 'medium'),
    bottom: edge(C.action),
  };
  const total = (column: GroupedColumn): CellValue => {
    const letter = columnLetter(column.at[0]);
    const range = `${letter}${row + 1}:${letter}${r - 1}`;
    switch (column.key) {
      case 'name':
        return 'JAMI';
      case 'method':
        return `${sumOf(groups, (group) => group.count)} ta to'lov`;
      case 'amount':
        return formula(
          heads.length <= MAX_PLUS_TERMS
            ? heads.map((head) => `${letter}${head}`).join('+')
            : // Guruh qatori = o'z qatorlari yig'indisi — har summa ikki marta.
              `SUM(${range})/2`,
          sumOf(groups, (group) => group.net),
        );
      case 'balance':
        // Qoldiq faqat guruh qatorida.
        return formula(
          `SUM(${range})`,
          sumOf(groups, (group) => group.balance),
        );
      default:
        return null;
    }
  };
  for (const column of columns) {
    put(column, total(column), {
      background: C.actionSoft,
      border: totalBorder,
      bold: column.key !== 'method',
      size: column.key === 'method' ? 9 : 10,
      color: C.navy,
    });
  }
  ws.getRow(r + 1).height = 10;
  return r + 2;
}

export interface TotalsRow {
  label: string;
  value: CellValue;
  kind?: 'total' | 'balance';
  tone?: ReportTone;
}

/** Hisob-faktura uslubidagi yakun (o'ng tomonda). */
export function addTotalsAt(
  ws: Worksheet,
  row: number,
  rows: readonly TotalsRow[],
  [labelAt, valueAt]: readonly [Span, Span],
): number {
  let r = row;
  for (const item of rows) {
    const big = item.kind === 'total';
    const balance = item.kind === 'balance';
    ws.getRow(r).height = big ? 26 : 20;
    const a = spanCell(ws, r, labelAt);
    const b = spanCell(ws, r, valueAt);
    const background = solid(big ? C.navy : balance ? C.actionSoft : C.white);
    eachCell(ws, r, labelAt[0], r, valueAt[1], (cell) => {
      cell.fill = background;
      cell.border = big ? {} : { bottom: edge() };
    });
    a.value = item.label;
    a.font = reportFont({
      size: big ? 11 : 10,
      bold: big || balance,
      color: big ? C.white : balance ? C.navy : C.muted,
    });
    a.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    b.value = item.value;
    b.numFmt = F.som;
    b.font = reportFont({
      size: big ? 13 : balance ? 11 : 10,
      bold: true,
      color: big
        ? C.white
        : item.tone
          ? REPORT_TONES[item.tone][0]
          : isNegative(item.value)
            ? C.danger
            : C.navy,
    });
    b.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    r += 1;
  }
  ws.getRow(r).height = 10;
  return r + 1;
}

/** Imzo satrlari (aniq ustunlarda). */
export function addSignaturesAt(
  ws: Worksheet,
  row: number,
  items: ReadonlyArray<readonly [string, Span]>,
): void {
  ws.getRow(row).height = 28;
  ws.getRow(row + 1).height = 14;
  for (const [label, at] of items) {
    spanCell(ws, row, at);
    const cell = spanCell(ws, row + 1, at);
    eachCell(ws, row, at[0], row, at[1], (c) => {
      c.border = { bottom: edge(C.borderStrong) };
    });
    cell.value = label;
    cell.font = reportFont({ size: 8.5, color: C.muted });
    cell.alignment = { vertical: 'middle' };
  }
}

/** Ulush chizig'i: 0–100% shkala (chiziq uzunligi = haqiqiy ulush). */
export function addShareBars(ws: Worksheet, ref: string): void {
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: 'dataBar',
        priority: 1,
        gradient: false,
        minLength: 0,
        maxLength: 100,
        cfvo: [
          { type: 'num', value: 0 },
          { type: 'num', value: 1 },
        ],
        color: { argb: BAR },
      } as never,
    ],
  });
}
