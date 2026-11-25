import { inflateSync } from 'zlib';
import PDFDocument from 'pdfkit';
import * as publicApi from './index';
import { MANROPE_RANGES, NOTO_RANGE, pdfRuns } from './pdf-text';
import {
  NBSP,
  PDF_COLORS,
  PDF_TONES,
  PdfReport,
  pdfSigned,
  pdfSom,
  pdfText,
  type PdfTableRow,
} from './pdf';
import {
  MANROPE_BOLD_TTF_ZLIB_BASE64,
  MANROPE_MEDIUM_TTF_ZLIB_BASE64,
  MANROPE_SEMIBOLD_TTF_ZLIB_BASE64,
  NOTO_UZ_CYRILLIC_BOLD_TTF_ZLIB_BASE64,
  NOTO_UZ_CYRILLIC_MEDIUM_TTF_ZLIB_BASE64,
} from './assets/fonts';
import { REPORT_COLORS, REPORT_TONES } from './xlsx';

const pages = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
const fontNames = (pdf: Buffer) => [
  ...new Set(
    [...pdf.toString('latin1').matchAll(/\/BaseFont \/(?:\w{6}\+)?([\w-]+)/g)]
      .map((match) => match[1])
      .sort(),
  ),
];

const report = (o: Partial<ConstructorParameters<typeof PdfReport>[0]> = {}) =>
  new PdfReport({
    title: 'Namuna',
    footer: 'Namuna #1',
    createdAt: '25.11.2026 10:20',
    head: 'Namuna · #1',
    compress: false,
    ...o,
  });

/** Chizilgan matnlar (shrift bo'laklari alohida). */
async function drawn(build: () => Promise<Buffer>) {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const pdf = await build();
    return { pdf, texts: spy.mock.calls.map((call) => String(call[0])) };
  } finally {
    spy.mockRestore();
  }
}

type Row = { name: string; sum: number };
const COLUMNS = [
  {
    key: 'name',
    header: 'Nomi',
    weight: 2,
    value: (row: Row) => row.name,
  },
  {
    key: 'sum',
    header: "Summa, so'm",
    weight: 1,
    align: 'right' as const,
    value: (row: Row) => pdfSom(row.sum),
  },
];

describe('PDF matni', () => {
  it("shrift qamrovi — jadval Manrope / Noto fayllarining o'zi bilan bir xil", () => {
    const characters = (data: string) => {
      const doc = new PDFDocument();
      doc.font(inflateSync(Buffer.from(data, 'base64')));
      const { font } = (
        doc as unknown as { _font: { font: { characterSet: number[] } } }
      )._font;
      return new Set(font.characterSet);
    };
    for (const base64 of [
      MANROPE_MEDIUM_TTF_ZLIB_BASE64,
      MANROPE_SEMIBOLD_TTF_ZLIB_BASE64,
      MANROPE_BOLD_TTF_ZLIB_BASE64,
    ]) {
      const set = characters(base64);
      const missing = MANROPE_RANGES.flatMap(([from, to]) =>
        Array.from({ length: to - from + 1 }, (_, i) => from + i),
      ).filter((code) => !set.has(code));
      expect(missing).toEqual([]);
    }
    for (const base64 of [
      NOTO_UZ_CYRILLIC_MEDIUM_TTF_ZLIB_BASE64,
      NOTO_UZ_CYRILLIC_BOLD_TTF_ZLIB_BASE64,
    ]) {
      const set = characters(base64);
      for (const char of 'қғҳҚҒҲ') {
        expect(set.has(char.codePointAt(0) ?? 0)).toBe(true);
      }
      expect(set.has(NOTO_RANGE[0]) && set.has(NOTO_RANGE[1])).toBe(true);
    }
  });

  it("o'zbek belgilari saqlanadi yoki o'xshashiga o'tadi, yo'q belgi tashlanadi", () => {
    expect(pdfText('oʻzbek gʼoya o`q')).toBe('o‘zbek g’oya o‘q');
    expect(pdfText('Қўқон Ғиждувон Ҳазорасп ўзбек')).toBe(
      'Қўқон Ғиждувон Ҳазорасп ўзбек',
    );
    expect(pdfText('🔥 Hot 🚚 Market 😀')).toBe('Hot Market');
    expect(pdfText('🔥👨\u200d👩\u200d👧')).toBe('');
    expect(pdfText('漢字 Ａ① ǎ → «x» №4 — 5 €')).toBe('A1 a → «x» №4 — 5 €');
    // NFD: и + U+0306 → й; ko'rinmas belgilar va tablar.
    expect(pdfText('и\u0306ил\u200b\ufeff\tбир\u00ad')).toBe('йил бир');
    expect(pdfText('a\r\n b \rc\u2028d')).toBe('a\nb\nc\nd');
    expect(pdfText('1\u202f000')).toBe(`1${NBSP}000`);
    expect(pdfText('\ud83d yarim')).toBe('yarim');
    expect(pdfText(null)).toBe('');
    expect(pdfText(0)).toBe('0');
  });

  it("kengaytirilgan kirill harflari zaxira shriftga bo'linadi", () => {
    expect(pdfRuns('Қўқон')).toEqual([
      { text: 'Қ', noto: true },
      { text: 'ў', noto: false },
      { text: 'қ', noto: true },
      { text: 'он', noto: false },
    ]);
    expect(pdfRuns('Andijon')).toEqual([{ text: 'Andijon', noto: false }]);
  });

  it("summa: ajralmas bo'shliq, «−», «—», ishora", () => {
    expect(pdfSom(14_334_000)).toBe(`14${NBSP}334${NBSP}000`);
    expect(pdfSom(-250_000.4)).toBe(`−250${NBSP}000`);
    expect(pdfSom(-0.2)).toBe('0');
    expect(pdfSom(null)).toBe('—');
    expect(pdfSom(Number.NaN)).toBe('—');
    expect(pdfSigned(5)).toBe('+5');
    expect(pdfSigned(-5)).toBe('−5');
    expect(pdfSigned(0)).toBe('0');
    expect(pdfSigned(undefined)).toBe('—');
  });
});

