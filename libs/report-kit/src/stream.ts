import {
  stream as excelStream,
  type Alignment,
  type Cell,
  type CellFormulaValue,
  type CellValue,
  type Style,
  type Workbook,
  type Worksheet,
} from 'exceljs';
import { PassThrough, type Writable } from 'node:stream';
import {
  REPORT_COLORS as C,
  REPORT_FMT as F,
  REPORT_TONES,
  addBanner,
  addSection,
  addTable,
  columnLetter,
  columnPx,
  columnUntil,
  createReport,
  eachCell,
  edge,
  formula,
  lastColumn,
  reportFont,
  reportToBuffer,
  solid,
  toExcelDate,
  type ReportBanner,
  type ReportColumn,
  type ReportKpi,
  type ReportTone,
} from './xlsx';

/**
 * KENG RO'YXATLAR (buyurtma, pochta, ombor) — `xlsx.ts` ustidagi yordamchilar.
 *
 * Hammasi qatorma-qator ishlaydi: oddiy `Workbook` varag'ida ham, exceljs
 * OQIMLI yozuvchisida (`WorkbookWriter`, qator yozilgach `commit`) ham — 50 000
 * qator xotirada to'planmaydi. Uslub obyektlari (ustun × fon × ton) bir marta
 * quriladi va qayta ishlatiladi.
 *
 * Oqimda rasm ham, Excel data bar ham yo'q (exceljs buzuq XML yozadi): logotip
 * o'rniga «ELCHI POCHTA» yozuvi (`addTextBanner`), ulush chizig'i — `REPT("█")`.
 */

/** Raqamli ID (guruhlanmaydi: 184327). */
export const LIST_ID_FMT = '0';
/** «28 ta». */
export const LIST_COUNT_FMT = '#,##0" ta"';
/** «Xulosa» varag'i setkasi: 6 ustun (nom 2, soni, ulush, chiziq, summa). */
export const SUMMARY_WIDTHS: readonly number[] = [14, 14, 13, 13, 15, 16];

/** `#,##0" ta buyurtma"` — birlik matni format ichida xavfsiz. */
export const countFormat = (unit: string): string =>
  `#,##0" ${unit.replace(/["\\]/g, '').slice(0, 30)}"`;

/** 12 340 — matn ichidagi son (katakda — haqiqiy son + format). */
export const groupDigits = (value: number): string =>
  String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Lahza → `25.11.2026 04:41` (Toshkent); yaroqsiz — bo'sh. */
export const reportDateTime = (value: unknown): string => {
  const at = toExcelDate(value);
  if (!at) return '';
  const iso = at.toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
};

// ───────────────────────── ish kitobi ─────────────────────────

/** Oqimli ish kitobi: yozilgan qator darhol `output` ga ketadi. */
export const createStreamReport = (
  output: Writable,
  title: string,
  now: Date = new Date(),
) => {
  const workbook = new excelStream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'Elchi Pochta';
  workbook.title = title;
  workbook.created = now;
  return workbook;
};

export interface ReportBook {
  workbook: Workbook;
  /** Logotipli (xotirada) yoki yozuvli (oqimda) banner. */
  banner: (ws: Worksheet, o: ReportBanner) => number;
  /** Oqimda tayyor qator(lar)ni yozib yuboradi; xotirada — hech narsa. */
  commitRow: (ws: Worksheet, row: number) => void;
  commitSheet: (ws: Worksheet) => void;
  finish: () => Promise<Buffer>;
}

/**
 * Bufer qaytaradigan eksport: kichik fayl — xotirada (logotip bilan), katta
 * ro'yxat (`streamed`) — oqimli yozuvchi (kataklar xotirada qolmaydi).
 */
export function openReportBook(
  title: string,
  o: { streamed?: boolean; now?: Date } = {},
): ReportBook {
  if (!o.streamed) {
    const workbook = createReport(title, o.now);
    return {
      workbook,
      banner: addBanner,
      commitRow: () => undefined,
      commitSheet: () => undefined,
      finish: () => reportToBuffer(workbook),
    };
  }
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    output.on('end', resolve);
    output.on('error', reject);
  });
  const workbook = createStreamReport(output, title, o.now);
  return {
    workbook,
    banner: addTextBanner,
    commitRow: (ws, row) => ws.getRow(row).commit(),
    commitSheet: (ws) => ws.commit(),
    finish: async () => {
      await workbook.commit();
      await ended;
      return Buffer.concat(chunks);
    },
  };
}

