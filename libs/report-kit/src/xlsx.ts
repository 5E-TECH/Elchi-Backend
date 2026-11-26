import {
  Workbook,
  type Alignment,
  type Border,
  type Borders,
  type Cell,
  type CellFormulaValue,
  type CellValue,
  type Fill,
  type Font,
  type Style,
  type Worksheet,
} from 'exceljs';
import './exceljs-fix';
import { ELCHI_LOGO_NAVY_PNG_BASE64 } from './assets/logo';

/**
 * ELCHI EXCEL HISOBOTLARI — yagona dizayn to'plami (ega tasdiqlagan, 2026-11-25).
 *
 * Har hisobot: navy lenta (logotip, nom, davr / raqam) → ma'lumot juftliklari →
 * ko'rsatkich kartalari → bo'lim + jadval → JAMI. Qoidalar:
 *  - summa — haqiqiy SON («so'm» sarlavhada), sana — haqiqiy Excel sanasi
 *    (`toExcelDate`), jami — formula;
 *  - rang ma'no uchun: yashil — kirim / mos, qizil — chiqim / kamomad, sariq —
 *    ogohlantirish;
 *  - A4, bitta bet kengligida; kontent B ustundan (A — chekka).
 *
 * `exceljs` katta kutubxona — shu sabab `@app/common` da emas, alohida lib.
 */

export const REPORT_COLORS = {
  navy: 'FF1F2853',
  navyLine: 'FF3A4470',
  navMuted: 'FFB9C3E6',
  action: 'FF2B50D8',
  actionSoft: 'FFE8EDFD',
  canvas: 'FFF6F8FC',
  sunken: 'FFF0F3F9',
  white: 'FFFFFFFF',
  border: 'FFE1E6F0',
  borderStrong: 'FFC9D1E0',
  text: 'FF101733',
  muted: 'FF4B5575',
  subtle: 'FF7C859F',
  success: 'FF12704F',
  successSoft: 'FFE3F4EC',
  warning: 'FF95560A',
  warningSoft: 'FFFCF0DC',
  danger: 'FFBE2A3B',
  dangerSoft: 'FFFDE8EA',
  info: 'FF1A62A8',
  infoSoft: 'FFE2EFFA',
} as const;
const C = REPORT_COLORS;

export type ReportTone =
  'success' | 'warning' | 'danger' | 'info' | 'action' | 'neutral';

/** Ton → [matn, fon]. */
export const REPORT_TONES: Record<ReportTone, readonly [string, string]> = {
  success: [C.success, C.successSoft],
  warning: [C.warning, C.warningSoft],
  danger: [C.danger, C.dangerSoft],
  info: [C.info, C.infoSoft],
  action: [C.action, C.actionSoft],
  neutral: [C.muted, C.sunken],
};

export const REPORT_FONT = 'Arial';

/** Katak formatlari (`numFmt`). */
export const REPORT_FMT = {
  som: '#,##0;[Red]-#,##0;0',
  /** 0 — «—». */
  somDash: '#,##0;[Red]-#,##0;"—";@',
  /** Ishorali; 0 — «0» («+0» emas). */
  signed: '+#,##0;[Red]-#,##0;0',
  int: '#,##0',
  pct: '0.0%',
  date: 'dd.mm.yyyy',
  dateTime: 'dd.mm.yyyy hh:mm',
  time: 'hh:mm',
  text: '@',
} as const;
const F = REPORT_FMT;
const LEFT_FORMATS = new Set<string>([F.text, F.date, F.dateTime, F.time]);

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ───────────────────────── uslub bo'laklari ─────────────────────────

const fills = new Map<string, Fill>();
export const solid = (argb: string): Fill => {
  let value = fills.get(argb);
  if (!value) {
    value = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    fills.set(argb, value);
  }
  return value;
};

export const edge = (
  argb: string = C.border,
  style: Border['style'] = 'thin',
): Border => ({ style, color: { argb } });

export interface ReportFontOptions {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}
const fonts = new Map<string, Partial<Font>>();
/** Uslub obyektlari qayta ishlatiladi — katta eksportda xotira tejaladi. */
export const reportFont = (o: ReportFontOptions = {}): Partial<Font> => {
  const key = `${o.size ?? 10}|${o.bold ? 1 : 0}|${o.italic ? 1 : 0}|${o.color ?? C.text}`;
  let value = fonts.get(key);
  if (!value) {
    value = {
      name: REPORT_FONT,
      size: o.size ?? 10,
      ...(o.bold ? { bold: true } : {}),
      ...(o.italic ? { italic: true } : {}),
      color: { argb: o.color ?? C.text },
    };
    fonts.set(key, value);
  }
  return value;
};

