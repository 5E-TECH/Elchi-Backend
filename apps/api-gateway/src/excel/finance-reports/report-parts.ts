import type {
  Alignment,
  Borders,
  CellFormulaValue,
  CellValue,
  Worksheet,
} from 'exceljs';
import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  REPORT_TONES,
  addBanner,
  addNote,
  eachCell,
  edge,
  formula,
  lastColumn,
  reportFont,
  solid,
  type ReportBanner,
  type ReportTableResult,
  type ReportTone,
} from '@app/report-kit';
import { moneyText, round2 } from './report-labels';

/**
 * B1–B6 hisobotlarining umumiy bo'laklari — `@app/report-kit` ustiga
 * (tasdiqlangan dizayn, 2026-11-25).
 */

/** Matn qaytaradigan formula (kit'dagi `formula` — son uchun). */
export const textFormula = (
  text: string,
  result: string,
): CellFormulaValue => ({
  formula: text,
  result,
  date1904: false,
});

/** Bo'sh jadvalda formula o'rniga — son. */
export const formulaIf = (
  condition: boolean,
  text: string,
  result: number,
): CellValue => (condition ? formula(text, round2(result)) : round2(result));

export interface PlacedKpi {
  from: number;
  to: number;
  label: string;
  value: CellValue;
  fmt?: string;
  tone?: ReportTone;
  sub?: CellValue;
  subTone?: ReportTone;
}

/** Kartalar — ustun oraliqlari aniq berilgan (keng / tor ustunli varaq). */
export function addKpisAt(
  ws: Worksheet,
  row: number,
  items: readonly PlacedKpi[],
): number {
  ws.getRow(row).height = 16;
  ws.getRow(row + 1).height = 24;
  ws.getRow(row + 2).height = 15;
  for (const item of items) {
    const { from, to } = item;
    const [fg, bg] = item.tone
      ? REPORT_TONES[item.tone]
      : ([C.text, C.sunken] as const);
    for (let d = 0; d < 3; d += 1) {
      if (to > from) ws.mergeCells(row + d, from, row + d, to);
      eachCell(ws, row + d, from, row + d, to, (cell) => {
        cell.fill = solid(bg);
        cell.border = {
          left: edge(C.white, 'thick'),
          ...(d === 0
            ? { top: edge(item.tone ? fg : C.borderStrong, 'medium') }
            : {}),
        };
      });
    }
    const label = ws.getCell(row, from);
    label.value = item.label;
    label.font = reportFont({ size: 8.5, color: C.muted });
    label.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    const value = ws.getCell(row + 1, from);
    value.value = item.value;
    value.numFmt = item.fmt ?? F.som;
    value.font = reportFont({ size: 15, bold: true, color: fg });
    value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    const sub = ws.getCell(row + 2, from);
    sub.value = item.sub ?? '';
    sub.font = reportFont({
      size: 8,
      bold: Boolean(item.subTone),
      color: item.subTone ? REPORT_TONES[item.subTone][0] : C.subtle,
    });
    sub.alignment = { vertical: 'top', horizontal: 'left', indent: 1 };
  }
  ws.getRow(row + 3).height = 10;
  return row + 4;
}

const WRAP_ALIGNMENT: Partial<Alignment> = {
  vertical: 'middle',
  horizontal: 'left',
  wrapText: true,
  indent: 1,
};

/**
 * Matn ustuni (izoh): qatorga sig'masa pastga o'tadi, qator balandligi matnga
 * qarab. Uslub obyekti bitta — 50 000 qatorda ham xotira tejaladi.
 */
export function wrapColumn(
  ws: Worksheet,
  table: ReportTableResult,
  index: number,
  base = 18,
): void {
  const [from, to] = table.columns[index];
  let width = 0;
  for (let c = from; c <= to; c += 1) width += ws.getColumn(c).width ?? 9;
  const capacity = Math.max(6, Math.floor(width * 1.1) - 1);
  for (let r = table.first; r <= table.last; r += 1) {
    const cell = ws.getCell(r, from);
    cell.alignment = WRAP_ALIGNMENT;
    if (typeof cell.value !== 'string' || cell.value.length <= capacity) {
      continue;
    }
    let lines = 1;
    let current = 0;
    for (const word of cell.value.split(' ')) {
      if (current && current + 1 + word.length > capacity) {
        lines += 1;
        current = 0;
      }
      current += (current ? 1 : 0) + word.length;
      // Bo'shliqsiz uzun matn ham bo'linadi.
      for (; current > capacity; current -= capacity) lines += 1;
    }
    // Excel qator balandligi chegarasi — 409 pt.
    const height = Math.min(400, Math.max(base, lines * 13 + 5));
    if (height > (ws.getRow(r).height ?? 0)) ws.getRow(r).height = height;
  }
}

/** Chop etishda sarlavha har betda takrorlanadi. */
export const printTitles = (ws: Worksheet, from: number, to = from): void => {
  ws.pageSetup.printTitlesRow = `${from}:${to}`;
};

const DIVIDER: Partial<Borders> = {
  bottom: edge(),
  right: edge(C.borderStrong),
};
/** Ustundan keyin ajratuvchi chiziq (guruhlar orasida). */
export const addDivider = (
  ws: Worksheet,
  table: ReportTableResult,
  column: number,
): void => {
  for (let r = table.first; r <= table.last; r += 1) {
    ws.getCell(r, column).border = DIVIDER;
  }
};

