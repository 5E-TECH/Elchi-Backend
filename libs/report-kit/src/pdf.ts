import { inflateSync } from 'zlib';
import PDFDocument from 'pdfkit';
import {
  MANROPE_BOLD_TTF_ZLIB_BASE64,
  MANROPE_MEDIUM_TTF_ZLIB_BASE64,
  MANROPE_SEMIBOLD_TTF_ZLIB_BASE64,
  NOTO_UZ_CYRILLIC_BOLD_TTF_ZLIB_BASE64,
  NOTO_UZ_CYRILLIC_MEDIUM_TTF_ZLIB_BASE64,
} from './assets/fonts';
import { ELCHI_LOGO_NAVY_PNG_BASE64 } from './assets/logo';
import { NBSP, pdfRuns, pdfText } from './pdf-text';
// Faqat tip: `xlsx.ts` (exceljs) PDF quradigan servisga yuklanmasin.
import type { ReportTone } from './xlsx';

export { NBSP, pdfSigned, pdfSom, pdfText } from './pdf-text';

/**
 * ELCHI PDF HISOBOTLARI — Excel to'plami (`xlsx.ts`) bilan bir xil ko'rinish
 * (ega tasdiqlagan, 2026-11-25), pdfkit. A4: navy lenta → ma'lumot juftliklari
 * → ko'rsatkichlar → bo'lim + jadval → JAMI → imzo; har sahifa pastida
 * «Sahifa N / M».
 *
 * `index.ts` da YO'Q — `@app/report-kit/pdf` dan import qilinadi: shriftlar
 * (~190 KB) faqat PDF quradigan servis bundle'iga tushsin.
 */

/** `REPORT_COLORS` bilan bir xil (mosligi spec'da tekshiriladi). */
export const PDF_COLORS = {
  navy: '#1F2853',
  navyLine: '#3A4470',
  navMuted: '#B9C3E6',
  action: '#2B50D8',
  actionSoft: '#E8EDFD',
  canvas: '#F6F8FC',
  sunken: '#F0F3F9',
  white: '#FFFFFF',
  border: '#E1E6F0',
  borderStrong: '#C9D1E0',
  text: '#101733',
  muted: '#4B5575',
  subtle: '#7C859F',
  success: '#12704F',
  successSoft: '#E3F4EC',
  warning: '#95560A',
  warningSoft: '#FCF0DC',
  danger: '#BE2A3B',
  dangerSoft: '#FDE8EA',
  info: '#1A62A8',
  infoSoft: '#E2EFFA',
} as const;
const C = PDF_COLORS;

/** Ton → [matn, fon]. */
export const PDF_TONES: Record<ReportTone, readonly [string, string]> = {
  success: [C.success, C.successSoft],
  warning: [C.warning, C.warningSoft],
  danger: [C.danger, C.dangerSoft],
  info: [C.info, C.infoSoft],
  action: [C.action, C.actionSoft],
  neutral: [C.muted, C.sunken],
};

// ───────────────────────── shriftlar ─────────────────────────

export type PdfWeight = 'medium' | 'semibold' | 'bold';

const FACES = {
  'manrope-medium': MANROPE_MEDIUM_TTF_ZLIB_BASE64,
  'manrope-semibold': MANROPE_SEMIBOLD_TTF_ZLIB_BASE64,
  'manrope-bold': MANROPE_BOLD_TTF_ZLIB_BASE64,
  'noto-medium': NOTO_UZ_CYRILLIC_MEDIUM_TTF_ZLIB_BASE64,
  'noto-bold': NOTO_UZ_CYRILLIC_BOLD_TTF_ZLIB_BASE64,
} as const;
type PdfFace = keyof typeof FACES;

const faceOf = (weight: PdfWeight, noto: boolean): PdfFace =>
  noto
    ? weight === 'medium'
      ? 'noto-medium'
      : 'noto-bold'
    : `manrope-${weight}`;