/** 1 → A, 27 → AA. */
export const columnLetter = (index: number): string => {
  let rest = index;
  let letters = '';
  while (rest > 0) {
    const r = (rest - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
};

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
/**
 * Lahza → Excel sanasi: katakda Toshkent soati ko'rinadi (Excel sanada mintaqa
 * yo'q). Yaroqsiz / bo'sh — `null` (katak bo'sh).
 */
export const toExcelDate = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return null;
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? null
    : new Date(at.getTime() + TASHKENT_OFFSET_MS);
};

/** Formula + hisoblangan natija (natijasiz ko'ruvchilar 0 ko'rsatmasin). */
export const formula = (text: string, result: number): CellFormulaValue => ({
  formula: text,
  result,
  date1904: false,
});

// ───────────────────────── ish kitobi va varaq ─────────────────────────

export const createReport = (
  title: string,
  now: Date = new Date(),
): Workbook => {
  const workbook = new Workbook();
  workbook.creator = 'Elchi Pochta';
  workbook.title = title;
  workbook.created = now;
  // Fayl ochilganda formulalar qayta hisoblansin.
  workbook.calcProperties = { fullCalcOnLoad: true };
  return workbook;
};

export const reportToBuffer = async (workbook: Workbook): Promise<Buffer> =>
  Buffer.from(await workbook.xlsx.writeBuffer());

export interface ReportSheetOptions {
  tab?: string;
  orientation?: 'portrait' | 'landscape';
  /** Muzlatilgan qatorlar (jadval sarlavhasi bilan). */
  freeze?: number;
  freezeColumns?: number;
  /** Sahifa osti matni (sukut — varaq nomi). */
  footer?: string;
}

const lastColumns = new WeakMap<Worksheet, number>();
/** Kontentning oxirgi ustuni (A va oxirgi — chekka). */
export const lastColumn = (ws: Worksheet): number =>
  lastColumns.get(ws) ?? Math.max(2, ws.columnCount - 1);

/** Chop etish kolontituli ichida `&` — buyruq belgisi. */
const footerText = (value: string) => value.replace(/&/g, '&&').slice(0, 120);

/** Varaq: A va oxirgi ustun — chekka, `widths` — B, C, D … kengligi (belgi). */
export function addReportSheet(
  workbook: Workbook,
  name: string,
  widths: readonly number[],
  o: ReportSheetOptions = {},
): Worksheet {
  const ws = workbook.addWorksheet(name, {
    properties: { tabColor: { argb: o.tab ?? C.navy }, defaultRowHeight: 18 },
    views: [
      o.freeze
        ? {
            state: 'frozen',
            ySplit: o.freeze,
            xSplit: o.freezeColumns ?? 0,
            showGridLines: false,
            zoomScale: 100,
          }
        : { showGridLines: false, zoomScale: 100 },
    ],
    pageSetup: {
      paperSize: 9,
      orientation: o.orientation ?? 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.6,
        header: 0.2,
        footer: 0.3,
      },
    },
    headerFooter: {
      oddFooter: `&L&8&K7C859FElchi Pochta · ${footerText(o.footer ?? name)}&R&8&K7C859FSahifa &P / &N`,
    },
  });
  ws.columns = [
    { width: 2 },
    ...widths.map((width) => ({ width })),
    { width: 2 },
  ];
  lastColumns.set(ws, widths.length + 1);
  return ws;
}

/** Ustun kengligi (px) — logotip va yorliqlar kesilmasin. */
export const columnPx = (ws: Worksheet, column: number): number =>
  Math.round((ws.getColumn(column).width ?? 9) * 7 + 5);

/** `from` dan boshlab kamida `need` px yig'iladigan oxirgi ustun. */
export const columnUntil = (
  ws: Worksheet,
  from: number,
  need: number,
  max: number,
): number => {
  let width = 0;
  for (let column = from; column <= max; column += 1) {
    width += columnPx(ws, column);
    if (width >= need) return column;
  }
  return max;
};

export const eachCell = (
  ws: Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  fn: (cell: Cell, row: number, column: number) => void,
): void => {
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) fn(ws.getCell(r, c), r, c);
  }
};