/** Jadval sarlavhasi ustidagi guruh lentasi («NAQD, SO'M» …). */
export function addGroupHeader(
  ws: Worksheet,
  row: number,
  groups: ReadonlyArray<{ from: number; to: number; label: string }>,
): number {
  ws.getRow(row).height = 18;
  eachCell(ws, row, 2, row, lastColumn(ws), (cell) => {
    cell.fill = solid(C.navy);
    cell.border = { right: edge(C.navyLine) };
  });
  for (const group of groups) {
    ws.mergeCells(row, group.from, row, group.to);
    const cell = ws.getCell(row, group.from);
    cell.value = group.label;
    cell.font = reportFont({ size: 8.5, bold: true, color: C.navMuted });
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    eachCell(ws, row, group.from, row, group.to, (part) => {
      part.border = { right: edge('FF6A75A6'), bottom: edge(C.navyLine) };
    });
  }
  return row + 1;
}

/**
 * Lenta: o'ng blok aniq `split` ustundan keyin boshlanadi (davr matni tor
 * ustunda kesilmasin), sarlavha C ustunidan logotip kengligicha chekinadi.
 */
export function addBannerSplit(
  ws: Worksheet,
  banner: ReportBanner,
  split: number,
): number {
  const next = addBanner(ws, {
    title: banner.title,
    subtitle: banner.subtitle,
  });
  const L = lastColumn(ws);
  const c0 = ws.getCell(2, L).master.fullAddress.col;
  for (const r of [2, 3]) {
    const old = ws.getCell(r, c0);
    const { value, font } = old;
    ws.unMergeCells(r, c0, r, L);
    old.value = null;
    const cell = ws.getCell(r, 3);
    cell.value = value;
    cell.font = font;
    ws.mergeCells(r, 3, r, split);
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 8 };
    ws.mergeCells(r, split + 1, r, L);
  }
  const right = ws.getCell(2, split + 1);
  right.value = banner.right ?? '';
  right.font = reportFont({ size: 13, bold: true, color: C.white });
  right.alignment = { horizontal: 'right', vertical: 'middle' };
  const sub = ws.getCell(3, split + 1);
  sub.value = banner.rightSub ?? '';
  sub.font = reportFont({ size: 9, color: C.navMuted });
  sub.alignment = { horizontal: 'right', vertical: 'middle' };
  eachCell(ws, 2, 2, 3, L, (cell) => {
    cell.fill = solid(C.navy);
  });
  return next;
}

/** Imzo satrlari — oraliqlari aniq. */
export function addSignaturesAt(
  ws: Worksheet,
  row: number,
  items: ReadonlyArray<{ from: number; to: number; label: string }>,
): number {
  ws.getRow(row).height = 28;
  ws.getRow(row + 1).height = 14;
  for (const { from, to, label } of items) {
    if (to > from) {
      ws.mergeCells(row, from, row, to);
      ws.mergeCells(row + 1, from, row + 1, to);
    }
    eachCell(ws, row, from, row, to, (cell) => {
      cell.border = { bottom: edge(C.borderStrong) };
    });
    const cell = ws.getCell(row + 1, from);
    cell.value = label;
    cell.font = reportFont({ size: 8.5, color: C.muted });
    cell.alignment = { vertical: 'middle' };
  }
  return row + 3;
}

// ───────────────────────── nazorat va cheklov ─────────────────────────

export interface BalanceCheck {
  ok: boolean;
  /** hisoblangan − yozilgan. */
  diff: number;
  text: string;
  tone: ReportTone;
}

/** Hisoblangan va yozilgan qoldiq solishtiruvi (farq YASHIRILMAYDI). */
export const balanceCheck = (
  computed: number,
  recorded: number,
  okText: string,
): BalanceCheck => {
  const diff = round2(computed - recorded);
  return diff === 0
    ? { ok: true, diff: 0, text: okText, tone: 'success' }
    : {
        ok: false,
        diff,
        text: `Mos kelmadi: farq ${moneyText(diff)}`,
        tone: 'warning',
      };
};

/** Nazorat katagi: formula (tahrirda qayta hisoblanadi) + hozirgi natija. */
export const checkFormula = (
  computedRef: string,
  recordedRef: string,
  okText: string,
  check: BalanceCheck,
): CellFormulaValue =>
  textFormula(
    `IF(ROUND(${computedRef}-(${recordedRef}),2)=0,"${okText}","Mos kelmadi: farq "&TEXT(ROUND(${computedRef}-(${recordedRef}),2),"#,##0"))`,
    check.text,
  );

/** Eslatma katagi — formulali matn bilan. */
export function addCheckNote(
  ws: Worksheet,
  row: number,
  value: CellFormulaValue,
  check: BalanceCheck,
): number {
  const next = addNote(ws, row, check.text, check.tone);
  ws.getCell(row, 2).value = value;
  return next;
}

/** Fayl chegarasidan oshgan ro'yxat — ochiq aytiladi (jimgina qirqilmaydi). */
export function addTruncationNote(
  ws: Worksheet,
  row: number,
  input: { total: number; shown: number; noun: string },
): number {
  return addNote(
    ws,
    row,
    `DIQQAT: jami ${moneyText(input.total)} ta ${input.noun}, faylda eng so'nggi ${moneyText(input.shown)} tasi. Jami summalar faqat shu qatorlar bo'yicha — davrni qisqartirib qayta yuklang.`,
    'warning',
    2,
  );
}
