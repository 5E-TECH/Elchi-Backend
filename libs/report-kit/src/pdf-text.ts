/**
 * PDF matni: hisobot shriftlari (`assets/fonts`) qamrovi va normalizatsiya.
 * Qoida: belgi Manrope'da bor — Manrope; U+0490–04FF (қ ғ ҳ …) — Noto Sans;
 * yo'q — o'xshashi; o'xshashi ham yo'q (emoji) — tashlanadi. Hech qachon xato
 * bermaydi va «□» chiqmaydi.
 */

/** Ajralmas bo'shliq — son guruhlari va sana bilan soat orasida. */
export const NBSP = '\u00a0';

/**
 * Manrope 4.505 cmap qamrovi (Medium / SemiBold / Bold bir xil), chizilmaydigan
 * kodlarsiz (soft hyphen, word joiner, PUA). Mosligi `pdf.spec.ts` da shriftning
 * o'zi bilan solishtiriladi.
 */
export const MANROPE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ac],
  [0x00ae, 0x0113],
  [0x0116, 0x012b],
  [0x012e, 0x0131],
  [0x0134, 0x0137],
  [0x0139, 0x013e],
  [0x0141, 0x0148],
  [0x014a, 0x014d],
  [0x0150, 0x017e],
  [0x0192, 0x0192],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x0218, 0x021b],
  [0x0259, 0x0259],
  [0x02c6, 0x02c7],
  [0x02d8, 0x02dd],
  [0x0374, 0x0375],
  [0x037e, 0x037e],
  [0x0384, 0x038a],
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ce],
  [0x0400, 0x045f],
  [0x1e80, 0x1e85],
  [0x1e9e, 0x1e9e],
  [0x1ea0, 0x1ef9],
  [0x2011, 0x2011],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x2022],
  [0x2026, 0x2026],
  [0x2030, 0x2030],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x2070, 0x2070],
  [0x2074, 0x2079],
  [0x2080, 0x2089],
  [0x20a3, 0x20a3],
  [0x20a9, 0x20ac],
  [0x20ae, 0x20ae],
  [0x20b1, 0x20b1],
  [0x20b4, 0x20b4],
  [0x20b9, 0x20ba],
  [0x20bd, 0x20bd],
  [0x20bf, 0x20bf],
  [0x2116, 0x2116],
  [0x2122, 0x2122],
  [0x2190, 0x2193],
  [0x2202, 0x2202],
  [0x2205, 0x2205],
  [0x220f, 0x220f],
  [0x2211, 0x2212],
  [0x2215, 0x2215],
  [0x221a, 0x221a],
  [0x221e, 0x221e],
  [0x222b, 0x222b],
  [0x2248, 0x2248],
  [0x2260, 0x2260],
  [0x2264, 0x2265],
  [0x25ca, 0x25ca],
];

/** Noto Sans bo'lagi — o'zbek va boshqa kengaytirilgan kirill harflari. */
export const NOTO_RANGE: readonly [number, number] = [0x0490, 0x04ff];

const COVERED = new Set<number>();
for (const [from, to] of [...MANROPE_RANGES, NOTO_RANGE]) {
  for (let code = from; code <= to; code += 1) COVERED.add(code);
}
const covered = (char: string) => COVERED.has(char.codePointAt(0) ?? 0);

/** Shriftda yo'q belgi → ma'nosi bir xil o'xshashi. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // o‘ / g‘ belgisi va tutuq
  ʻ: '‘',
  ʽ: '‘',
  ʿ: '‘',
  ˋ: '‘',
  '`': '‘',
  '‛': '‘',
  ʼ: '’',
  ʾ: '’',
  ʹ: '’',
  ˈ: '’',
  '´': '’',
  ꞌ: '’',
  '′': '’',
  '″': '”',
  '‟': '“',
  // chiziqcha, nuqta, strelka
  '‐': '-',
  '⁃': '-',
  '‒': '–',
  '―': '—',
  '⸺': '—',
  '‣': '•',
  '●': '•',
  '◦': '•',
  '▪': '•',
  '■': '•',
  '∙': '·',
  '⋅': '·',
  '⇒': '→',
  '⟶': '→',
  '➔': '→',
  '➜': '→',
  '➡': '→',
  '⇐': '←',
  // ingich bo'shliqlar — son guruhlari orasida ishlatiladi
  '\u2007': NBSP,
  '\u2009': NBSP,
  '\u202f': NBSP,
};

const PLAIN = /^[ -_a-~]*$/;
const NEW_LINES = /\r\n?|[\v\f\u0085\u2028\u2029]/g;
const SPACES = /[\t\u1680\u2000-\u2006\u2008\u200a\u205f\u3000]/g;

function substitute(char: string): string {
  const lookalike = LOOKALIKES[char];
  if (lookalike) return lookalike;
  if (char === '\n' || covered(char)) return char;
  // «①» → «1», «Ａ» → «A», «ǎ» → «a»; qolgani (emoji, ieroglif,
  // boshqaruv va ko'rinmas belgilar) tashlanadi.
  let out = '';
  for (const part of char.normalize('NFKD')) if (covered(part)) out += part;
  return out;
}

/** Istalgan qiymat → shriftda to'liq bor, chekkasi kesilgan matn. */
export function pdfText(value: unknown): string {
  if (value == null) return '';
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  let text = String(value);
  if (!PLAIN.test(text)) {
    text = text.normalize('NFC').replace(NEW_LINES, '\n').replace(SPACES, ' ');
    let out = '';
    for (const char of text) out += substitute(char);
    text = out;
  }
  return text
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

export interface PdfTextRun {
  text: string;
  noto: boolean;
}

/** Normalizatsiyalangan matnni shrift bo'laklariga ajratadi. */
export function pdfRuns(text: string): PdfTextRun[] {
  const parts = text.split(/([\u0490-\u04ff]+)/);
  const runs: PdfTextRun[] = [];
  parts.forEach((part, index) => {
    if (part) runs.push({ text: part, noto: index % 2 === 1 });
  });
  return runs;
}

/** 14334000 → «14 334 000» (ajralmas bo'shliq); manfiy — «−»; yo'q — «—». */
export function pdfSom(value: unknown): string {
  if (value == null || value === '') return '—';
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount)) return '—';
  return `${amount < 0 ? '−' : ''}${Math.abs(amount)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}`;
}

/** Ishorali: «+250 000», «−250 000», «0»; yo'q — «—». */
export function pdfSigned(value: unknown): string {
  const text = pdfSom(value);
  return text === '—' || text === '0' || text.startsWith('−')
    ? text
    : `+${text}`;
}