const merge = (
  ws: Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): void => {
  if (r2 > r1 || c2 > c1) ws.mergeCells(r1, c1, r2, c2);
};

// ───────────────────────── bloklar ─────────────────────────

export interface ReportBanner {
  title: string;
  subtitle?: string;
  /** O'ng tomon: raqam / davr / son. */
  right?: string;
  rightSub?: string;
}

/** Navy lenta (1–4-qator). Keyingi bo'sh qator — 6. */
export function addBanner(ws: Worksheet, o: ReportBanner): number {
  const L = lastColumn(ws);
  [8, 24, 18, 8].forEach((height, i) => {
    ws.getRow(i + 1).height = height;
  });
  const navy = edge(C.navy);
  eachCell(ws, 1, 1, 4, L + 1, (cell) => {
    cell.fill = solid(C.navy);
    // Quick Look (telefon ko'rinishi) kataklar orasida och chiziq chizmasin.
    cell.border = { top: navy, left: navy, bottom: navy, right: navy };
  });
  const c0 = Math.max(3, Math.min(L - 1, columnUntil(ws, 2, 104, L - 1) + 1));
  let total = 0;
  for (let c = 2; c <= L; c += 1) total += columnPx(ws, c);
  const half = o.right
    ? Math.max(c0, columnUntil(ws, 2, total * 0.66, L - 1))
    : L;
  merge(ws, 2, c0, 2, half);
  merge(ws, 3, c0, 3, half);
  const title = ws.getCell(2, c0);
  title.value = o.title;
  title.font = reportFont({ size: 15, bold: true, color: C.white });
  title.alignment = { vertical: 'middle' };
  const subtitle = ws.getCell(3, c0);
  subtitle.value = o.subtitle ?? '';
  subtitle.font = reportFont({ size: 9, color: C.navMuted });
  subtitle.alignment = { vertical: 'middle' };
  if (o.right && half < L) {
    merge(ws, 2, half + 1, 2, L);
    merge(ws, 3, half + 1, 3, L);
    const right = ws.getCell(2, half + 1);
    right.value = o.right;
    right.font = reportFont({ size: 13, bold: true, color: C.white });
    right.alignment = { horizontal: 'right', vertical: 'middle' };
    const sub = ws.getCell(3, half + 1);
    sub.value = o.rightSub ?? '';
    sub.font = reportFont({ size: 9, color: C.navMuted });
    sub.alignment = { horizontal: 'right', vertical: 'middle' };
  }
  // Rasm ko'rsatmaydigan ko'ruvchida (Quick Look) yozuv chiqadi; Excel'da
  // navy fonli logotip uni yopib turadi.
  const mark = ws.getCell(2, 2);
  mark.value = 'ELCHI POCHTA';
  mark.font = reportFont({ size: 8, bold: true, color: C.white });
  mark.alignment = { vertical: 'middle' };
  const image = ws.workbook.addImage({
    base64: ELCHI_LOGO_NAVY_PNG_BASE64,
    extension: 'png',
  });
  ws.addImage(image, {
    tl: { col: 1.1, row: 1.25 },
    ext: { width: 88, height: 29 },
  });
  ws.getRow(5).height = 8;
  return 6;
}

export interface ReportMetaItem {
  label: string;
  value: CellValue;
  fmt?: string;
  tone?: ReportTone;
  bold?: boolean;
}

/** «Yorliq — qiymat» juftliklari (`perRow` ta yonma-yon). */
export function addMeta(
  ws: Worksheet,
  row: number,
  items: readonly ReportMetaItem[],
  perRow = 2,
): number {
  const L = lastColumn(ws);
  const width = Math.floor((L - 1) / perRow);
  items.forEach((item, i) => {
    const slot = i % perRow;
    const r = row + Math.floor(i / perRow);
    const c1 = 2 + slot * width;
    const c2 = slot === perRow - 1 ? L : c1 + width - 1;
    const label = Math.max(
      1,
      Math.min(c2 - c1, columnUntil(ws, c1, 96, c2 - 1) - c1 + 1),
    );
    ws.getRow(r).height = 18;
    merge(ws, r, c1, r, c1 + label - 1);
    const a = ws.getCell(r, c1);
    a.value = item.label;
    a.font = reportFont({ size: 9, color: C.muted });
    a.alignment = { vertical: 'middle' };
    merge(ws, r, c1 + label, r, c2);
    const b = ws.getCell(r, c1 + label);
    b.value = item.value;
    b.font = reportFont({
      bold: item.bold !== false,
      color: item.tone ? REPORT_TONES[item.tone][0] : C.text,
    });
    b.alignment = { vertical: 'middle', horizontal: 'left' };
    if (item.fmt) b.numFmt = item.fmt;
    eachCell(ws, r, c1, r, c2, (cell) => {
      cell.border = { bottom: edge() };
    });
  });
  return row + Math.ceil(items.length / perRow) + 1;
}