// ───────────────────────── bloklar ─────────────────────────

const mergeCells = (
  ws: Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): void => {
  if (r2 > r1 || c2 > c1) ws.mergeCells(r1, c1, r2, c2);
};

/** Logotipsiz banner («ELCHI POCHTA» yozuvi) — oqimli varaq uchun. */
export function addTextBanner(ws: Worksheet, o: ReportBanner): number {
  const L = lastColumn(ws);
  [18, 24, 18, 8, 8].forEach((height, i) => {
    ws.getRow(i + 1).height = height;
  });
  const navy = edge(C.navy);
  eachCell(ws, 1, 1, 4, L + 1, (cell) => {
    cell.fill = solid(C.navy);
    cell.border = { top: navy, left: navy, bottom: navy, right: navy };
  });
  mergeCells(ws, 1, 2, 1, columnUntil(ws, 2, 130, L));
  const mark = ws.getCell(1, 2);
  mark.value = 'ELCHI POCHTA';
  mark.font = reportFont({ size: 8, bold: true, color: C.navMuted });
  mark.alignment = { vertical: 'bottom' };

  let total = 0;
  for (let c = 2; c <= L; c += 1) total += columnPx(ws, c);
  const half = o.right
    ? Math.max(2, columnUntil(ws, 2, total * 0.66, L - 1))
    : L;
  mergeCells(ws, 2, 2, 2, half);
  mergeCells(ws, 3, 2, 3, half);
  const title = ws.getCell(2, 2);
  title.value = o.title;
  title.font = reportFont({ size: 15, bold: true, color: C.white });
  title.alignment = { vertical: 'middle' };
  const subtitle = ws.getCell(3, 2);
  subtitle.value = o.subtitle ?? '';
  subtitle.font = reportFont({ size: 9, color: C.navMuted });
  subtitle.alignment = { vertical: 'middle' };
  if (o.right && half < L) {
    mergeCells(ws, 2, half + 1, 2, L);
    mergeCells(ws, 3, half + 1, 3, L);
    const right = ws.getCell(2, half + 1);
    right.value = o.right;
    right.font = reportFont({ size: 13, bold: true, color: C.white });
    right.alignment = { horizontal: 'right', vertical: 'middle' };
    const sub = ws.getCell(3, half + 1);
    sub.value = o.rightSub ?? '';
    sub.font = reportFont({ size: 9, color: C.navMuted });
    sub.alignment = { horizontal: 'right', vertical: 'middle' };
  }
  return 6;
}

/** Ustunlarni kenglik (px) bo'yicha `count` ta deyarli teng bo'lakka bo'ladi. */
export function splitColumns(
  ws: Worksheet,
  count: number,
): Array<readonly [number, number]> {
  const L = lastColumn(ws);
  const widths: number[] = [];
  for (let c = 2; c <= L; c += 1) widths.push(columnPx(ws, c));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const cuts: number[] = [];
  let acc = 0;
  let part = 1;
  for (let j = 0; j < widths.length && part < count; j += 1) {
    const target = (total * part) / count;
    const next = acc + widths[j];
    if (next >= target) {
      const closer = Math.abs(next - target) <= Math.abs(acc - target);
      cuts.push(closer || j === 0 ? j : j - 1);
      part += 1;
    }
    acc = next;
  }
  const parts: Array<readonly [number, number]> = [];
  let start = 0;
  for (const cut of cuts) {
    const end = Math.max(start, cut);
    parts.push([start + 2, end + 2]);
    start = end + 1;
  }
  parts.push([start + 2, L]);
  return parts;
}