const decodedFonts = new Map<PdfFace, Buffer>();
/** TTF bir marta ochiladi (zlib) — keyingi hujjatlar tayyor bufferni oladi. */
function fontBuffer(face: PdfFace): Buffer {
  let buffer = decodedFonts.get(face);
  if (!buffer) {
    buffer = inflateSync(Buffer.from(FACES[face], 'base64'));
    decodedFonts.set(face, buffer);
  }
  return buffer;
}

/** Bosh harf balandligining yarmi (em) — vertikal markaz (Manrope 1440/2000). */
const HALF_CAP = 0.36;
/** Son guruhlari orasi: Manrope bo'shlig'i tor (0,2 em) — biroz kengayadi. */
const GROUP_GAP = 0.075;
const GROUPED_NUMBER = /^[+−]?\d{1,3}(?:\u00a0\d{3})+$/;
const NUMBER = /^[+−]?\d[\d\u00a0]*$/;
/** Shundan uzun «so'z» butunlay o'lchanmaydi — harfma-harf bo'linadi. */
const LONG_WORD = 120;

/** Data-URI: pdfkit matn kaliti bo'yicha keshlaydi — hujjatda bitta rasm. */
const LOGO = `data:image/png;base64,${ELCHI_LOGO_NAVY_PNG_BASE64}`;

// ───────────────────────── tiplar ─────────────────────────

export interface PdfReportOptions {
  /** PDF xossasi. */
  title: string;
  /** Pastki chap: «Elchi Pochta · <footer> · Sahifa N / M». */
  footer: string;
  /** `footer` shu kenglikdan oshsa — «…» (sukut: bo'sh joygacha). */
  footerWidth?: number;
  /** Pastki o'ng: «Yaratilgan: …» (Toshkent, `DD.MM.YYYY HH:MM`). */
  createdAt: string;
  /** 2-sahifadan boshlab ingichka lentadagi matn. */
  head?: string;
  /** Zich joylashuv — bir sahifalik hisobot. */
  dense?: boolean;
  /** Chap / o'ng chekka (36). */
  marginX?: number;
  /** Pastki chekka (50, zichda 42). */
  marginBottom?: number;
  /** Test uchun: oqimlar siqilmaydi. */
  compress?: boolean;
}

export interface PdfTextOptions {
  weight?: PdfWeight;
  size?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
}

export interface PdfKpi {
  label: string;
  value: string;
  sub?: string;
  tone?: ReportTone;
}

export interface PdfColumn<T> {
  key: string;
  header: string;
  /** Kenglik ulushi. */
  weight: number;
  value: (row: T) => unknown;
  align?: 'left' | 'center' | 'right';
  font?: PdfWeight;
  color?: string;
  /** Katak rangi; `badge` bo'lsa — fon ham. */
  tone?: (row: T) => ReportTone | null | undefined;
  badge?: boolean;
  /** Qator rangi (`ink`) shu ustunga tegmaydi. */
  plain?: boolean;
  pad?: number;
  maxLines?: number;
}

export interface PdfDataRow<T> {
  data: T;
  /** Qator foni. */
  tone?: ReportTone;
  /** Qator matni rangi. */
  ink?: ReportTone | 'navy';
  bold?: boolean;
}
/** Guruh sarlavhasi (market): nom, izoh, ustun jamilari. */
export interface PdfGroupRow {
  group: string;
  info?: string;
  cells?: Record<string, string>;
}
/** «… yana N ta» qatori. */
export interface PdfMoreRow {
  more: string;
}
export type PdfTableRow<T> = PdfDataRow<T> | PdfGroupRow | PdfMoreRow;

export interface PdfTableOptions<T> {
  columns: PdfColumn<T>[];
  rows: PdfTableRow<T>[];
  /** JAMI qatori: ustun kaliti → matn (qatorsiz jadvalda chiqmaydi). */
  total?: Record<string, string>;
  x?: number;
  w?: number;
  rowHeight?: number;
  zebra?: boolean;
  /** Jadvaldan keyingi majburiy joy (imzo) — oxirgi qatorlar bilan birga. */
  tail?: number;
  empty?: string;
  /** `false` — yonma-yon jadval: sahifalanmaydi, joyni chaqiruvchi ta'minlaydi. */
  paginate?: boolean;
}