export interface ReportKpi {
  label: string;
  value: CellValue;
  fmt?: string;
  tone?: ReportTone;
  sub?: string;
}

/** Ko'rsatkich kartalari — bitta qatorda (3 qator balandlik). */
export function addKpis(
  ws: Worksheet,
  row: number,
  items: readonly ReportKpi[],
): number {
  const L = lastColumn(ws);
  ws.getRow(row).height = 16;
  ws.getRow(row + 1).height = 24;
  ws.getRow(row + 2).height = 15;
  let start = 2;
  items.forEach((item, i) => {
    const end =
      i === items.length - 1
        ? L
        : 2 + Math.round(((L - 1) * (i + 1)) / items.length) - 1;
    const [fg, bg] = item.tone
      ? REPORT_TONES[item.tone]
      : ([C.text, C.sunken] as const);
    for (let d = 0; d < 3; d += 1) {
      merge(ws, row + d, start, row + d, end);
      eachCell(ws, row + d, start, row + d, end, (cell) => {
        cell.fill = solid(bg);
        cell.border = {
          left: edge(C.white, 'thick'),
          ...(d === 0
            ? { top: edge(item.tone ? fg : C.borderStrong, 'medium') }
            : {}),
        };
      });
    }
    const label = ws.getCell(row, start);
    label.value = item.label;
    label.font = reportFont({ size: 8.5, color: C.muted });
    label.alignment = { vertical: 'middle', indent: 1 };
    const value = ws.getCell(row + 1, start);
    value.value = item.value;
    value.font = reportFont({ size: 15, bold: true, color: fg });
    value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    value.numFmt = item.fmt ?? F.som;
    const sub = ws.getCell(row + 2, start);
    sub.value = item.sub ?? '';
    sub.font = reportFont({ size: 8, color: C.subtle });
    sub.alignment = { vertical: 'top', indent: 1 };
    start = end + 1;
  });
  ws.getRow(row + 3).height = 10;
  return row + 4;
}

/** Bo'lim sarlavhasi (o'ngda qisqa izoh). */
export function addSection(
  ws: Worksheet,
  row: number,
  title: string,
  note?: string,
): number {
  const L = lastColumn(ws);
  ws.getRow(row).height = 22;
  const split = note ? Math.max(3, Math.ceil(L * 0.55)) : L;
  const left = Math.min(split, L);
  merge(ws, row, 2, row, left);
  const a = ws.getCell(row, 2);
  a.value = title;
  a.font = reportFont({ size: 11.5, bold: true, color: C.navy });
  a.alignment = { vertical: 'middle' };
  if (note && left < L) {
    merge(ws, row, left + 1, row, L);
    const b = ws.getCell(row, left + 1);
    b.value = note;
    b.font = reportFont({ size: 9, color: C.subtle });
    b.alignment = { vertical: 'middle', horizontal: 'right' };
  }
  eachCell(ws, row, 2, row, L, (cell) => {
    cell.border = { bottom: edge(C.navy, 'medium') };
  });
  return row + 1;
}

export interface ReportColumn<T> {
  header: string;
  /** Katak qiymati (qator va uning Excel qatori raqami). */
  value: (row: T, excelRow: number) => CellValue;
  fmt?: string;
  align?: Alignment['horizontal'];
  /** Nechta Excel ustunini egallaydi. */
  span?: number;
  bold?: boolean;
  color?: string;
  tone?: (row: T) => ReportTone | undefined;
  /** Katak foni ham ton rangida (holat belgisi). */
  badge?: boolean;
  wrap?: boolean;
  /** JAMI qatorida SUM formula. */
  sum?: boolean;
  /** JAMI qatorida tayyor qiymat (`sum` bo'lmasa). */
  totalValue?: CellValue;
}