const drawKpis = (
  ws: Worksheet,
  row: number,
  items: readonly ReportKpi[],
  o: { heights: readonly number[]; cardRows: number; valueSize: number },
): void => {
  o.heights.forEach((height, i) => {
    ws.getRow(row + i).height = height;
  });
  const parts = splitColumns(ws, items.length);
  items.forEach((item, i) => {
    const [from, to] = parts[i];
    const [fg, bg] = item.tone
      ? REPORT_TONES[item.tone]
      : ([C.text, C.sunken] as const);
    for (let d = 0; d < o.cardRows; d += 1) {
      mergeCells(ws, row + d, from, row + d, to);
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
    label.alignment = { vertical: 'middle', indent: 1 };
    const value = ws.getCell(row + 1, from);
    value.value = item.value;
    value.font = reportFont({ size: o.valueSize, bold: true, color: fg });
    value.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    value.numFmt = item.fmt ?? F.som;
    if (o.cardRows > 2) {
      const sub = ws.getCell(row + 2, from);
      sub.value = item.sub ?? '';
      sub.font = reportFont({ size: 8, color: C.subtle });
      sub.alignment = { vertical: 'top', indent: 1 };
    }
  });
};

/** Past ko'rsatkichlar (2 qator) — ro'yxat ustida, muzlatilgan joyni kam oladi. */
export function addSlimKpis(
  ws: Worksheet,
  row: number,
  items: readonly ReportKpi[],
): number {
  drawKpis(ws, row, items, {
    heights: [15, 21, 8],
    cardRows: 2,
    valueSize: 13,
  });
  return row + 3;
}

/** Kartalar (3 qator), kenglik bo'yicha teng — «Xulosa» varag'i. */
export function addCards(
  ws: Worksheet,
  row: number,
  items: readonly ReportKpi[],
): number {
  drawKpis(ws, row, items, {
    heights: [16, 24, 15, 10],
    cardRows: 3,
    valueSize: 15,
  });
  return row + 4;
}

const ATTENTION = /^DIQQAT:\s*([\s\S]*)$/;

/** «DIQQAT: …» lentasi (butun kenglik). */
export function addAttention(
  ws: Worksheet,
  row: number,
  text: string,
  height = 34,
  tone: ReportTone = 'danger',
): number {
  const L = lastColumn(ws);
  const [fg, bg] = REPORT_TONES[tone];
  ws.getRow(row).height = height;
  mergeCells(ws, row, 2, row, L);
  eachCell(ws, row, 2, row, L, (cell) => {
    cell.fill = solid(bg);
  });
  const cell = ws.getCell(row, 2);
  const match = ATTENTION.exec(text);
  cell.value = match
    ? {
        richText: [
          {
            text: 'DIQQAT: ',
            font: reportFont({ size: 10, bold: true, color: fg }),
          },
          { text: match[1], font: reportFont({ size: 10, color: fg }) },
        ],
      }
    : text;
  cell.font = reportFont({ size: 10, color: fg });
  cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
  cell.border = { left: edge(fg, 'thick') };
  return row + 1;
}

// ───────────────────────── ro'yxat ─────────────────────────

export type ReportListRow = Record<string, unknown>;

export interface ReportListColumn {
  header: string;
  /** Qator obyektidagi kalit. */
  key: string;
  width: number;
  fmt?: string;
  align?: Alignment['horizontal'];
  bold?: boolean;
  color?: string;
  wrap?: boolean;
  /** Holat belgisi: matn va fon ton rangida. */
  badge?: boolean;
  /** Faqat fon (va matn) ton rangida, belgi emas. */
  tint?: boolean;
  tone?: (row: ReportListRow) => ReportTone | undefined;
}

export interface ReportListTotal {
  value: CellValue;
  fmt?: string;
  align?: Alignment['horizontal'];
}

const LEFT_FORMATS = new Set<string>([
  F.text,
  F.date,
  F.dateTime,
  F.time,
  LIST_ID_FMT,
]);

const alignOf = (column: ReportListColumn): Alignment['horizontal'] =>
  column.align ??
  (column.badge
    ? 'center'
    : column.fmt && !LEFT_FORMATS.has(column.fmt)
      ? 'right'
      : 'left');

const indentOf = (align: Alignment['horizontal']) =>
  align === 'center' ? 0 : 1;

/** Excel katagining matn chegarasi — 32 767 belgi. */
const CELL_TEXT_MAX = 32_000;

const scalar = (value: unknown): string | number | boolean | Date | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.slice(0, CELL_TEXT_MAX);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value instanceof Date) return value;
  return null;
};