describe("PDF to'plami", () => {
  it("ranglar Excel to'plami bilan bir xil; index'da PDF yo'q (shriftlar boshqa bundle'ga tushmaydi)", () => {
    const hex = (argb: string) => `#${argb.slice(2)}`;
    for (const [name, value] of Object.entries(PDF_COLORS)) {
      expect(value).toBe(hex(REPORT_COLORS[name as keyof typeof PDF_COLORS]));
    }
    for (const [tone, [fg, bg]] of Object.entries(REPORT_TONES)) {
      expect(PDF_TONES[tone as keyof typeof PDF_TONES]).toEqual([
        hex(fg),
        hex(bg),
      ]);
    }
    expect(Object.keys(publicApi)).not.toContain('PdfReport');
  });

  it('hamma blok: shrift Manrope + Noto joylanadi, Helvetica yo‘q, sahifa raqami', async () => {
    const { pdf, texts } = await drawn(() => {
      const r = report();
      r.banner({
        title: 'Қўқон filiali — juda uzun nomli kassa hisoboti '.repeat(4),
        subtitle: 'x '.repeat(300),
        right: 'Smena #16',
        rightSub: "Qo'lda yopilgan",
      });
      r.meta([
        ['Kassa', 'Қўқон 😀'],
        ['Holat', 'Ogohlantirish', 'warning'],
        ['Bo‘sh', ''],
      ]);
      r.kpis([
        { label: 'A', value: pdfSom(9_999_999_999_999), tone: 'success' },
        { label: 'B', value: '—', sub: 'juda uzun izoh '.repeat(20) },
      ]);
      r.note('Izoh matni', 'danger', 'Sarlavha');
      r.section("Bo'lim", 'izoh');
      r.table<Row>({ columns: COLUMNS, rows: [], total: { name: 'JAMI' } });
      r.sign(['Topshirdi: Ғайрат '.repeat(10), 'Qabul qildi']);
      return r.toBuffer();
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(pdf)).toBe(1);
    expect(fontNames(pdf)).toEqual([
      'Manrope-Bold',
      'Manrope-Medium',
      'Manrope-SemiBold',
      'NotoSans-Bold',
    ]);
    expect(pdf.toString('latin1')).not.toContain('Helvetica');
    expect(texts).toContain('Elchi Pochta · Namuna #1 · Sahifa 1 / 1');
    expect(texts).toContain('Yaratilgan: 25.11.2026 10:20');
    expect(texts).toContain("Ma'lumot yo'q");
    // Qatorsiz jadvalda JAMI chiqmaydi.
    expect(texts).not.toContain('JAMI');
  });

  it("uzun jadval: sarlavha va guruh nomi takrorlanadi, JAMI bitta, logotip hujjatda bitta, katta son bo'linmaydi", async () => {
    const rows: PdfTableRow<Row>[] = [
      { group: 'Baraka', info: "120 ta to'lov", cells: { sum: '1' } },
      ...Array.from({ length: 120 }, (_, i) => ({
        data: { name: `Qator ${i + 1}`, sum: 987_654_321_987_654 },
      })),
      { more: "… yana 3 ta to'lov" },
    ];
    const { pdf, texts } = await drawn(() => {
      const r = report();
      r.banner({ title: 'Hisobot' });
      r.table<Row>({
        columns: [{ ...COLUMNS[0], weight: 9 }, COLUMNS[1]],
        rows,
        total: { name: 'JAMI', sum: pdfSom(987_654_321_987_654) },
      });
      return r.toBuffer();
    });
    const count = pages(pdf);
    expect(count).toBeGreaterThan(2);
    const times = (text: string) => texts.filter((x) => x === text).length;
    expect(times('Nomi')).toBe(count);
    expect(times('Baraka — davomi')).toBe(count - 1);
    expect(times('Namuna · #1')).toBe(count - 1);
    expect(times('JAMI')).toBe(1);
    expect(times(pdfSom(987_654_321_987_654))).toBe(121);
    expect(texts).toContain(
      `Elchi Pochta · Namuna #1 · Sahifa ${count} / ${count}`,
    );
    const images = pdf.toString('latin1').match(/\/Subtype \/Image/g) ?? [];
    expect(images).toHaveLength(1);
  });

  it("qatorga bo'lish: kenglikdan oshmaydi, uzun so'z bo'linadi, chegara «…»", () => {
    const r = report();
    const text = `${'Filial kassasi '.repeat(30)} ${'x'.repeat(4000)} oxiri`;
    const lines = r.wrap(text, 200, 'medium', 9);
    expect(lines.length).toBeGreaterThan(50);
    for (const line of lines) {
      expect(r.textWidth(line, 'medium', 9)).toBeLessThanOrEqual(200.5);
    }
    expect(lines.join('').replace(/ /g, '')).toBe(
      pdfText(text).replace(/ /g, ''),
    );
    const short = r.wrap(text, 200, 'medium', 9, 2);
    expect(short).toHaveLength(2);
    expect(short[1].endsWith('…')).toBe(true);
    expect(r.fit('qisqa', 200, 'medium', 9)).toBe('qisqa');
    expect(r.fit('', 200, 'medium', 9)).toBe('');
  });
});