export interface ReportTableOptions<T> {
  columns: ReadonlyArray<ReportColumn<T>>;
  rows: readonly T[];
  total?: boolean;
  totalLabel?: string;
  /** Boshlanish ustuni (sukut — B). */
  startColumn?: number;
  zebra?: boolean;
  filter?: boolean;
  rowHeight?: number;
  rowTone?: (row: T) => ReportTone | undefined;
  empty?: string;
}

export interface ReportTableResult {
  /** Jadvaldan keyingi bo'sh qator. */
  next: number;
  header: number;
  first: number;
  last: number;
  totalRow: number | null;
  /** Har ustunning [birinchi, oxirgi] Excel ustuni. */
  columns: Array<readonly [number, number]>;
}

const cellNumber = (value: CellValue): number => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'result' in value) {
    return typeof value.result === 'number' ? value.result : 0;
  }
  return 0;
};

/** Jadval: navy sarlavha, zebra, JAMI qatori (formula). */
export function addTable<T>(
  ws: Worksheet,
  row: number,
  o: ReportTableOptions<T>,
): ReportTableResult {
  const zebra = o.zebra !== false;
  const startColumn = o.startColumn ?? 2;
  const positions: Array<readonly [number, number]> = [];
  let cursor = startColumn;
  for (const column of o.columns) {
    const span = column.span ?? 1;
    positions.push([cursor, cursor + span - 1]);
    cursor += span;
  }
  const lastCol = cursor - 1;
  const align = (column: ReportColumn<T>): Alignment['horizontal'] =>
    column.align ??
    (column.fmt && !LEFT_FORMATS.has(column.fmt) ? 'right' : 'left');
  const indent = (column: ReportColumn<T>) =>
    column.align === 'center' || column.badge ? 0 : 1;

  ws.getRow(row).height = 24;
  o.columns.forEach((column, i) => {
    const [a, b] = positions[i];
    merge(ws, row, a, row, b);
    eachCell(ws, row, a, row, b, (cell) => {
      cell.fill = solid(C.navy);
      cell.border = { right: edge(C.navyLine) };
    });
    const header = ws.getCell(row, a);
    header.value = column.header;
    header.font = reportFont({ size: 9, bold: true, color: C.white });
    header.alignment = {
      vertical: 'middle',
      horizontal: align(column),
      wrapText: true,
      indent: column.align === 'center' ? 0 : 1,
    };
  });

  const first = row + 1;
  let r = first;
  if (!o.rows.length) {
    merge(ws, r, startColumn, r, lastCol);
    const empty = ws.getCell(r, startColumn);
    empty.value = o.empty ?? "Ma'lumot yo'q";
    empty.font = reportFont({ italic: true, color: C.subtle });
    empty.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(r).height = 24;
    eachCell(ws, r, startColumn, r, lastCol, (cell) => {
      cell.border = { bottom: edge() };
    });
    r += 1;
  }

  // Uslublar (ustun × fon × ton) bir marta quriladi va qayta ishlatiladi.
  const rowBorder: Partial<Borders> = { bottom: edge() };
  const styles = new Map<string, Partial<Style>>();
  const styleOf = (
    i: number,
    background: string,
    tone: ReportTone | undefined,
  ): Partial<Style> => {
    const key = `${i}|${background}|${tone ?? ''}`;
    let style = styles.get(key);
    if (!style) {
      const column = o.columns[i];
      style = {
        font: reportFont({
          bold: Boolean(column.bold || (column.badge && tone)),
          size: column.badge ? 9 : 10,
          color: tone ? REPORT_TONES[tone][0] : (column.color ?? C.text),
        }),
        fill: solid(column.badge && tone ? REPORT_TONES[tone][1] : background),
        border: rowBorder,
        alignment: {
          vertical: column.wrap ? 'top' : 'middle',
          horizontal: column.align ?? (column.badge ? 'center' : align(column)),
          wrapText: Boolean(column.wrap),
          indent: indent(column),
        },
        ...(column.fmt ? { numFmt: column.fmt } : {}),
      };
      styles.set(key, style);
    }
    return style;
  };
  const totals = o.columns.map(() => 0);
  o.rows.forEach((item, index) => {
    ws.getRow(r).height = o.rowHeight ?? 18;
    const rowTone = o.rowTone?.(item);
    const background = rowTone
      ? REPORT_TONES[rowTone][1]
      : zebra && index % 2
        ? C.canvas
        : C.white;
    o.columns.forEach((column, i) => {
      const [a, b] = positions[i];
      const style = styleOf(i, background, column.tone?.(item));
      // Nusxa: keyingi o'zgartirish (masalan bitta katak shrifti) boshqa
      // kataklarga o'tmasin.
      for (let c = a; c <= b; c += 1) ws.getCell(r, c).style = { ...style };
      merge(ws, r, a, r, b);
      const value = column.value(item, r);
      ws.getCell(r, a).value = value;
      if (column.sum) totals[i] += cellNumber(value);
    });
    r += 1;
  });

  let totalRow: number | null = null;
  if (o.total && o.rows.length) {
    totalRow = r;
    ws.getRow(r).height = 22;
    o.columns.forEach((column, i) => {
      const [a, b] = positions[i];
      merge(ws, totalRow!, a, totalRow!, b);
      eachCell(ws, totalRow!, a, totalRow!, b, (cell) => {
        cell.fill = solid(C.actionSoft);
        cell.border = {
          top: edge(C.action, 'medium'),
          bottom: edge(C.action, 'thin'),
        };
      });
      const cell = ws.getCell(totalRow!, a);
      if (column.sum) {
        const letter = columnLetter(a);
        cell.value = formula(
          `SUM(${letter}${first}:${letter}${totalRow! - 1})`,
          totals[i],
        );
      } else if (column.totalValue !== undefined) {
        cell.value = column.totalValue;
      } else if (i === 0) {
        cell.value = o.totalLabel ?? 'JAMI';
      }
      cell.font = reportFont({ bold: true, color: C.navy });
      cell.alignment = {
        vertical: 'middle',
        horizontal: align(column),
        indent: column.align === 'center' ? 0 : 1,
      };
      if (column.fmt) cell.numFmt = column.fmt;
    });
    r += 1;
  }
  if (o.filter && o.rows.length) {
    ws.autoFilter = {
      from: { row, column: startColumn },
      to: { row: first + o.rows.length - 1, column: lastCol },
    };
  }
  ws.getRow(r).height = 10;
  return {
    next: r + 1,
    header: row,
    first,
    last: first + o.rows.length - 1,
    totalRow,
    columns: positions,
  };
}