interface CellLayout {
  lines: string[];
  size: number;
}
type RowLayout = { height: number; cells: CellLayout[] };

const isGroup = <T>(row: PdfTableRow<T> | undefined): row is PdfGroupRow =>
  row != null && 'group' in row;
const isMore = <T>(row: PdfTableRow<T> | undefined): row is PdfMoreRow =>
  row != null && 'more' in row;

// ───────────────────────── hujjat ─────────────────────────

export class PdfReport {
  readonly width = 595.28;
  readonly height = 841.89;
  /** Kontent chap chegarasi va kengligi. */
  readonly x: number;
  readonly w: number;
  /** Kontent shu yerdan pastga tushmaydi. */
  readonly bottom: number;
  readonly dense: boolean;
  /** Bloklar orasi. */
  readonly gap: number;
  /** Joriy vertikal joy. */
  y = 0;

  private readonly doc: PDFKit.PDFDocument;
  private readonly output: Promise<Buffer>;

  constructor(private readonly options: PdfReportOptions) {
    this.dense = options.dense ?? false;
    this.gap = this.dense ? 12 : 14;
    this.x = options.marginX ?? 36;
    this.w = this.width - this.x * 2;
    this.bottom =
      this.height - (options.marginBottom ?? (this.dense ? 42 : 50));
    this.doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: true,
      autoFirstPage: false,
      lang: 'uz',
      compress: options.compress ?? true,
      info: {
        Title: pdfText(options.title),
        Author: 'Elchi Pochta',
        Creator: 'Elchi Pochta',
      },
    });
    for (const face of Object.keys(FACES) as PdfFace[]) {
      this.doc.registerFont(face, fontBuffer(face));
    }
    const chunks: Buffer[] = [];
    this.output = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    this.doc.addPage();
  }

  // ── matn ──

  /** Normalizatsiyalangan matn kengligi (`putRuns` chizgani bilan bir xil). */
  private measure(text: string, weight: PdfWeight, size: number): number {
    let total = 0;
    for (const run of pdfRuns(text)) {
      this.doc.font(faceOf(weight, run.noto)).fontSize(size);
      total += this.doc.widthOfString(run.text);
    }
    return total + this.groupGap(text, size) * (text.split(NBSP).length - 1);
  }

  private groupGap(text: string, size: number): number {
    return GROUPED_NUMBER.test(text) ? GROUP_GAP * size : 0;
  }

  textWidth(text: unknown, weight: PdfWeight, size: number): number {
    return this.measure(pdfText(text), weight, size);
  }

  /** So'z bo'yicha qatorlarga bo'ladi; sig'maydigan so'z harf bo'yicha. */
  wrap(
    text: unknown,
    w: number,
    weight: PdfWeight,
    size: number,
    maxLines = 0,
  ): string[] {
    const lines: string[] = [];
    const width = (part: string) => this.measure(part, weight, size);
    for (const paragraph of pdfText(text).split('\n')) {
      let line = '';
      /** `line + ' '` kengligi — har so'zda butun qator qayta o'lchanmaydi. */
      let taken = 0;
      for (const rawWord of paragraph.split(' ')) {
        let word = rawWord;
        if (word.length > LONG_WORD || width(word) > w) {
          if (line) lines.push(line);
          const pieces = this.breakWord(word, w, weight, size);
          word = pieces.pop() ?? '';
          lines.push(...pieces);
          line = '';
          taken = 0;
        }
        if (line && taken + width(word) > w) {
          lines.push(line);
          line = word;
          taken = width(`${word} `);
        } else {
          line = line ? `${line} ${word}` : word;
          taken += width(`${word} `);
        }
        if (maxLines && lines.length > maxLines) break;
      }
      lines.push(line);
      if (maxLines && lines.length > maxLines) break;
    }
    if (maxLines && lines.length > maxLines) {
      lines.length = maxLines;
      let last = lines[maxLines - 1];
      while (last && width(`${last}…`) > w) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
    }
    return lines;
  }

  private breakWord(
    word: string,
    w: number,
    weight: PdfWeight,
    size: number,
  ): string[] {
    const pieces: string[] = [];
    const advances = new Map<string, number>();
    let piece = '';
    let taken = 0;
    for (const char of word) {
      let advance = advances.get(char);
      if (advance == null) {
        advance = this.measure(char, weight, size);
        advances.set(char, advance);
      }
      if (piece && taken + advance > w) {
        pieces.push(piece);
        piece = '';
        taken = 0;
      }
      piece += char;
      taken += advance;
    }
    pieces.push(piece);
    return pieces;
  }

  /** Bir qatorga sig'dirilgan matn (ortig'i «…»). */
  fit(text: unknown, w: number, weight: PdfWeight, size: number): string {
    return (
      this.wrap(pdfText(text).replace(/\n/g, ' '), w, weight, size, 1)[0] ?? ''
    );
  }

  /** Matn `w` ga sig'adigan eng katta o'lcham (`min` gacha). */
  private shrink(
    text: string,
    w: number,
    weight: PdfWeight,
    size: number,
    min: number,
    step = 0.5,
  ): number {
    let result = size;
    while (result > min && this.measure(text, weight, result) > w) {
      result = Math.max(min, result - step);
    }
    return result;
  }

  /** Bir qator matn; `cy` — vertikal markaz (bosh harf balandligi bo'yicha). */
  put(
    value: unknown,
    x: number,
    cy: number,
    w: number,
    options: PdfTextOptions = {},
  ): void {
    const text = pdfText(value).replace(/\n/g, ' ');
    if (!text) return;
    const { weight = 'medium', size = 9, color = C.text, align } = options;
    const width = this.measure(text, weight, size);
    const gap = this.groupGap(text, size);
    let px = x;
    if (align === 'right') px = x + w - width;
    else if (align === 'center') px = x + (w - width) / 2;
    this.doc.fillColor(color);
    for (const run of pdfRuns(text)) {
      this.doc.font(faceOf(weight, run.noto)).fontSize(size);
      const advance = this.doc.widthOfString(run.text);
      this.doc.text(run.text, px, cy + HALF_CAP * size, {
        lineBreak: false,
        baseline: 'alphabetic',
        ...(gap ? { wordSpacing: gap } : {}),
      });
      px += advance;
    }
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.doc.rect(x, y, w, h).fill(color);
  }

  hline(
    x: number,
    y: number,
    w: number,
    color: string = C.border,
    lineWidth = 0.6,
  ): void {
    this.doc
      .moveTo(x, y)
      .lineTo(x + w, y)
      .lineWidth(lineWidth)
      .strokeColor(color)
      .stroke();
  }

  private vline(x: number, y1: number, y2: number, lineWidth = 0.6): void {
    this.doc
      .moveTo(x, y1)
      .lineTo(x, y2)
      .lineWidth(lineWidth)
      .strokeColor(C.navyLine)
      .stroke();
  }

  logo(x: number, y: number, w: number): void {
    this.doc.image(LOGO, x, y, { width: w });
  }

  // ── sahifa ──

  /** Yangi sahifa: ingichka lenta (logotip + hujjat nomi). */
  newPage(top = 48): void {
    this.doc.addPage();
    this.rect(0, 0, this.width, 34, C.navy);
    this.logo(this.x, 8.5, 51);
    if (this.options.head) {
      const head = this.fit(this.options.head, this.w - 75, 'semibold', 9.5);
      this.put(head, this.x, 17, this.w, {
        weight: 'semibold',
        size: 9.5,
        color: C.white,
        align: 'right',
      });
    }
    this.y = top;
  }

  /** `h` sig'masa — yangi sahifa. */
  ensure(h: number): boolean {
    if (this.y + h <= this.bottom) return false;
    this.newPage();
    return true;
  }

  // ── bloklar ──

  /** Navy lenta: logotip, nom, izoh, o'ngda raqam / holat. */
  banner(o: {
    title: string;
    subtitle?: string;
    right?: string;
    rightSub?: string;
  }): void {
    const h = this.dense ? 70 : 76;
    const shift = this.dense ? -3 : 0;
    this.rect(0, 0, this.width, h, C.navy);
    this.logo(this.x, 24 + shift, 85);
    const x0 = this.x + 85 + 22;
    this.vline(x0 - 11, 22, h - 22, 0.7);
    const rightW = o.right
      ? Math.max(
          this.textWidth(o.right, 'bold', 17),
          this.textWidth(o.rightSub, 'medium', 9),
        ) + 4
      : 0;
    const w = this.x + this.w - x0 - rightW - 12;
    const size = this.shrink(pdfText(o.title), w, 'bold', 17, 12);
    this.put(this.fit(o.title, w, 'bold', size), x0, 31 + shift, w, {
      weight: 'bold',
      size,
      color: C.white,
    });
    const sub = this.fit(o.subtitle, w, 'medium', 9);
    this.put(sub, x0, 50 + shift, w, { size: 9, color: C.navMuted });
    if (o.right) {
      this.put(o.right, this.x, 31 + shift, this.w, {
        weight: 'bold',
        size: 17,
        color: C.white,
        align: 'right',
      });
      this.put(o.rightSub, this.x, 50 + shift, this.w, {
        size: 9,
        color: C.navMuted,
        align: 'right',
      });
    }
    this.y = h + 10;
  }

  /** Ma'lumot juftliklari: [yorliq, qiymat, ton]. */
  meta(
    pairs: Array<[label: string, value: string, tone?: ReportTone]>,
    { perRow = 2, label = 66, gap = 24 } = {},
  ): void {
    const w = (this.w - gap * (perRow - 1)) / perRow;
    const rowH = this.dense ? 18 : 20;
    for (let i = 0; i < pairs.length; i += perRow) {
      const slot = pairs.slice(i, i + perRow);
      const cells = slot.map(([, value]) =>
        this.wrap(value, w - label, 'semibold', 9.2, 2),
      );
      const h = Math.max(...cells.map((c) => rowH + (c.length - 1) * 12));
      slot.forEach(([name, , tone], j) => {
        const x = this.x + j * (w + gap);
        const cy = this.y + rowH / 2;
        this.put(name, x, cy, label, { size: 8.4, color: C.muted });
        cells[j].forEach((line, n) =>
          this.put(line, x + label, cy + n * 12, w - label, {
            weight: 'semibold',
            size: 9.2,
            color: tone ? PDF_TONES[tone][0] : C.text,
          }),
        );
        this.hline(x, this.y + h, w);
      });
      this.y += h;
    }
    this.y += 12;
  }

  /** Ko'rsatkich kartalari — bir qatorda, teng kenglikda. */
  kpis(items: PdfKpi[]): void {
    const gap = 8;
    const w = (this.w - gap * (items.length - 1)) / items.length;
    const h = 58;
    items.forEach((item, i) => {
      const x = this.x + i * (w + gap);
      const [fg, bg] = item.tone ? PDF_TONES[item.tone] : [C.text, C.sunken];
      this.rect(x, this.y, w, h, bg);
      this.rect(x, this.y, w, 1.6, item.tone ? fg : C.borderStrong);
      this.put(item.label, x + 9, this.y + 13.5, w - 16, {
        size: 8,
        color: C.muted,
      });
      const size = this.shrink(pdfText(item.value), w - 16, 'bold', 15, 8);
      this.put(item.value, x + 9, this.y + 31, w - 16, {
        weight: 'bold',
        size,
        color: fg,
      });
      const subSize = this.shrink(
        pdfText(item.sub),
        w - 14,
        'medium',
        7.6,
        6,
        0.2,
      );
      const sub = this.fit(item.sub, w - 14, 'medium', subSize);
      this.put(sub, x + 9, this.y + 47.5, w - 14, {
        size: subSize,
        color: item.tone ? fg : C.subtle,
      });
    });
    this.y += h + 14;
  }

  /** Bo'lim nomi; `need` — pastidagi blokdan kamida shuncha joy bo'lsin. */
  section(
    title: string,
    note?: string | null,
    { x = this.x, w = this.w, need = 0 } = {},
  ): void {
    if (need) this.ensure(26 + need);
    this.put(title, x, this.y + 9, w, {
      weight: 'bold',
      size: 11.5,
      color: C.navy,
    });
    if (note) {
      const room = w - this.textWidth(title, 'bold', 11.5) - 16;
      this.put(this.fit(note, room, 'medium', 8.4), x, this.y + 9.5, w, {
        size: 8.4,
        color: C.subtle,
        align: 'right',
      });
    }
    this.rect(x, this.y + 19, w, 1.4, C.navy);
    this.y += 20;
  }

  /** Rangli izoh bloki. */
  note(text: string, tone: ReportTone = 'info', title?: string): void {
    const [fg, bg] = PDF_TONES[tone];
    const lines = this.wrap(text, this.w - 24, 'medium', 8.8);
    const h = 13 + lines.length * 12.6 + (title ? 13.5 : 0);
    this.ensure(h);
    this.rect(this.x, this.y, this.w, h, bg);
    this.rect(this.x, this.y, 3, h, fg);
    let cy = this.y + 13;
    if (title) {
      const head = this.fit(title, this.w - 24, 'bold', 9.2);
      this.put(head, this.x + 13, cy, this.w, {
        weight: 'bold',
        size: 9.2,
        color: fg,
      });
      cy += 14;
    }
    lines.forEach((line, i) =>
      this.put(line, this.x + 13, cy + i * 12.6, this.w - 24, {
        size: 8.8,
        color: fg,
      }),
    );
    this.y += h + 10;
  }

  /** Imzo chiziqlari. */
  sign(labels: string[]): void {
    const gap = 28;
    const w = (this.w - gap * (labels.length - 1)) / labels.length;
    this.ensure(this.dense ? 40 : 58);
    this.y += this.dense ? 24 : 30;
    labels.forEach((label, i) => {
      const x = this.x + i * (w + gap);
      this.hline(x, this.y, w, C.borderStrong, 0.8);
      const text = this.fit(label, w, 'semibold', 8.4);
      this.put(text, x, this.y + 10, w, {
        weight: 'semibold',
        size: 8.4,
        color: C.muted,
      });
    });
    this.y += 24;
  }

  /**
   * Jadval. Sahifadan oshsa navy sarlavha (va guruh nomi «… — davomi»)
   * takrorlanadi; guruh sarlavhasi va JAMI yolg'iz qolmaydi. Sig'magan SON
   * bo'linmaydi — kichikroq yoziladi.
   */
  table<T>(o: PdfTableOptions<T>): void {
    const {
      columns,
      rows,
      total,
      x = this.x,
      w = this.w,
      zebra = true,
      tail = 0,
      empty = "Ma'lumot yo'q",
      paginate = true,
    } = o;
    const FS = 9;
    const PAD = 7;
    const rowH = this.dense
      ? Math.min(o.rowHeight ?? 19, 17)
      : (o.rowHeight ?? 19);
    const weights = columns.reduce((s, c) => s + c.weight, 0);
    let left = x;
    const pos = columns.map((c) => {
      const cw = (c.weight / weights) * w;
      const slot = { x: left, w: cw, pad: c.pad ?? PAD };
      left += cw;
      return slot;
    });
    const inner = (i: number) => pos[i].w - pos[i].pad * 2;
    const grouped = rows.some((row) => isGroup(row));

    const headLines = columns.map((c, i) =>
      this.wrap(c.header, inner(i) + 2, 'bold', 8),
    );
    const headH = Math.max(
      this.dense ? 21 : 23,
      12 + Math.max(...headLines.map((l) => l.length)) * 10.5,
    );
    const drawHead = () => {
      this.rect(x, this.y, w, headH, C.navy);
      columns.forEach((c, i) => {
        const lines = headLines[i];
        lines.forEach((line, n) =>
          this.put(
            line,
            pos[i].x + pos[i].pad,
            this.y + headH / 2 + (n - (lines.length - 1) / 2) * 10.5,
            inner(i),
            { weight: 'bold', size: 8, color: C.white, align: c.align },
          ),
        );
        if (i) this.vline(pos[i].x, this.y, this.y + headH);
      });
      this.y += headH;
    };

    const weightOf = (c: PdfColumn<T>, row: PdfDataRow<T>): PdfWeight =>
      c.badge ? 'semibold' : row.bold ? 'bold' : (c.font ?? 'medium');
    const layouts: RowLayout[] = rows.map((row) => {
      if (isGroup(row)) return { height: this.dense ? 19 : 21, cells: [] };
      if (isMore(row)) return { height: 16, cells: [] };
      const cells = columns.map((c, i): CellLayout => {
        const text = pdfText(c.value(row.data));
        const weight = weightOf(c, row);
        const size = c.badge ? 8 : FS;
        return NUMBER.test(text)
          ? {
              lines: [text],
              size: this.shrink(text, inner(i), weight, size, 5, 0.25),
            }
          : {
              lines: this.wrap(text, inner(i), weight, size, c.maxLines ?? 3),
              size,
            };
      });
      const most = Math.max(...cells.map((cell) => cell.lines.length));
      return { height: rowH + (most - 1) * 11.5, cells };
    });
    const totalH = total ? (this.dense ? 20 : 22) : 0;

    // Ajralmas: guruh sarlavhasi + birinchi 2 qator; oxirgi 2 qator + JAMI + tail.
    const keep = rows.map((row, i) => {
      if (isGroup(row)) return true;
      const next = rows[i + 1];
      if (isMore(next)) return true;
      if (next && !isGroup(next)) {
        if (isGroup(rows[i - 1])) return true;
        const after = rows[i + 2];
        if (grouped && (!after || isGroup(after))) return true;
      }
      return i >= rows.length - 2;
    });
    const chain = (from: number): number => {
      let h = 0;
      for (let i = from; i < rows.length; i += 1) {
        h += layouts[i].height;
        if (!keep[i]) return h;
      }
      return h + totalH + tail;
    };

    if (paginate) this.ensure(headH + (rows.length ? chain(0) : 26));
    drawHead();
    let group: string | null = null;
    let stripe = 0;
    if (!rows.length) {
      this.put(empty, x, this.y + 13, w, {
        size: FS,
        color: C.subtle,
        align: 'center',
      });
      this.y += 26;
      this.hline(x, this.y, w);
    }
    rows.forEach((row, i) => {
      const startsChain = i === 0 || !keep[i - 1];
      if (paginate && startsChain && i > 0 && this.y + chain(i) > this.bottom) {
        this.newPage();
        drawHead();
        stripe = 0;
        if (group && !isGroup(row)) {
          this.rect(x, this.y, w, 19, C.sunken);
          const again = `${this.fit(group, w - 90, 'semibold', 8.6)} — davomi`;
          this.put(again, x + PAD, this.y + 9.5, w, {
            weight: 'semibold',
            size: 8.6,
            color: C.muted,
          });
          this.y += 19;
          this.hline(x, this.y, w);
        }
      }
      const { height, cells } = layouts[i];
      const cy = this.y + height / 2;
      if (isMore(row)) {
        this.put(row.more, x + PAD, cy, w, { size: 8.2, color: C.subtle });
      } else if (isGroup(row)) {
        group = row.group;
        stripe = 0;
        this.rect(x, this.y, w, height, C.sunken);
        // Nom birinchi jamili ustungacha; izoh nomdan keyin.
        const firstTotal = columns.findIndex((c) => row.cells?.[c.key] != null);
        const room = (firstTotal > 0 ? pos[firstTotal].x : x + w) - x - PAD * 2;
        const infoW = row.info
          ? this.textWidth(row.info, 'medium', 8.2) + 8
          : 0;
        const name = this.fit(row.group, room - infoW, 'bold', 9.4);
        this.put(name, x + PAD, cy, room, {
          weight: 'bold',
          size: 9.4,
          color: C.navy,
        });
        if (row.info) {
          const infoX = x + PAD + this.textWidth(name, 'bold', 9.4) + 8;
          this.put(row.info, infoX, cy, room, { size: 8.2, color: C.subtle });
        }
        columns.forEach((c, q) =>
          this.putTotal(row.cells?.[c.key], c, pos[q], cy),
        );
      } else {
        const bg = row.tone
          ? PDF_TONES[row.tone][1]
          : zebra && stripe % 2
            ? C.canvas
            : null;
        stripe += 1;
        if (bg) this.rect(x, this.y, w, height, bg);
        columns.forEach((c, q) => {
          const { lines, size } = cells[q];
          const tone = c.tone?.(row.data);
          if (c.badge && tone && lines[0]) {
            const [, soft] = PDF_TONES[tone];
            const { x: bx, w: bw } = pos[q];
            this.rect(bx + 0.5, this.y + 0.5, bw - 1, height - 1, soft);
          }
          let color: string = c.color ?? C.text;
          if (tone) color = PDF_TONES[tone][0];
          else if (row.ink === 'navy') color = C.navy;
          else if (row.ink && !c.plain) color = PDF_TONES[row.ink][0];
          lines.forEach((line, n) =>
            this.put(
              line,
              pos[q].x + pos[q].pad,
              cy + (n - (lines.length - 1) / 2) * 11.5,
              inner(q),
              {
                weight: weightOf(c, row),
                size,
                color,
                align: c.badge ? 'center' : c.align,
              },
            ),
          );
        });
      }
      this.y += height;
      this.hline(x, this.y, w, isGroup(row) ? C.borderStrong : C.border);
    });
    if (total && rows.length) {
      this.rect(x, this.y, w, totalH, C.actionSoft);
      this.rect(x, this.y - 0.4, w, 1.4, C.action);
      const cy = this.y + totalH / 2 + 0.5;
      columns.forEach((c, i) => this.putTotal(total[c.key], c, pos[i], cy));
      this.y += totalH;
      this.hline(x, this.y, w, C.action, 0.7);
    }
    this.y += this.gap;
  }

  /** Guruh / JAMI katagi (sig'magan son kichrayadi). */
  private putTotal<T>(
    value: string | undefined,
    column: PdfColumn<T>,
    slot: { x: number; w: number },
    cy: number,
  ): void {
    if (value == null) return;
    const w = slot.w - 14;
    const text = pdfText(value);
    const size = NUMBER.test(text)
      ? this.shrink(text, w, 'bold', 9, 5, 0.25)
      : 9;
    this.put(text, slot.x + 7, cy, w, {
      weight: 'bold',
      size,
      color: C.navy,
      align: column.align,
    });
  }

  // ── yakun ──

  /** Sahifa raqamlari yoziladi va hujjat yopiladi (bir marta chaqiriladi). */
  toBuffer(): Promise<Buffer> {
    const { count } = this.doc.bufferedPageRange();
    const created = `Yaratilgan: ${this.options.createdAt}`;
    const footer = this.fit(
      this.options.footer,
      this.options.footerWidth ?? this.w - 250,
      'medium',
      7.8,
    );
    for (let i = 0; i < count; i += 1) {
      this.doc.switchToPage(i);
      const y = this.height - 34;
      this.hline(this.x, y, this.w);
      const left = `Elchi Pochta · ${footer} · Sahifa ${i + 1} / ${count}`;
      this.put(left, this.x, y + 13, this.w, { size: 7.8, color: C.subtle });
      this.put(created, this.x, y + 13, this.w, {
        size: 7.8,
        color: C.subtle,
        align: 'right',
      });
    }
    this.doc.end();
    return this.output;
  }
}