/** Matn berilgan kenglikda necha qatorga bo'linadi (Arial 10). */
export function wrappedLines(text: string, width: number): number {
  const perLine = Math.max(4, (width * 7 - 12) / 5.85);
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let current = 0;
    lines += 1;
    for (const word of paragraph.split(' ')) {
      if (current && current + 1 + word.length > perLine) {
        lines += 1;
        current = word.length;
      } else {
        current += (current ? 1 : 0) + word.length;
      }
    }
  }
  return lines;
}

/**
 * Bitta ro'yxat: navy sarlavha, zebra qatorlar, filtrga moslashadigan JAMI
 * (`SUBTOTAL`). Kontent B ustundan. Qator yozilgach chaqiruvchi `commit` qiladi.
 */
export class ReportList {
  private readonly styles = new Map<string, Partial<Style>>();
  private readonly rowBorder = { bottom: edge() };
  private readonly wrapColumns: readonly ReportListColumn[];

  constructor(
    private readonly ws: Worksheet,
    readonly columns: readonly ReportListColumn[],
  ) {
    this.wrapColumns = columns.filter((column) => column.wrap);
  }

  header(row: number, height = 26): void {
    this.ws.getRow(row).height = height;
    this.columns.forEach((column, i) => {
      const align = alignOf(column);
      const cell = this.ws.getCell(row, i + 2);
      cell.value = column.header;
      cell.fill = solid(C.navy);
      cell.border = { right: edge(C.navyLine) };
      cell.font = reportFont({ size: 9, bold: true, color: C.white });
      cell.alignment = {
        vertical: 'middle',
        horizontal: align,
        wrapText: true,
        indent: indentOf(align),
      };
    });
  }

  /** `dim` — xira qator (masalan pochtadan chiqib ketgan buyurtma). */
  row(
    row: number,
    item: ReportListRow,
    index: number,
    o: { dim?: boolean } = {},
  ): void {
    const excelRow = this.ws.getRow(row);
    excelRow.height = this.rowHeight(item);
    const background = index % 2 ? C.canvas : C.white;
    this.columns.forEach((column, i) => {
      const cell = excelRow.getCell(i + 2);
      const value = scalar(item[column.key]);
      const blank = value === null;
      const tone = blank ? undefined : column.tone?.(item);
      cell.value = blank ? '—' : value;
      cell.style = this.styleOf(i, background, tone, blank, Boolean(o.dim));
    });
  }