/** Rangli eslatma (ogohlantirish / nazorat natijasi). */
export function addNote(
  ws: Worksheet,
  row: number,
  text: string,
  tone: ReportTone = 'info',
  rows = 1,
): number {
  const L = lastColumn(ws);
  const [fg, bg] = REPORT_TONES[tone];
  merge(ws, row, 2, row + rows - 1, L);
  eachCell(ws, row, 2, row + rows - 1, L, (cell) => {
    cell.fill = solid(bg);
  });
  for (let i = 0; i < rows; i += 1) ws.getRow(row + i).height = 18;
  const cell = ws.getCell(row, 2);
  cell.value = text;
  cell.font = reportFont({ size: 9, color: fg });
  cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
  cell.border = { left: edge(fg, 'thick') };
  return row + rows + 1;
}

/** Imzo satrlari («Topshirdi», «Qabul qildi», «Sana»). */
export function addSignatures(
  ws: Worksheet,
  row: number,
  labels: readonly string[],
): number {
  const L = lastColumn(ws);
  ws.getRow(row).height = 26;
  ws.getRow(row + 1).height = 14;
  let start = 2;
  labels.forEach((label, i) => {
    const end =
      i === labels.length - 1
        ? L
        : 2 + Math.round(((L - 1) * (i + 1)) / labels.length) - 1;
    const to = Math.max(start, end - (i < labels.length - 1 ? 1 : 0));
    merge(ws, row, start, row, to);
    merge(ws, row + 1, start, row + 1, to);
    eachCell(ws, row, start, row, to, (cell) => {
      cell.border = { bottom: edge(C.borderStrong) };
    });
    const cell = ws.getCell(row + 1, start);
    cell.value = label;
    cell.font = reportFont({ size: 8.5, color: C.muted });
    start = end + 1;
  });
  return row + 3;
}

/** Ustundagi ulush chizig'i (Excel data bar). Oqimli yozuvchida ISHLAMAYDI. */
export function addDataBars(
  ws: Worksheet,
  ref: string,
  argb: string = C.action,
): void {
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: 'dataBar',
        priority: 1,
        gradient: false,
        minLength: 0,
        maxLength: 100,
        cfvo: [{ type: 'num', value: 0 }, { type: 'max' }],
        color: { argb },
      } as never,
    ],
  });
}