  /** Bo'sh ro'yxat izohi. */
  empty(row: number, text = "Ma'lumot yo'q"): void {
    const last = this.columns.length + 1;
    this.ws.getRow(row).height = 24;
    mergeCells(this.ws, row, 2, row, last);
    eachCell(this.ws, row, 2, row, last, (cell) => {
      cell.border = this.rowBorder;
    });
    const cell = this.ws.getCell(row, 2);
    cell.value = text;
    cell.font = reportFont({ italic: true, color: C.subtle });
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  /** JAMI qatori; `cells` — ustun kaliti bo'yicha. */
  total(
    row: number,
    cells: Readonly<Record<string, ReportListTotal>>,
    label = 'JAMI',
  ): void {
    this.ws.getRow(row).height = 24;
    this.columns.forEach((column, i) => {
      const cell = this.ws.getCell(row, i + 2);
      const total = cells[column.key];
      cell.fill = solid(C.actionSoft);
      cell.border = { top: edge(C.action, 'medium'), bottom: edge(C.action) };
      cell.font = reportFont({ bold: true, color: C.navy });
      if (i === 0) cell.value = label;
      if (total) {
        cell.value = total.value;
        const fmt = total.fmt ?? column.fmt;
        if (fmt) cell.numFmt = fmt;
      }
      const align = i === 0 ? 'left' : (total?.align ?? alignOf(column));
      cell.alignment = {
        vertical: 'middle',
        horizontal: align,
        indent: i === 0 || align === 'center' ? 0 : 1,
      };
    });
  }

  /** `J` — ustun harfi (kalit bo'yicha). */
  letter(key: string): string {
    return columnLetter(
      this.columns.findIndex((column) => column.key === key) + 2,
    );
  }

  /**
   * Filtrga moslashadigan yig'indi (filtr bo'lmasa — oddiy jami).
   * `fn`: 9 — SUM, 2 — COUNT (sonlar), 3 — COUNTA. Bo'sh ro'yxatda formula
   * o'rniga son (teskari diapazon JAMI qatorining o'ziga tushardi).
   */
  subtotal(
    key: string,
    first: number,
    last: number,
    result: number,
    fn: 2 | 3 | 9 = 9,
  ): CellFormulaValue | number {
    if (last < first) return result;
    const letter = this.letter(key);
    return formula(
      `SUBTOTAL(${fn},${letter}${first}:${letter}${last})`,
      result,
    );
  }

  /** Avtofiltr va chop etishda takrorlanadigan sarlavha. */
  finish(headRow: number, first: number, last: number): void {
    if (last >= first) {
      this.ws.autoFilter = {
        from: { row: headRow, column: 2 },
        to: { row: last, column: this.columns.length + 1 },
      };
    }
    this.ws.pageSetup.printTitlesRow = `${headRow}:${headRow}`;
  }

  private rowHeight(item: ReportListRow): number {
    let lines = 1;
    for (const column of this.wrapColumns) {
      const value = item[column.key];
      if (typeof value === 'string' && value) {
        lines = Math.max(lines, wrappedLines(value, column.width));
      }
    }
    // Excel qator balandligi chegarasi — 409 pt.
    return lines === 1 ? 19 : Math.min(400, 6 + 13.2 * lines);
  }

  private styleOf(
    i: number,
    background: string,
    tone: ReportTone | undefined,
    blank: boolean,
    dim: boolean,
  ): Partial<Style> {
    const key = `${i}|${background}|${tone ?? ''}|${blank ? 1 : 0}|${dim ? 1 : 0}`;
    let style = this.styles.get(key);
    if (!style) {
      const column = this.columns[i];
      const align = alignOf(column);
      const tinted = Boolean((column.badge || column.tint) && tone);
      style = {
        fill: solid(tinted && tone ? REPORT_TONES[tone][1] : background),
        border: this.rowBorder,
        font: reportFont({
          size: column.badge ? 9 : 10,
          bold: !blank && Boolean(column.bold || (column.badge && tone)),
          color: blank
            ? C.subtle
            : tone
              ? REPORT_TONES[tone][0]
              : dim
                ? C.subtle
                : (column.color ?? C.text),
        }),
        alignment: {
          vertical: 'middle',
          horizontal: align,
          wrapText: Boolean(column.wrap),
          indent: indentOf(align),
        },
        ...(column.fmt && !blank ? { numFmt: column.fmt } : {}),
      };
      this.styles.set(key, style);
    }
    return style;
  }
}

// ───────────────────────── xulosa ─────────────────────────

export interface ReportGroup {
  name: string;
  count: number;
  sum: number;
  tone?: ReportTone;
}

export interface ReportTallyOptions {
  /** Nomlar tartibi (yo'q nom — oxirida); bo'lmasa soni bo'yicha kamayadi. */
  order?: readonly string[];
  tone?: (name: string) => ReportTone | undefined;
  /** Eng ko'p nechta qator (qolgani «Boshqalar (N ta)»). */
  top?: number;
  others?: string;
}

/** Oqim davomida yig'iladigan guruhlar — xotirada faqat guruhlar soni. */
export class ReportTally {
  private readonly groups = new Map<string, ReportGroup>();

  constructor(private readonly emptyName = "Ko'rsatilmagan") {}

  add(name: string, sum = 0): void {
    const key = name || this.emptyName;
    const group = this.groups.get(key);
    if (group) {
      group.count += 1;
      group.sum += sum;
    } else {
      this.groups.set(key, { name: key, count: 1, sum });
    }
  }

  get(name: string): ReportGroup {
    return this.groups.get(name) ?? { name, count: 0, sum: 0 };
  }

  /** Bir nechta guruh yig'indisi (masalan barcha «bekor» holatlari). */
  total(names: Iterable<string>): { count: number; sum: number } {
    let count = 0;
    let sum = 0;
    for (const name of names) {
      const group = this.groups.get(name);
      count += group?.count ?? 0;
      sum += group?.sum ?? 0;
    }
    return { count, sum };
  }

  list(o: ReportTallyOptions = {}): ReportGroup[] {
    const rows = [...this.groups.values()].map((group) => {
      const tone = o.tone?.(group.name);
      return tone ? { ...group, tone } : { ...group };
    });
    const byCount = (a: ReportGroup, b: ReportGroup) =>
      b.count - a.count || b.sum - a.sum || a.name.localeCompare(b.name);
    if (o.order) {
      const order = o.order;
      const rank = (name: string) => {
        const index = order.indexOf(name);
        return index < 0 ? order.length : index;
      };
      rows.sort((a, b) => rank(a.name) - rank(b.name) || byCount(a, b));
    } else {
      rows.sort(byCount);
    }
    if (!o.top || rows.length <= o.top) return rows;
    const rest = rows.slice(o.top);
    return [
      ...rows.slice(0, o.top),
      {
        name: `${o.others ?? 'Boshqalar'} (${rest.length} ta)`,
        count: rest.reduce((sum, group) => sum + group.count, 0),
        sum: rest.reduce((sum, group) => sum + group.sum, 0),
      },
    ];
  }
}

const BAR_LENGTH = 12;

/** Ulush chizig'i — formula + hisoblangan natija (oqimda data bar yo'q). */
const barValue = (text: string, length: number): CellFormulaValue => ({
  formula: text,
  result: '█'.repeat(Math.max(0, length)),
  date1904: false,
});

export interface ReportShareTable {
  title: string;
  note?: string;
  /** Nom ustuni sarlavhasi. */
  head: string;
  rows: readonly ReportGroup[];
  /** Summa ustuni (LOGIST — yo'q). */
  money?: boolean;
  /** [nom, soni, ulush, chiziq, summa] — ustunlar soni. */
  spans?: readonly [number, number, number, number, number];
  /** Nom — ton rangidagi belgi. */
  badge?: boolean;
  unit?: string;
  sumHead?: string;
}

/** Xulosa jadvali: nom · soni · ulushi · chiziq · summa; JAMI formula bilan. */
export function addShareTable(
  ws: Worksheet,
  row: number,
  o: ReportShareTable,
): number {
  const spans = o.spans ?? [2, 1, 1, 1, 1];
  const start = addSection(ws, row, o.title, o.note);
  const first = start + 1;
  const total = first + o.rows.length;
  const countColumn = 2 + spans[0];
  const shareColumn = countColumn + spans[1];
  const barColumn = shareColumn + spans[2];
  const A = columnLetter(countColumn);
  const B = columnLetter(shareColumn);
  const all = o.rows.reduce((sum, group) => sum + group.count, 0);
  const max = o.rows.reduce((top, group) => Math.max(top, group.count), 1);
  const columns: Array<ReportColumn<ReportGroup>> = [
    {
      header: o.head,
      value: (group) => group.name,
      span: spans[0],
      align: 'left',
      bold: !o.badge,
      ...(o.badge
        ? { badge: true, tone: (group: ReportGroup) => group.tone }
        : {}),
    },
    {
      header: o.unit ?? 'Soni',
      value: (group) => group.count,
      fmt: F.int,
      span: spans[1],
      bold: true,
      sum: true,
    },
    {
      header: 'Ulushi',
      value: (group, k) =>
        formula(
          `IF(${A}$${total}=0,0,${A}${k}/${A}$${total})`,
          all ? group.count / all : 0,
        ),
      fmt: F.pct,
      span: spans[2],
      totalValue: formula(`SUM(${B}${first}:${B}${total - 1})`, all ? 1 : 0),
    },
    {
      header: '',
      value: (group, k) =>
        barValue(
          `REPT("█",ROUND(${A}${k}/MAX(${A}$${first}:${A}$${total - 1})*${BAR_LENGTH},0))`,
          Math.round((group.count / max) * BAR_LENGTH),
        ),
      span: spans[3],
      color: C.action,
      align: 'left',
    },
    ...(o.money === false
      ? []
      : [
          {
            header: o.sumHead ?? "Narxi, so'm",
            value: (group: ReportGroup) => group.sum,
            fmt: F.som,
            span: spans[4],
            sum: true,
          },
        ]),
  ];
  const table = addTable(ws, start, {
    columns,
    rows: o.rows,
    total: true,
  });
  if (o.rows.length) {
    for (let k = table.first; k <= table.last; k += 1) {
      ws.getCell(k, barColumn).font = reportFont({ size: 8, color: C.action });
      if (o.badge) alignBadge(ws.getCell(k, 2));
    }
  }
  return table.next;
}

/** Jadval ichidagi holat belgisi — chapda (nom ustuni). */
export const alignBadge = (cell: Cell): void => {
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
};
