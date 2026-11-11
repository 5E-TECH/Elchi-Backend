/**
 * F7PWp6cK — AI moliyaviy yordamchi QABUL TC'si (10 savol) runner'ining SOF
 * yordamchilari va savollar ta'rifi.
 *
 * Hujjat (savollar, haqiqat retseptlari, PASS qoidasi):
 * `docs/ai/ASSISTANT_TC_F7PWp6cK.md`. Bu fayl hujjat bilan BIR XIL bo'lishi
 * shart — savol yoki retsept o'zgarsa, ikkalasi birga o'zgaradi.
 *
 * Bu modulda tarmoq, fayl, env va import YO'Q (hammasi
 * `assistant-tc.mjs` da): `.mjs` uni `typescript.transpileModule` bilan
 * ESM'ga o'tkazib `data:` URL orqali yuklaydi (Node 20+, yangi
 * bog'liqliksiz), jest esa to'g'ridan-to'g'ri sinaydi
 * (`apps/ai-service/src/assistant/assistant-tc.F7PWp6cK.spec.ts`).
 *
 * Asosiy tamoyil — EHTIYOTKOR baho: javobdan raqam ajratish evristik, shuning
 * uchun
 *  - PASS faqat har kutilgan qiymat o'z yorlig'i (yoki jadval katagi) yonida
 *    eng yaqin raqam bo'lib topilganda;
 *  - FAIL faqat aniq holatda: yorliq yonida boshqa raqam bor VA kutilgan
 *    qiymat javobning HECH qayerida yo'q (yoki majburiy tool/davr xato);
 *  - qolgan hammasi — NEEDS_REVIEW (inson tekshiradi).
 */

// ─── Umumiy ──────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function rec(v: unknown): Rec {
  return isRec(v) ? v : {};
}

function list(v: unknown): Rec[] {
  return Array.isArray(v) ? v.filter(isRec) : [];
}

/** `{statusCode, message, data}` o'ramini ochadi (o'ramsiz javob — o'zi). */
export function dataOf(body: unknown): Rec {
  if (isRec(body) && isRec(body.data)) return body.data;
  return rec(body);
}

/** Son yoki sonli satr → son; boshqasi → 0. */
export function toNum(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function strOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sum(values: number[]): number {
  return round2(values.reduce((s, v) => s + v, 0));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globalRe(re: RegExp): RegExp {
  return new RegExp(
    re.source,
    re.flags.includes('g') ? re.flags : `${re.flags}g`,
  );
}

/** Summani o'qish uchun: 1250000.5 → «1 250 000,5». */
export function formatAmount(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return typeof v === 'string' ? v : v == null ? '—' : JSON.stringify(v);
  }
  const sign = v < 0 ? '-' : '';
  const [int, frac] = Math.abs(round2(v)).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const tail = frac === '00' ? '' : `,${frac.replace(/0$/, '')}`;
  return `${sign}${grouped}${tail}`;
}

// ─── Sanalar (Asia/Tashkent, doimiy UTC+5) ─────────────────────────────────

/**
 * O'zbekiston 1991 yildan beri doimiy UTC+5 (yozgi vaqt yo'q). Kanonik
 * yordamchi — `apps/ai-service/src/usage/tashkent-day.ts`; bu yerda nusxa,
 * chunki modul import qilmaydi.
 */
export const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface Period {
  from: string;
  to: string;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Haqiqiy kalendar sanasi (YYYY-MM-DD)mi. */
export function isValidYmd(v: unknown): boolean {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Berilgan lahzaning Toshkent sanasi. */
export function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** Berilgan sanadan OLDINGI kalendar oy. */
export function previousMonth(ymd: string): Period {
  const to = addDays(monthStart(ymd), -1);
  return { from: monthStart(to), to };
}

/** ISO hafta kuni: dushanba = 1 … yakshanba = 7. */
export function isoWeekday(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** «O'tgan hafta» — berilgan sanadan oldingi to'liq dushanba–yakshanba. */
export function previousWeek(ymd: string): Period {
  const from = addDays(ymd, -(isoWeekday(ymd) + 6));
  return { from, to: addDays(from, 6) };
}

export interface TcPeriods {
  /** T — savol berilgan Toshkent sanasi. */
  today: string;
  /** o'tgan oy (M1). */
  m1: Period;
  /** undan oldingi oy (M0). */
  m0: Period;
  /** M0 boshidan M1 oxirigacha. */
  m0m1: Period;
  /** o'tgan hafta (dushanba–yakshanba). */
  week: Period;
  /** undan oldingi hafta (dashboard `previous` oynasi). */
  weekBefore: Period;
  /** joriy oy boshidan T gacha (tool sukuti). */
  currentMonth: Period;
}

export function buildPeriods(today: string): TcPeriods {
  const m1 = previousMonth(today);
  const m0 = previousMonth(m1.from);
  const week = previousWeek(today);
  return {
    today,
    m1,
    m0,
    m0m1: { from: m0.from, to: m1.to },
    week,
    weekBefore: { from: addDays(week.from, -7), to: addDays(week.to, -7) },
    currentMonth: { from: monthStart(today), to: today },
  };
}

export function samePeriod(
  a: Period | null | undefined,
  b: Period | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.from === b.from && a.to === b.to;
}

export function periodText(p: Period | null | undefined): string {
  return p ? `${p.from} — ${p.to}` : 'davrsiz (joriy holat)';
}

export const UZ_MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
] as const;

/** Javobda oy nomining yozilish variantlari (kichik harf). */
const MONTH_VARIANTS: readonly string[] = [
  'yanvar',
  'fevral',
  // «marta» (… marta = … karra) bilan adashmasin.
  'mart(?!a)',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr|sentyabr',
  'oktabr|oktyabr',
  'noyabr',
  'dekabr',
];

/** «2026-yil oktabr». */
export function monthTitle(ymd: string): string {
  return `${ymd.slice(0, 4)}-yil ${UZ_MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
}

/** Javobda shu oy tilga olingan joy: «oktabr(da)», «10.2026», «2026-10». */
export function monthRegex(ymd: string): RegExp {
  const y = ymd.slice(0, 4);
  const m = ymd.slice(5, 7);
  const names = MONTH_VARIANTS[Number(m) - 1];
  return new RegExp(
    `(?<![a-z'])(?:${names})[a-z']*|(?<!\\d)${m}\\.${y}(?!\\d)|(?<!\\d)${y}-${m}(?![\\d-])`,
  );
}

/** «02.11» va «2026-11-02» — jadval sarlavhasida davr boshi. */
function dayHeaderRe(ymd: string): string {
  return `${escapeRe(ymd)}|${ymd.slice(8, 10)}\\.${ymd.slice(5, 7)}`;
}

// ─── SSE ─────────────────────────────────────────────────────────────────

export interface SseEvent {
  /** `event:` maydoni (yo'q bo'lsa 'message'). */
  event: string;
  data: string;
  /** `data` JSON bo'lsa — obyekt, aks holda `null`. */
  json: unknown;
}

/**
 * Bosqichma-bosqich SSE parser (WHATWG qoidasi): `\n`, `\r\n`, `\r` qator
 * oxirlari (bo'lak chegarasida bo'linsa ham), `:` izoh (`: ping`), ko'p
 * qatorli `data:`, bo'sh qator — hodisa yuboriladi. Oqim oxirida
 * tugallanmagan hodisa tashlanadi.
 */
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // Oxiridagi yolg'iz '\r' — '\r\n' ning birinchi yarmi bo'lishi mumkin.
      if (m[0] === '\r' && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    const event = this.eventName || 'message';
    const hasData = this.dataLines.length > 0;
    const data = this.dataLines.join('\n');
    this.eventName = '';
    this.dataLines = [];
    if (!hasData) return null;
    let json: unknown = null;
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
    return { event, data, json };
  }
}

export interface ToolResultEvent {
  step: number;
  id: string;
  tool: string;
  ok: boolean;
  records: number;
  period: Period | null;
  truncated: boolean;
}

export interface AssistantSourceRow {
  tool: string;
  period: Period | null;
  records: number;
  truncated: boolean;
  ok: boolean;
}

export interface AssistantRun {
  conversationId: string | null;
  messageId: string | null;
  model: string | null;
  toolCalls: Array<{ step: number; id: string; tool: string; input: Rec }>;
  toolResults: ToolResultEvent[];
  done: {
    answer: string;
    stop: string;
    steps: number;
    sources: AssistantSourceRow[];
    usage: Rec;
    limits: Rec;
  } | null;
  error: { code: string; message: string; http?: number } | null;
  events: number;
}

export function newRun(): AssistantRun {
  return {
    conversationId: null,
    messageId: null,
    model: null,
    toolCalls: [],
    toolResults: [],
    done: null,
    error: null,
    events: 0,
  };
}

function periodOf(v: unknown): Period | null {
  const p = rec(v);
  return typeof p.from === 'string' && typeof p.to === 'string'
    ? { from: p.from, to: p.to }
    : null;
}

/**
 * Bitta SSE hodisasini yig'ilmaga qo'shadi. `true` — yakuniy hodisa
 * (`done` yoki `error`), oqimni o'qish to'xtatiladi.
 */
export function applyEvent(run: AssistantRun, ev: SseEvent): boolean {
  const d = rec(ev.json);
  const type = typeof d.type === 'string' ? d.type : ev.event;
  run.events += 1;
  switch (type) {
    case 'meta':
      run.conversationId = strOf(d.conversation_id);
      run.messageId = strOf(d.message_id);
      run.model = strOf(d.model);
      return false;
    case 'tool_call':
      run.toolCalls.push({
        step: toNum(d.step),
        id: strOf(d.id) ?? '',
        tool: strOf(d.tool) ?? '',
        input: rec(d.input),
      });
      return false;
    case 'tool_result':
      run.toolResults.push({
        step: toNum(d.step),
        id: strOf(d.id) ?? '',
        tool: strOf(d.tool) ?? '',
        ok: d.ok === true,
        records: toNum(d.records),
        period: periodOf(d.period),
        truncated: d.truncated === true,
      });
      return false;
    case 'done':
      run.conversationId = strOf(d.conversation_id) ?? run.conversationId;
      run.messageId = strOf(d.message_id) ?? run.messageId;
      run.done = {
        answer: typeof d.answer === 'string' ? d.answer : '',
        stop: strOf(d.stop) ?? '',
        steps: toNum(d.steps),
        sources: list(d.sources).map((s) => ({
          tool: strOf(s.tool) ?? '',
          period: periodOf(s.period),
          records: toNum(s.records),
          truncated: s.truncated === true,
          ok: s.ok === true,
        })),
        usage: rec(d.usage),
        limits: rec(d.limits),
      };
      return true;
    case 'error':
      run.conversationId = strOf(d.conversation_id) ?? run.conversationId;
      run.error = {
        code: strOf(d.code) ?? 'unknown',
        message: strOf(d.message) ?? '',
      };
      return true;
    default:
      return false;
  }
}

// ─── Javobdan raqam ajratish ──────────────────────────────────────────────

export interface NumToken {
  value: number;
  start: number;
  end: number;
  raw: string;
  percent: boolean;
  currency: boolean;
  /** «45 ta» — son birligi. */
  countUnit: boolean;
  /** Ishora aniq yozilgan («+20», «-5», «−25 000 000»). */
  signed: boolean;
  integer: boolean;
  /** «1,2 mln» — qisqartirilgan (qoida 7 nuqsoni). */
  approx: boolean;
  /** Ko'rsatilgan aniqlik (approx bo'lsa yarim birlik). */
  precision: number;
}

/**
 * Taqqoslash uchun matn: kichik harf, apostroflar `'`, NBSP/ingichka
 * bo'shliq → bo'shliq, unicode minus → `-`, markdown qalin belgisi (`**`,
 * `__`) olib tashlanadi (`****` karta niqobi saqlanadi).
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u2018\u2019\u02BB\u02BC\u0060\u00B4\u2032]/g, "'")
    .replace(/[\u00A0\u2007\u2009\u202F]/g, ' ')
    .replace(/\u2212/g, '-')
    .replace(/(?<!\*)\*\*(?!\*)|__/g, '')
    .toLowerCase();
}

const MONTHS_ALT =
  'yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentabr|sentyabr|oktabr|oktyabr|noyabr|dekabr';

/** Raqam EMAS joylar (sana, vaqt, ro'yxat raqami, id, karta oxiri). */
const NUMBER_MASKS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?/g,
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g,
  /\b\d{1,2}\.\d{4}\b/g,
  /\b\d{4}-\d{2}\b/g,
  /\b\d{4}\s?-?\s?yil/g,
  new RegExp(`\\b\\d{1,2}\\s?-?\\s?(?:${MONTHS_ALT})`, 'g'),
  new RegExp(`(?:${MONTHS_ALT})[a-z']*,?\\s\\d{4}\\b`, 'g'),
  /\b\d{1,2}\.\d{2}\s?[-–—]\s?\d{1,2}\.\d{2}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /^[ \t]*\d{1,2}[.)](?=[ \t])/gm,
  /#\d+/g,
  /(?:\*|•|…|\.){2,}\s?\d{4}\b/g,
  /\btop[- ]?\d+\b/g,
];

function maskText(norm: string, extra: readonly RegExp[]): string {
  let out = norm;
  for (const re of [...NUMBER_MASKS, ...extra]) {
    out = out.replace(globalRe(re), (m) => m.replace(/[^\n]/g, ' '));
  }
  return out;
}

const NUM_RE =
  /(?<![\p{L}\p{N}_.,])([-+]?)(\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)(?![\p{L}\p{N}_])/gu;

/** «1 250 000,5» / «1,250,000.5» / «1.250.000,5» / «12,5» → son. */
export function parseNumeric(raw: string): { value: number; decimals: number } {
  let intPart: string;
  let frac = '';
  if (raw.includes(' ')) {
    const m = /^([\d ]+?)(?:[.,](\d+))?$/.exec(raw);
    intPart = (m?.[1] ?? raw).replace(/ /g, '');
    frac = m?.[2] ?? '';
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) {
    const [i, f = ''] = raw.split('.');
    intPart = i.replace(/,/g, '');
    frac = f;
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)) {
    const [i, f = ''] = raw.split(',');
    intPart = i.replace(/\./g, '');
    frac = f;
  } else {
    const [i, f = ''] = raw.split(/[.,]/);
    intPart = i;
    frac = f;
  }
  return {
    value: Number(frac ? `${intPart}.${frac}` : intPart),
    decimals: frac.length,
  };
}

const MULTIPLIERS: ReadonlyArray<[RegExp, number]> = [
  [/^\s?(?:mlrd|milliard)(?![a-z])/, 1e9],
  [/^\s?(?:mln|million)(?![a-z])/, 1e6],
  [/^\s?ming(?![a-z])/, 1e3],
];

/** Normallashgan matndagi raqamlar (`masked` — sanalar yashirilgan nusxa). */
export function tokenize(norm: string, masked: string): NumToken[] {
  const out: NumToken[] = [];
  for (const m of masked.matchAll(NUM_RE)) {
    const sign = m[1] === '-' ? -1 : 1;
    const raw = m[2];
    const start = m.index;
    const end = start + m[0].length;
    const { value, decimals } = parseNumeric(raw);
    let rest = norm.slice(end, end + 32);
    const percent = /^\s?(?:%|foiz)/.test(rest);
    let mult = 1;
    for (const [re, k] of MULTIPLIERS) {
      const mm = re.exec(rest);
      if (mm) {
        mult = k;
        rest = rest.slice(mm[0].length);
        break;
      }
    }
    const approx = mult !== 1;
    out.push({
      value: sign * value * mult,
      start,
      end,
      raw: m[0],
      percent,
      // «so'mni / so'mga / so'mlik …» — kelishik qo'shimchasi bilan ham pul.
      currency:
        /^\s?(?:so'm|som|sum|сум|uzs)(?:ni|ga|dan|da|lik|i|ning|gacha)?(?![a-z'])/.test(
          rest,
        ),
      countUnit:
        !percent && /^\s?-?ta(?:si|dan|ga|da|ni|lik)?(?![a-z])/.test(rest),
      signed: m[1] !== '',
      integer: decimals === 0 && !approx,
      approx,
      precision: approx ? 0.5 * 10 ** -decimals * mult : 0,
    });
  }
  return out;
}

interface MdCell {
  text: string;
  start: number;
  end: number;
}

interface MdTable {
  header: MdCell[];
  rows: MdCell[][];
}

function isTableLine(t: string): boolean {
  return t.trim().startsWith('|') && t.split('|').length >= 3;
}

function isSeparatorLine(t: string): boolean {
  return /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*(?::?-{2,}:?\s*)?\|?\s*$/.test(t);
}

function splitCells(text: string, offset: number): MdCell[] {
  const cells: MdCell[] = [];
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '|') pipes.push(i);
  // Oxirgi `|` siz qator — oxirgi katak ham olinadi.
  if (!text.trimEnd().endsWith('|')) pipes.push(text.length);
  for (let k = 0; k + 1 < pipes.length; k += 1) {
    const s = pipes[k] + 1;
    const e = pipes[k + 1];
    cells.push({
      text: text.slice(s, e).trim(),
      start: offset + s,
      end: offset + e,
    });
  }
  return cells;
}

/** Markdown jadvallari (katak matni va javobdagi o'rni bilan). */
export function parseTables(norm: string): MdTable[] {
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const text of norm.split('\n')) {
    lines.push({ text, start: pos });
    pos += text.length + 1;
  }
  const tables: MdTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i].text)) {
      i += 1;
      continue;
    }
    const block: MdCell[][] = [];
    while (i < lines.length && isTableLine(lines[i].text)) {
      if (!isSeparatorLine(lines[i].text)) {
        block.push(splitCells(lines[i].text, lines[i].start));
      }
      i += 1;
    }
    if (block.length >= 2) {
      tables.push({ header: block[0], rows: block.slice(1) });
    }
  }
  return tables;
}

export interface PreparedAnswer {
  norm: string;
  /** Bo'shliqlari bittaga qisqartirilgan `norm` (nom qidirish uchun). */
  flat: string;
  masked: string;
  tokens: NumToken[];
  tables: MdTable[];
}

export function prepareAnswer(
  answer: string,
  extraMasks: readonly RegExp[] = [],
): PreparedAnswer {
  const norm = normalizeText(answer);
  const masked = maskText(norm, extraMasks);
  return {
    norm,
    flat: norm.replace(/[«»"“”„]/g, '').replace(/\s+/g, ' '),
    masked,
    tokens: tokenize(norm, masked),
    tables: parseTables(norm),
  };
}

/** Gap/qator chegaralari: yangi qator yoki `. ! ? ;` + bo'shliq. */
function isBoundary(text: string, i: number): boolean {
  const c = text[i];
  if (c === '\n') return true;
  return (
    (c === '.' || c === '!' || c === '?' || c === ';') &&
    (i + 1 >= text.length || /\s/.test(text[i + 1]))
  );
}

function segmentBounds(text: string, idx: number): [number, number] {
  let s = idx;
  while (s > 0 && !isBoundary(text, s - 1)) s -= 1;
  let e = idx;
  while (e < text.length && !isBoundary(text, e)) e += 1;
  return [s, e];
}

/**
 * Gap ichidagi bo'lak (`, ` bilan ajratilgan): «kirim 12 000 000 so'm
 * (45 ta), chiqim 8 000 000 so'm (30 ta)» da «chiqim» ga 45 emas, 30 tegishli.
 */
function clauseBounds(
  text: string,
  anchor: [number, number],
  seg: [number, number],
): [number, number] {
  const head = text.lastIndexOf(', ', anchor[0] - 1);
  const s = head >= seg[0] ? head + 2 : seg[0];
  const tail = text.indexOf(', ', anchor[1]);
  const e = tail >= 0 && tail < seg[1] ? tail : seg[1];
  return [s, e];
}

function allMatches(re: RegExp, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(globalRe(re))) {
    out.push([m.index, m.index + Math.max(m[0].length, 1)]);
  }
  return out;
}

function spanDistance(a: [number, number], b: [number, number]): number {
  if (b[1] <= a[0]) return a[0] - b[1];
  if (b[0] >= a[1]) return b[0] - a[1];
  return 0;
}

/** Eng yaqin: masofa bo'yicha, teng bo'lsa — yorliqdan KEYINGISI. */
function nearest<T extends { start: number; end: number }>(
  anchor: [number, number],
  items: T[],
): T | null {
  let best: T | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const d = spanDistance(anchor, [it.start, it.end]);
    const key = d * 2 + (it.start >= anchor[1] ? 0 : 1);
    if (key < bestKey) {
      best = it;
      bestKey = key;
    }
  }
  return best;
}

// ─── Kutilgan qiymatlar va baho ─────────────────────────────────────────

export type ItemKind =
  'money' | 'count' | 'percent' | 'name' | 'order' | 'yesno' | 'absent';

/** Bitta RegExp — yorliq; massiv — [yorliq, shu gap ichidagi ikkinchi yorliq]. */
export type LabelChain = RegExp | readonly RegExp[];

export interface TableSpec {
  /** Qator: shu regexga mos katakli qator (yo'q bo'lsa — yagona qator). */
  row?: RegExp;
  /** Ustun: sarlavhasi shu regexga mos (yo'q bo'lsa — yorliqdan keyingi raqamli katak). */
  col?: RegExp;
}

export interface ExpectedItem {
  key: string;
  /** Hisobotdagi qisqa nom (o'zbekcha). */
  label: string;
  kind: ItemKind;
  value: number | string | boolean | readonly string[] | null;
  labels?: readonly LabelChain[];
  table?: readonly TableSpec[];
  tolerance?: number;
  /** Ishorasiz taqqoslash (kamomad «−250 000» ham, «250 000» ham to'g'ri). */
  absOk?: boolean;
  /**
   * absOk bilan: ishorasiz yozuv («5 taga kam») qabul, lekin javob raqamni
   * `+`/`-` bilan yozgan bo'lsa ishora kutilganga teng bo'lishi shart
   * (o'zgarish yo'nalishi teskari bo'lmasin).
   */
  signedIfExplicit?: boolean;
  /** Zanjirda qiymat IKKINCHI yorliqdan KEYIN keladi («oldingi haftada 100 ta»). */
  valueAfter?: boolean;
  /** Ma'lumot uchun — verdiktga ta'sir qilmaydi. */
  optional?: boolean;
  /** Tekshirib bo'lmaydi (masalan ro'yxat to'liq emas) — o'tkazib yuboriladi. */
  skip?: string;
  /** yesno: «ha» va «yo'q» iboralari. */
  yes?: readonly RegExp[];
  no?: readonly RegExp[];
  /** absent: rad etish iboralari va shu gapda ruxsat etilgan (boshqa savol qismiga tegishli) raqamlar. */
  refusal?: readonly RegExp[];
  allowed?: readonly number[];
  /**
   * absent: o'ylab topilgan ko'rsatkichga o'xshash hosila qiymatlar (masalan
   * A1 − S1 − C1) — yorliq turgan gapning istalgan joyida bo'lsa FAIL.
   */
  suspect?: readonly number[];
  /** Ma'lum tuzoq qiymatlar: javob shu qiymatni bersa — izoh. */
  traps?: ReadonlyArray<{ value: number; note: string }>;
}

export type ItemStatus =
  | 'match'
  | 'approx'
  | 'ambiguous'
  | 'unlabeled'
  | 'missing'
  | 'mismatch'
  | 'skipped';

export interface ItemResult {
  key: string;
  label: string;
  kind: ItemKind;
  expected: unknown;
  assistant: unknown;
  status: ItemStatus;
  note?: string;
  optional?: boolean;
}

export const DEFAULT_TOLERANCE = { money: 1, count: 0, percent: 0.1 } as const;

type NumericKind = keyof typeof DEFAULT_TOLERANCE;

/** Kutilgan va javobdagi sonni dopusk bilan taqqoslaydi. */
export function numbersMatch(
  expected: number,
  actual: number,
  opts: {
    kind: NumericKind;
    tolerance?: number;
    absOk?: boolean;
    precision?: number;
  },
): boolean {
  const tol = Math.max(
    opts.tolerance ?? DEFAULT_TOLERANCE[opts.kind],
    opts.precision ?? 0,
  );
  const a = opts.absOk ? Math.abs(actual) : actual;
  const e = opts.absOk ? Math.abs(expected) : expected;
  return Math.abs(a - e) <= tol + 1e-9;
}

function compatible(t: NumToken, kind: NumericKind): boolean {
  if (kind === 'percent') return t.percent;
  if (t.percent) return false;
  if (kind === 'count') return t.integer && !t.currency;
  return !t.countUnit;
}

const ZERO_WORDS =
  /yo'q|bo'lmagan|bo'lmadi|kuzatilmagan|qayd etilmagan|aniqlanmagan|mavjud emas|\bnol\b|hech (?:qanday|bir)/g;

function chainsOf(item: ExpectedItem): RegExp[][] {
  return (item.labels ?? []).map((l) => (l instanceof RegExp ? [l] : [...l]));
}

function tableCells(tables: MdTable[], spec: TableSpec): MdCell[] {
  const out: MdCell[] = [];
  const { row, col } = spec;
  for (const t of tables) {
    const colIdx = col ? t.header.findIndex((h) => col.test(h.text)) : -1;
    if (col && colIdx < 0) continue;
    const rows = row
      ? t.rows.filter((r) => r.some((c) => row.test(c.text)))
      : t.rows.length === 1
        ? t.rows
        : [];
    for (const r of rows) {
      if (colIdx >= 0) {
        if (r[colIdx]) out.push(r[colIdx]);
        continue;
      }
      // Ustun ko'rsatilmagan: qator yorlig'idan KEYINGI kataklar.
      const labelIdx = row ? r.findIndex((c) => row.test(c.text)) : -1;
      out.push(...r.slice(labelIdx + 1));
    }
  }
  return out;
}

function result(
  item: ExpectedItem,
  status: ItemStatus,
  assistant: unknown,
  note?: string,
): ItemResult {
  return {
    key: item.key,
    label: item.label,
    kind: item.kind,
    expected: item.value,
    assistant,
    status,
    ...(note ? { note } : {}),
    ...(item.optional ? { optional: true } : {}),
  };
}

function evaluateNumeric(p: PreparedAnswer, item: ExpectedItem): ItemResult {
  const kind = item.kind as NumericKind;
  const expected = item.value as number;
  const opts = { kind, tolerance: item.tolerance, absOk: item.absOk };
  const close = (t: NumToken) =>
    !(
      item.signedIfExplicit &&
      t.signed &&
      expected !== 0 &&
      Math.sign(t.value) !== Math.sign(expected)
    ) && numbersMatch(expected, t.value, { ...opts, precision: t.precision });
  const tokensIn = (s: number, e: number) =>
    p.tokens.filter((t) => t.start >= s && t.end <= e && compatible(t, kind));
  const ok = (t: NumToken, via: string) =>
    result(
      item,
      t.approx ? 'approx' : 'match',
      t.value,
      t.approx
        ? `${via}; qisqartirilgan yozuv «${t.raw}…» (qoida 7) — ko'rsatilgan aniqlikda solishtirildi`
        : undefined,
    );

  let labeled: number | null = null;
  let ambiguous = false;
  let zeroSaid = false;

  // 1) Jadval katagi.
  for (const spec of item.table ?? []) {
    for (const cell of tableCells(p.tables, spec)) {
      const toks = tokensIn(cell.start, cell.end);
      if (!toks.length) continue;
      if (close(toks[0])) return ok(toks[0], 'jadval');
      if (toks.some(close)) ambiguous = true;
      labeled ??= toks[0].value;
    }
  }

  // 2) Yorliq yonidagi eng yaqin raqam (shu gap/qator ichida).
  for (const chain of chainsOf(item)) {
    for (const span of allMatches(chain[0], p.norm)) {
      const [ss, se] = segmentBounds(p.norm, span[0]);
      let anchor: [number, number] = span;
      if (chain.length > 1) {
        const subs = allMatches(chain[1], p.norm.slice(ss, se)).map(
          ([a, b]) => ({ start: a + ss, end: b + ss }),
        );
        // Ikkinchi yorliq odatda birinchisidan KEYIN keladi («sotildi
        // (oldingi haftada 80 ta, +10)»); bo'lmasa — eng yaqini.
        const sub = subs.find((x) => x.start >= span[1]) ?? nearest(span, subs);
        if (!sub) continue;
        anchor = [sub.start, sub.end];
      }
      const toks = tokensIn(ss, se);
      // Avval yorliq turgan bo'lak ichidan, bo'lmasa butun gapdan.
      const [cs, ce] = clauseBounds(p.norm, anchor, [ss, se]);
      const inClause = toks.filter((t) => t.start >= cs && t.end <= ce);
      // «… 120 ta (oldingi haftada 100 ta)» — oldingi davr qiymati yorliqdan
      // keyin (faqat `valueAfter` bandlarida; boshqa zanjirlar o'zgarmaydi).
      const after =
        item.valueAfter && chain.length > 1
          ? inClause.filter((t) => t.start >= anchor[1])
          : [];
      const best = after.length
        ? after[0]
        : nearest(anchor, inClause.length ? inClause : toks);
      const zero = nearest(
        anchor,
        allMatches(ZERO_WORDS, p.norm.slice(ss, se)).map(([a, b]) => ({
          start: a + ss,
          end: b + ss,
        })),
      );
      if (
        zero &&
        (!best ||
          spanDistance(anchor, [zero.start, zero.end]) <
            spanDistance(anchor, [best.start, best.end]))
      ) {
        zeroSaid = true;
        continue;
      }
      if (!best) continue;
      if (close(best)) return ok(best, 'yorliq');
      if (toks.some(close)) ambiguous = true;
      labeled ??= best.value;
    }
  }

  if (zeroSaid && expected === 0) {
    return result(
      item,
      'match',
      0,
      "so'z bilan aytilgan («yo'q» / «bo'lmagan»)",
    );
  }
  if (zeroSaid) labeled ??= 0;
  const trapNote = (v: number | null) =>
    v === null
      ? undefined
      : item.traps?.find((tr) =>
          numbersMatch(tr.value, v, { ...opts, precision: 0 }),
        )?.note;

  if (ambiguous) {
    return result(
      item,
      'ambiguous',
      labeled,
      'kutilgan qiymat yorliq yonida bor, lekin eng yaqin raqam boshqa — qo‘lda tekshiring',
    );
  }
  const anywhere = p.tokens.find((t) => compatible(t, kind) && close(t));
  if (anywhere) {
    return result(
      item,
      'unlabeled',
      anywhere.value,
      'qiymat javobda bor, lekin yorlig‘i aniqlanmadi — qo‘lda tekshiring',
    );
  }
  if (labeled !== null) {
    return result(
      item,
      'mismatch',
      labeled,
      trapNote(labeled) ?? 'yorliq yonidagi raqam kutilganga teng emas',
    );
  }
  return result(
    item,
    'missing',
    null,
    'javobda topilmadi — qo‘lda tekshiring (haqiqatan yo‘q bo‘lsa FAIL)',
  );
}

/** Nomni taqqoslash uchun normallash (qo'shtirnoqsiz, bitta bo'shliq). */
export function normalizeName(name: string): string {
  return normalizeText(name)
    .replace(/[«»"“”„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nom yorlig'i (javobdagi bo'shliqlar soni farq qilsa ham topiladi). */
export function nameRegex(name: string): RegExp {
  return new RegExp(escapeRe(normalizeName(name)).replace(/ /g, '\\s+'));
}

function evaluateName(p: PreparedAnswer, item: ExpectedItem): ItemResult {
  const names = (
    Array.isArray(item.value) ? item.value : [item.value]
  ) as string[];
  const found = names.find((n) => p.flat.includes(normalizeName(n)));
  return found
    ? result(item, 'match', found)
    : result(
        item,
        'missing',
        null,
        'nom javobda topilmadi (yozilishi boshqacha bo‘lishi mumkin) — qo‘lda tekshiring',
      );
}

function evaluateOrder(p: PreparedAnswer, item: ExpectedItem): ItemResult {
  const names = (item.value ?? []) as readonly string[];
  const pos = names.map((n) => p.flat.indexOf(normalizeName(n)));
  if (pos.some((x) => x < 0)) {
    return result(
      item,
      'missing',
      null,
      'tartibni tekshirish uchun hamma nom topilmadi',
    );
  }
  const ordered = pos.every((x, i) => i === 0 || x > pos[i - 1]);
  return ordered
    ? result(item, 'match', names)
    : result(
        item,
        'ambiguous',
        null,
        'nomlar javobda boshqa tartibda tilga olingan — qo‘lda tekshiring',
      );
}

function evaluateYesNo(p: PreparedAnswer, item: ExpectedItem): ItemResult {
  let text = p.norm;
  let no = false;
  for (const re of item.no ?? []) {
    const g = globalRe(re);
    if (g.test(text)) {
      no = true;
      text = text.replace(globalRe(re), ' ');
    }
  }
  const yes = (item.yes ?? []).some((re) => re.test(text));
  if (yes === no) {
    return result(
      item,
      yes ? 'ambiguous' : 'missing',
      null,
      yes
        ? 'javobda ham «ha», ham «yo‘q» iborasi bor'
        : 'ha/yo‘q javobi topilmadi',
    );
  }
  return yes === item.value
    ? result(item, 'match', yes)
    : result(item, 'mismatch', yes, 'xulosa kutilganga teskari');
}

function evaluateAbsent(p: PreparedAnswer, item: ExpectedItem): ItemResult {
  let mentioned = false;
  let refused = false;
  const fabricated: number[] = [];
  const doubtful: number[] = [];
  const same = (a: number, v: number) =>
    Math.abs(Math.abs(a) - Math.abs(v)) < 1e-9;
  for (const chain of chainsOf(item)) {
    for (const span of allMatches(chain[0], p.norm)) {
      mentioned = true;
      const [ss, se] = segmentBounds(p.norm, span[0]);
      const [cs, ce] = clauseBounds(p.norm, span, [ss, se]);
      const seg = p.norm.slice(ss, se);
      if ((item.refusal ?? []).some((r) => r.test(seg))) refused = true;
      // Yorliq turgan bo'lakdagi rad etish iboralari: yorliqdan KEYINGI
      // birinchisi — «o'ylab topilgan raqam» zonasining oxiri.
      const refusals = (item.refusal ?? []).flatMap((r) =>
        allMatches(r, p.norm.slice(cs, ce)).map(([a]) => a + cs),
      );
      const refusalAfter = Math.min(
        Number.POSITIVE_INFINITY,
        ...refusals.filter((r) => r >= span[1]),
      );
      for (const t of p.tokens) {
        if (t.start < ss || t.end > se || t.percent) continue;
        const sameClause = t.start >= cs && t.end <= ce;
        // FAIL (aniq dalil): hosila qiymat (A1 − S1 − C1) gapning istalgan
        // joyida; yorliq bilan rad etish orasidagi raqam; bo'lakda rad etish
        // umuman bo'lmasa — shu bo'lakdagi istalgan raqam («hozir 37 ta
        // buyurtma yo'lda»).
        const strong =
          (item.suspect ?? []).some((a) => same(a, t.value)) ||
          (sameClause &&
            (refusals.length === 0 ||
              (t.start >= span[1] && t.end <= refusalAfter)));
        if (strong) {
          fabricated.push(t.value);
          continue;
        }
        // Savolning boshqa qismlari raqamlari (qabul/sotilgan/…) — ruxsat.
        if ((item.allowed ?? []).some((a) => same(a, t.value))) continue;
        // Qolgani (masalan rad etishdan keyingi «7 kunlik oyna») — o'ylab
        // topilganmi, inson ko'rsin.
        doubtful.push(t.value);
      }
    }
  }
  if (fabricated.length) {
    return result(
      item,
      'mismatch',
      fabricated[0],
      'mavjud bo‘lmagan ko‘rsatkich uchun raqam berilgan (o‘ylab topilgan)',
    );
  }
  if (!mentioned) {
    return result(
      item,
      'missing',
      null,
      'savolning bu qismiga javob topilmadi',
    );
  }
  if (doubtful.length) {
    return result(
      item,
      'ambiguous',
      doubtful[0],
      'shu gapda boshqa raqam bor — o‘ylab topilganmi, qo‘lda tekshiring',
    );
  }
  return refused
    ? result(item, 'match', "ma'lumot yo'q (rad etildi)")
    : result(
        item,
        'ambiguous',
        null,
        'raqam yo‘q, lekin rad etish iborasi ham aniq emas',
      );
}

/** Bitta kutilgan qiymatni javob bilan solishtiradi. */
export function evaluateItem(
  p: PreparedAnswer,
  item: ExpectedItem,
): ItemResult {
  if (item.skip) return result(item, 'skipped', null, item.skip);
  switch (item.kind) {
    case 'money':
    case 'count':
    case 'percent':
      if (typeof item.value !== 'number') {
        return result(item, 'skipped', null, 'kutilgan qiymat yo‘q');
      }
      return evaluateNumeric(p, item);
    case 'name':
      return evaluateName(p, item);
    case 'order':
      return evaluateOrder(p, item);
    case 'yesno':
      return evaluateYesNo(p, item);
    case 'absent':
      return evaluateAbsent(p, item);
    default:
      return result(item, 'skipped', null, 'noma’lum tur');
  }
}

// ─── Tekshiruvlar va verdikt ─────────────────────────────────────────────

export type Verdict =
  'PASS' | 'FAIL' | 'NEEDS_REVIEW' | 'DRIFT' | 'BLOCKED' | 'ERROR';

export interface Check {
  id: string;
  ok: boolean;
  /** 'fail' — PASS qoidasini buzadi; 'review' — inson ko'rsin. */
  severity: 'fail' | 'review';
  note: string;
}

export function decideVerdict(r: {
  items: ItemResult[];
  checks: Check[];
  drift?: readonly string[] | null;
  blocked?: string | null;
  error?: string | null;
}): Verdict {
  if (r.error) return 'ERROR';
  if (r.blocked) return 'BLOCKED';
  if (r.drift && r.drift.length) return 'DRIFT';
  const scored = r.items.filter((i) => !i.optional && i.status !== 'skipped');
  if (
    r.checks.some((c) => !c.ok && c.severity === 'fail') ||
    scored.some((i) => i.status === 'mismatch')
  ) {
    return 'FAIL';
  }
  if (
    !scored.length ||
    r.checks.some((c) => !c.ok) ||
    scored.some((i) => i.status !== 'match')
  ) {
    return 'NEEDS_REVIEW';
  }
  return 'PASS';
}

/** Ikki haqiqat o'qishi orasidagi farq (jonli holat o'zgargan — DRIFT). */
export function diffTruth(a: TruthResult, b: TruthResult): string[] {
  const out: string[] = [];
  const byKey = new Map(b.items.map((i) => [i.key, i] as const));
  for (const x of a.items) {
    const y = byKey.get(x.key);
    if (!y) {
      out.push(`${x.key}: keyingi o'qishda yo'q`);
      continue;
    }
    if (typeof x.value === 'number' && typeof y.value === 'number') {
      const kind = (['money', 'count', 'percent'] as const).includes(
        x.kind as NumericKind,
      )
        ? (x.kind as NumericKind)
        : 'money';
      if (!numbersMatch(x.value, y.value, { kind, tolerance: x.tolerance })) {
        out.push(
          `${x.key}: ${formatAmount(x.value)} → ${formatAmount(y.value)}`,
        );
      }
    } else if (JSON.stringify(x.value) !== JSON.stringify(y.value)) {
      out.push(
        `${x.key}: ${JSON.stringify(x.value)} → ${JSON.stringify(y.value)}`,
      );
    }
  }
  return out;
}

// ─── Savollar ────────────────────────────────────────────────────────────

export interface TcContext {
  periods: TcPeriods;
  /** true — savol matnida nisbiy so'z o'rniga aniq sanalar (ELCHI_TC_TODAY ≠ bugun). */
  explicit: boolean;
}

export function buildContext(today: string, explicit: boolean): TcContext {
  return { periods: buildPeriods(today), explicit };
}

export interface TruthRequest {
  id: string;
  path: string;
  query?: Record<string, string | number>;
}

export interface TruthResult {
  items: ExpectedItem[];
  /** Ichki moslik tekshiruvlari va izohlar. */
  notes: string[];
  /** BLOCKED sababi (qator chegarasi, deploy yo'q, ma'lumot kam …). */
  blocked?: string;
  /** Javobdan raqam ajratishda yashiriladigan qo'shimcha joylar (karta oxiri). */
  masks?: RegExp[];
}

export interface QuestionSpec {
  n: number;
  title: string;
  /** Joriy holat (yoki bugunni o'z ichiga olgan davr) — oldin VA keyin o'qiladi. */
  live: boolean;
  text(ctx: TcContext): string;
  requiredTools: readonly string[];
  /** Tool → qabul qilinadigan davr(lar); `null` — davrsiz tool. */
  expectedPeriods(ctx: TcContext): Record<string, ReadonlyArray<Period | null>>;
  /** Haqiqat hisoblanadigan asosiy davr (davrsiz savolda `null`). */
  defaultPeriod(ctx: TcContext): Period | null;
  reads(ctx: TcContext, period: Period | null): TruthRequest[];
  truth(
    res: Record<string, unknown>,
    ctx: TcContext,
    period: Period | null,
  ): TruthResult;
  extraChecks?(ctx: TcContext, run: AssistantRun, p: PreparedAnswer): Check[];
}

type NumOpts = Partial<
  Pick<
    ExpectedItem,
    | 'table'
    | 'tolerance'
    | 'absOk'
    | 'signedIfExplicit'
    | 'valueAfter'
    | 'optional'
    | 'skip'
    | 'traps'
  >
>;

function money(
  key: string,
  label: string,
  value: number | null,
  labels: readonly LabelChain[],
  opts: NumOpts = {},
): ExpectedItem {
  return { key, label, kind: 'money', value, labels, ...opts };
}

function count(
  key: string,
  label: string,
  value: number | null,
  labels: readonly LabelChain[],
  opts: NumOpts = {},
): ExpectedItem {
  return { key, label, kind: 'count', value, labels, ...opts };
}

function nameItem(
  key: string,
  label: string,
  value: string | readonly string[] | null,
  opts: NumOpts = {},
): ExpectedItem {
  return {
    key,
    label,
    kind: 'name',
    value,
    ...(value === null || (Array.isArray(value) && !value.length)
      ? {
          skip: 'nom yo‘q (identity javob bermagan) — id bo‘yicha qo‘lda tekshiring',
        }
      : {}),
    ...opts,
  };
}

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

function check(
  id: string,
  ok: boolean,
  severity: Check['severity'],
  note: string,
): Check {
  return { id, ok, severity, note };
}

function toolCallsOf(run: AssistantRun, tool: string) {
  return run.toolCalls.filter((c) => c.tool === tool);
}

const RE = {
  manba: /manba\s*:/,
  /**
   * Qoida 6: natija qisqartirilgani / to'liq emasligi javobda aytilgan.
   * «top-N» / «N ta» qabul qilinmaydi — savolning o'zi «3 ta» so'raydi.
   */
  truncNote:
    /qisqartiril|to'liq (?:emas|bo'lmagan|ko'rsatilmagan)|qisman|kesilgan|truncated|_complete\b/,
  sumCol: /jami|qoldiq|balans|summa|miqdor|pul/,
  countCol: /soni|\bta\b|operatsiya|buyurtma/,
  cashCol: /naqd/,
  cardCol: /karta/,
} as const;

const Q1: QuestionSpec = {
  n: 1,
  title: 'Asosiy kassa, kartalar, umumiy holat',
  live: true,
  text: () =>
    "Hozir asosiy kassada qancha pul bor — naqd va kartada alohida ayting, har bir karta bo'yicha qoldiqni ham ko'rsating. Kompaniyaning umumiy holati (joriy holat) qancha?",
  requiredTools: ['get_cash_position'],
  expectedPeriods: () => ({ get_cash_position: [null] }),
  defaultPeriod: () => null,
  reads: () => [
    { id: 'fb', path: '/finance/cashbox/financial-balanse' },
    { id: 'cards', path: '/finance/cashbox/cards' },
  ],
  truth(res) {
    const fb = dataOf(res.fb);
    const main = rec(fb.main);
    const chain = rec(fb.chain);
    const A = toNum(main.balance);
    const cash = toNum(main.balance_cash);
    const card = toNum(main.balance_card);
    const S = toNum(fb.currentSituation);
    const cardsData = dataOf(res.cards);
    const cards = list(cardsData.cards);
    const totalCard = toNum(cardsData.total_card ?? cardsData.balance_card);
    const notes: string[] = [];
    if (!approxEq(A, cash + card))
      notes.push(
        `⚠️ A ≠ naqd + karta (${formatAmount(A)} ≠ ${formatAmount(cash + card)})`,
      );
    if (!approxEq(card, totalCard))
      notes.push(
        `⚠️ balance_card ≠ cards.total_card (${formatAmount(card)} ≠ ${formatAmount(totalCard)})`,
      );
    const formula =
      A +
      toNum(chain.chainReceivable) +
      toNum(chain.providerReceivable) -
      toNum(rec(fb.markets).marketPayable);
    if (!approxEq(S, formula))
      notes.push(
        `⚠️ currentSituation formulaga mos emas (${formatAmount(S)} ≠ ${formatAmount(formula)})`,
      );
    if (cards.length > 15)
      notes.push(
        `kartalar ${cards.length} ta — tool faqat 15 tasini ko'rsatadi`,
      );
    const masks: RegExp[] = [];
    const items: ExpectedItem[] = [
      money(
        'A',
        'Asosiy kassa jami',
        A,
        [/asosiy kassa/, /kassada/, /\bjami\b/],
        {
          table: [{ row: /asosiy kassa|^jami/ }, { col: /^jami/ }],
        },
      ),
      money('A_cash', 'Naqd', cash, [/naqd/], {
        table: [{ row: /^naqd/ }, { col: RE.cashCol }],
      }),
      money('A_card', 'Karta (jami)', card, [/\bkarta(?:da|lar(?:da)?)?\b/], {
        table: [{ row: /^karta|kartalar jami|jami karta/ }, { col: /^karta/ }],
      }),
      money(
        'S',
        'Umumiy holat',
        S,
        [/umumiy holat/, /joriy holat/, /kompaniya(?:ning)? holati/],
        {
          table: [{ row: /holat/ }],
        },
      ),
    ];
    cards.slice(0, 15).forEach((c, i) => {
      const name = strOf(c.name) ?? `karta ${i + 1}`;
      const last4 = strOf(c.last4);
      const labels: RegExp[] = [nameRegex(name)];
      const table: TableSpec[] = [
        { row: nameRegex(name), col: /qoldiq|balans|summa|jami/ },
        { row: nameRegex(name) },
      ];
      if (last4 && /^\d{4}$/.test(last4)) {
        masks.push(new RegExp(`(?<!\\d[ .,]?)${last4}(?![ .,]?\\d)`));
        labels.push(new RegExp(last4));
        table.push({ row: new RegExp(last4) });
      }
      items.push(
        money(
          `card_${i + 1}`,
          `Karta «${name}»${last4 ? ` (${last4})` : ''}`,
          toNum(c.balance),
          labels,
          { table },
        ),
      );
    });
    return { items, notes, masks };
  },
};

/** Kassa egasining nomi (kuryer yoki market — `user.name`). */
function ownerName(r: Rec): string | null {
  return strOf(rec(r.user).name);
}

const Q2: QuestionSpec = {
  n: 2,
  title: 'Kuryerlar qo‘lidagi pul (sof va musbat), top-3',
  live: true,
  text: () =>
    "Hozir kuryerlar kassalarida sof hisobda (musbat va manfiy qoldiqlar birga) jami qancha pul bor va nechta kuryerning qoldig'i noldan farqli? Shulardan nechtasi pul ushlab turibdi (qoldig'i musbat) va ularda jami qancha? Eng ko'p pul ushlab turgan 3 ta kuryer kim, har birida qancha (naqd va karta alohida)?",
  requiredTools: ['get_courier_debts'],
  expectedPeriods: () => ({
    get_courier_debts: [null],
    get_cash_position: [null],
  }),
  defaultPeriod: () => null,
  reads: () => [{ id: 'fb', path: '/finance/cashbox/financial-balanse' }],
  truth(res) {
    const c = rec(dataOf(res.fb).couriers);
    const rows = list(c.allCourierCashboxes);
    const K = toNum(c.couriersTotalBalanse);
    const NZ = toNum(c.nonZeroCount) || rows.length;
    const complete = c.truncated !== true && rows.length >= NZ;
    const positive = rows
      .filter((r) => toNum(r.balance) > 0)
      .sort((a, b) => toNum(b.balance) - toNum(a.balance));
    const PC = positive.length;
    const PT = sum(positive.map((r) => toNum(r.balance)));
    const notes: string[] = [];
    if (complete && !approxEq(sum(rows.map((r) => toNum(r.balance))), K)) {
      notes.push('⚠️ Σ allCourierCashboxes.balance ≠ couriersTotalBalanse');
    }
    const incomplete = complete
      ? undefined
      : "ro'yxat to'liq emas (truncated) — tool soni/yig'indini null beradi";
    const items: ExpectedItem[] = [
      money('K', 'Sof jami (imzoli)', K, [/\bsof\b/, /imzoli/, /\bjami\b/], {
        traps: [
          {
            value: PT,
            note: 'faqat musbat yig‘indi «sof jami» deb berilgan — FAIL',
          },
        ],
      }),
      count('NZ', 'Noldan farqli kuryerlar', NZ, [
        /noldan farqli/,
        /nol(?:ga teng)? (?:emas|bo'lmagan)/,
        /qoldig'i (?:bor|noldan)/,
      ]),
      count(
        'PC',
        'Musbat qoldiqli kuryerlar',
        PC,
        [/musbat/, /pul ushlab/, /qo'lida pul/],
        { skip: incomplete },
      ),
      money(
        'PT',
        'Musbat qoldiqlar jami',
        PT,
        [/musbat/, /pul ushlab/, /ularda/],
        {
          skip: incomplete,
          traps: [
            {
              value: K,
              note: 'sof (imzoli) jami musbatlar yig‘indisi deb berilgan',
            },
          ],
        },
      ),
    ];
    const top = positive.slice(0, 3);
    if (
      positive.length > 3 &&
      approxEq(toNum(positive[2].balance), toNum(positive[3].balance))
    ) {
      notes.push(
        '3- va 4-kuryer balansi teng — 3-o‘rin nomi qo‘lda tekshiriladi',
      );
    }
    top.forEach((r, i) => {
      const name = ownerName(r);
      const n = i + 1;
      items.push(
        nameItem(
          `top${n}_name`,
          `${n}-kuryer`,
          name,
          i === 2 && notes.some((x) => x.startsWith('3-'))
            ? { optional: true }
            : {},
        ),
      );
      if (!name) return;
      const re = nameRegex(name);
      items.push(
        money(`top${n}_balance`, `${n}-kuryer jami`, toNum(r.balance), [re], {
          table: [{ row: re, col: RE.sumCol }, { row: re }],
        }),
        money(
          `top${n}_cash`,
          `${n}-kuryer naqd`,
          toNum(r.balance_cash),
          [[re, /naqd/]],
          {
            table: [{ row: re, col: RE.cashCol }],
          },
        ),
        money(
          `top${n}_card`,
          `${n}-kuryer karta`,
          toNum(r.balance_card),
          [[re, /karta/]],
          {
            table: [{ row: re, col: RE.cardCol }],
          },
        ),
      );
    });
    const names = top.map(ownerName).filter((x): x is string => !!x);
    if (names.length >= 2) {
      items.push({
        key: 'top_order',
        label: 'Top-3 tartibi',
        kind: 'order',
        value: names,
      });
    }
    return { items, notes };
  },
};

const YES_ENOUGH = [
  /\byetadi\b/,
  /ortadi/,
  /ortib qoladi/,
  /qoplaydi/,
  /\byetarli\b/,
];
const NO_ENOUGH = [
  /yetmaydi/,
  /yetishmaydi/,
  /yetarli emas/,
  /qoplamaydi/,
  /taqchil/,
];

const Q3: QuestionSpec = {
  n: 3,
  title: 'Marketlarga qarz (sof va musbat), kassa yetadimi',
  live: true,
  text: () =>
    "Marketlarga hozir qancha qarzmiz: sof hisobda (musbat va manfiy qoldiqlar birga) va faqat musbat qoldiqlar bo'yicha («berilishi kerak»)? Nechta marketda qoldiq bor va eng katta qarzimiz qaysi marketga, qancha? Asosiy kassadagi pul sof qarzni yopishga yetadimi — qancha ortadi yoki yetmaydi?",
  requiredTools: ['get_market_payables', 'get_cash_position'],
  expectedPeriods: () => ({
    get_market_payables: [null],
    get_cash_position: [null],
  }),
  defaultPeriod: () => null,
  reads: () => [
    { id: 'fb', path: '/finance/cashbox/financial-balanse' },
    {
      id: 'allInfo',
      path: '/finance/cashbox/all-info',
      query: { page: 1, limit: 1 },
    },
  ],
  truth(res) {
    const fb = dataOf(res.fb);
    const m = rec(fb.markets);
    const rows = list(m.allMarketCashboxes);
    const P = toNum(m.marketPayable);
    const NZ = toNum(m.nonZeroCount) || rows.length;
    const complete = m.truncated !== true && rows.length >= NZ;
    const info = dataOf(res.allInfo);
    const PP = toNum(info.marketPayableTotal);
    const positive = rows
      .filter((r) => toNum(r.balance) > 0)
      .sort((a, b) => toNum(b.balance) - toNum(a.balance));
    const A = toNum(rec(fb.main).balance);
    const D = round2(A - P);
    const notes: string[] = [];
    if (!approxEq(toNum(info.marketCashboxTotal), P)) {
      notes.push(
        `⚠️ all-info marketCashboxTotal (${formatAmount(toNum(info.marketCashboxTotal))}) ≠ marketPayable (${formatAmount(P)})`,
      );
    }
    if (complete && !approxEq(sum(positive.map((r) => toNum(r.balance))), PP)) {
      notes.push(
        '⚠️ Σ musbat allMarketCashboxes ≠ all-info marketPayableTotal',
      );
    }
    const items: ExpectedItem[] = [
      money('P', 'Sof qarz (imzoli)', P, [/\bsof\b/, /imzoli/], {
        traps: [
          {
            value: PP,
            note: 'faqat musbat («berilishi kerak») sof deb berilgan — FAIL',
          },
        ],
      }),
      money(
        'PP',
        'Faqat musbat («berilishi kerak»)',
        PP,
        [/musbat/, /berilishi kerak/],
        {
          skip: complete
            ? undefined
            : "ro'yxat to'liq emas — tool musbat jamini null beradi",
          traps: [
            { value: P, note: 'sof jami «berilishi kerak» deb berilgan' },
          ],
        },
      ),
      count('NZ', 'Qoldiqli marketlar', NZ, [
        /marketda (?:qoldiq|balans)/,
        /qoldig'i (?:bor|noldan)/,
        /noldan farqli/,
        /market(?:lar)?da/,
      ]),
      money('A', 'Asosiy kassa', A, [/asosiy kassa/, /kassada/]),
      money(
        'D',
        'Kassa − sof qarz (|D|)',
        D,
        [
          /ortadi/,
          /ortib/,
          /ortiqcha/,
          /yetmaydi/,
          /yetishmaydi/,
          /\bkam/,
          /qoladi/,
          /farq/,
        ],
        { absOk: true },
      ),
      {
        key: 'D_sign',
        label: 'Yetadimi',
        kind: 'yesno',
        value: D >= 0,
        yes: YES_ENOUGH,
        no: NO_ENOUGH,
      },
    ];
    const top = positive[0];
    if (top) {
      const name = ownerName(top);
      items.push(nameItem('top_name', 'Eng katta qarz — market', name));
      if (name) {
        items.push(
          money(
            'top_balance',
            'Eng katta qarz summasi',
            toNum(top.balance),
            [nameRegex(name)],
            {
              table: [
                { row: nameRegex(name), col: RE.sumCol },
                { row: nameRegex(name) },
              ],
            },
          ),
        );
      }
    } else {
      notes.push('musbat qoldiqli market yo‘q');
    }
    return { items, notes };
  },
};

const Q4: QuestionSpec = {
  n: 4,
  title: 'Filiallardan olinishi kerak, top-3, ortiqcha naqd',
  live: true,
  text: () =>
    "Hisob-kitob bo'yicha filiallardan HQ'ga jami qancha pul olinishi kerak? Eng ko'p qarzdor 3 ta filialni summasi bilan ayting. Kassasida qarzidan ko'p naqd ushlab turgan filial bormi — nechta, qaysilari va qancha ortiq?",
  requiredTools: ['get_branch_settlements'],
  expectedPeriods: () => ({ get_branch_settlements: [null] }),
  defaultPeriod: () => null,
  reads: () => [
    { id: 'fb', path: '/finance/cashbox/financial-balanse' },
    {
      id: 'branches',
      path: '/branches',
      query: { status: 'active', page: 1, limit: 100 },
    },
  ],
  truth(res) {
    const b = rec(dataOf(res.fb).branches);
    const R = toNum(b.branchReceivable);
    const settlement = list(b.items);
    const excess = list(b.cashExceedingPayable);
    const branches = list(dataOf(res.branches).items);
    const byId = new Map(branches.map((x) => [strOf(x.id) ?? '', x] as const));
    const nameOf = (id: unknown) => {
      const x = byId.get(strOf(id) ?? '');
      return x ? strOf(x.name) : null;
    };
    const notes: string[] = [];
    if (!approxEq(sum(settlement.map((r) => toNum(r.amount))), R)) {
      notes.push('⚠️ Σ branches.items.amount ≠ branchReceivable');
    }
    const top = settlement
      .filter((r) => toNum(r.amount) > 0)
      .sort((a, c) => toNum(c.amount) - toNum(a.amount))
      .slice(0, 3);
    for (const r of top) {
      const br = byId.get(strOf(r.branch_id) ?? '');
      if (
        br &&
        (strOf(br.type) ?? '').toUpperCase() !== 'HQ' &&
        !approxEq(toNum(br.olinishi_kerak), Math.max(toNum(r.amount), 0))
      ) {
        notes.push(
          `⚠️ filial ${strOf(r.branch_id)}: /branches olinishi_kerak ≠ max(amount, 0)`,
        );
      }
    }
    const items: ExpectedItem[] = [
      money('R', 'Jami olinishi kerak (imzoli)', R, [
        /\bjami\b/,
        /olinishi kerak/,
        /\bsof\b/,
      ]),
    ];
    top.forEach((r, i) => {
      const name = nameOf(r.branch_id);
      const n = i + 1;
      items.push(nameItem(`top${n}_name`, `${n}-filial`, name));
      if (name) {
        const re = nameRegex(name);
        items.push(
          money(
            `top${n}_amount`,
            `${n}-filial summasi`,
            toNum(r.amount),
            [re],
            {
              table: [
                { row: re, col: /qarz|olinishi|summa|jami/ },
                { row: re },
              ],
            },
          ),
        );
      }
    });
    const topNames = top
      .map((r) => nameOf(r.branch_id))
      .filter((x): x is string => !!x);
    if (topNames.length >= 2)
      items.push({
        key: 'top_order',
        label: 'Top-3 tartibi',
        kind: 'order',
        value: topNames,
      });
    items.push(
      count('X', 'Qarzidan ko‘p naqdli filiallar', excess.length, [
        /qarzidan (?:ko'p|ortiq)/,
        /ortiq(?:cha)? naqd/,
        /ko'p naqd/,
      ]),
    );
    excess.slice(0, 5).forEach((r, i) => {
      const name = nameOf(r.branch_id);
      items.push(
        nameItem(`x${i + 1}_name`, `Ortiqcha naqd: ${i + 1}-filial`, name),
      );
      if (name) {
        const re = nameRegex(name);
        items.push(
          money(
            `x${i + 1}_excess`,
            `Ortiqcha naqd: ${name}`,
            toNum(r.excess),
            [[re, /ortiq|ko'p|excess/], re],
            {
              table: [{ row: re, col: /ortiq|farq|excess|ko'p/ }],
            },
          ),
        );
      }
    });
    return { items, notes };
  },
};

function cashboxTypeCheck(run: AssistantRun): Check[] {
  const bad = toolCallsOf(run, 'get_cashbox_history').filter(
    (c) =>
      c.input.cashbox_type !== undefined && c.input.cashbox_type !== 'main',
  );
  return [
    check(
      'cashbox_type',
      bad.length === 0,
      'fail',
      bad.length
        ? `get_cashbox_history cashbox_type=${String(bad[0].input.cashbox_type)} — asosiy kassa emas`
        : 'cashbox_type — main/sukut',
    ),
  ];
}

const Q5: QuestionSpec = {
  n: 5,
  title: 'O‘tgan oy asosiy kassa kirim/chiqim, kuryer to‘lovlari',
  live: false,
  text: (ctx) => {
    const p = ctx.periods.m1;
    const when = ctx.explicit ? `${p.from} dan ${p.to} gacha` : "O'tgan oyda";
    return `${when} asosiy kassaga jami qancha kirim va qancha chiqim bo'ldi, sof farq qancha? Kirim va chiqim operatsiyalari soni nechta? Kirimning qanchasi kuryerlar topshirgan to'lovlardan kelgan (summa va soni)?`;
  },
  requiredTools: ['get_cashbox_history'],
  expectedPeriods: (ctx) => ({ get_cashbox_history: [ctx.periods.m1] }),
  defaultPeriod: (ctx) => ctx.periods.m1,
  reads: (_ctx, p) => {
    const base = { cashbox_type: 'main', from_date: p!.from, to_date: p!.to };
    return [
      { id: 'all', path: '/finance/history/daily', query: base },
      {
        id: 'courier',
        path: '/finance/history/daily',
        query: {
          ...base,
          operation_type: 'income',
          source_type: 'courier_payment',
        },
      },
    ];
  },
  truth(res) {
    const t = rec(dataOf(res.all).totals);
    const c = rec(dataOf(res.courier).totals);
    const E1 = toNum(t.income);
    const E2 = toNum(t.expense);
    const E4 = toNum(t.income_count);
    const E5 = toNum(t.expense_count);
    const notes: string[] = [];
    if (E4 + E5 > 1000) {
      notes.push(
        `davrda ${E4 + E5} qator — by_source kesimi qisman (breakdown_complete=false): kuryer qismi source_type=courier_payment filtrli chaqiruvdan (aniq totals) olinishi kerak`,
      );
    }
    return {
      items: [
        money('E1', 'Kirim', E1, [/kirim/], {
          table: [{ row: /kirim/, col: /summa|jami|miqdor/ }, { row: /kirim/ }],
        }),
        money('E2', 'Chiqim', E2, [/chiqim/], {
          table: [
            { row: /chiqim/, col: /summa|jami|miqdor/ },
            { row: /chiqim/ },
          ],
        }),
        money('E3', 'Sof farq', toNum(t.net), [/\bsof\b/, /farq/], {
          absOk: true,
          signedIfExplicit: true,
          table: [{ row: /\bsof|farq/ }],
        }),
        count('E4', 'Kirim soni', E4, [/kirim/], {
          table: [{ row: /kirim/, col: RE.countCol }],
        }),
        count('E5', 'Chiqim soni', E5, [/chiqim/], {
          table: [{ row: /chiqim/, col: RE.countCol }],
        }),
        money('E6', 'Kuryer to‘lovlari (summa)', toNum(c.income), [/kuryer/], {
          table: [{ row: /kuryer/, col: /summa|jami|miqdor/ }],
        }),
        count(
          'E7',
          'Kuryer to‘lovlari (soni)',
          toNum(c.income_count),
          [/kuryer/],
          { table: [{ row: /kuryer/, col: RE.countCol }] },
        ),
      ],
      notes,
      blocked:
        E4 + E5 === 0
          ? "ma'lumot yo'q (0 qator) — ELCHI_TC_TODAY bilan ma'lumotli oyni tanlang"
          : undefined,
    };
  },
  extraChecks: (_ctx, run) => {
    // §6 Q5: davr > 1000 qator — by_source qisman; kuryer qismi faqat
    // `source_type=courier_payment` filtrli chaqiruvdan aniq. Raqam
    // tasodifan mos kelsa ham inson ko'radi (E6/E7 mos kelmasa — baribir FAIL).
    const partial = run.toolResults.some(
      (r) => r.tool === 'get_cashbox_history' && r.ok && r.records > 1000,
    );
    if (!partial) return cashboxTypeCheck(run);
    const filtered = toolCallsOf(run, 'get_cashbox_history').some(
      (c) => c.input.source_type === 'courier_payment',
    );
    return [
      ...cashboxTypeCheck(run),
      check(
        'courier_filtered',
        filtered,
        'review',
        filtered
          ? 'kuryer qismi source_type=courier_payment filtrli chaqiruvdan'
          : 'davr > 1000 qator, kuryer qismi filtrli chaqiruvsiz — by_source qisman',
      ),
    ];
  },
};

const Q6: QuestionSpec = {
  n: 6,
  title: 'O‘tgan hafta smenalar: kamomad, farq, avto-yopilgan',
  live: false,
  text: (ctx) => {
    const p = ctx.periods.week;
    return ctx.explicit
      ? `${p.from} dan ${p.to} gacha ochilgan smenalarda kamomad bo'ldimi? Nechta smena ochilgan, kamomad naqdda va kartada jami qancha, nechta smenada farq bor va nechta smena avtomatik yopilgan?`
      : "O'tgan hafta (dushanbadan yakshanbagacha) smenalarda kamomad bo'ldimi? Nechta smena ochilgan, kamomad naqdda va kartada jami qancha, nechta smenada farq bor va nechta smena avtomatik yopilgan?";
  },
  requiredTools: ['get_shift_summaries'],
  expectedPeriods: (ctx) => ({ get_shift_summaries: [ctx.periods.week] }),
  defaultPeriod: (ctx) => ctx.periods.week,
  reads: (_ctx, p) => [
    {
      id: 'shifts',
      path: '/finance/shift',
      query: { from_date: p!.from, to_date: p!.to, page: 1, limit: 200 },
    },
    {
      id: 'shiftsIso',
      path: '/finance/shift',
      query: {
        from_date: `${p!.from}T00:00:00.000+05:00`,
        to_date: `${p!.to}T23:59:59.999+05:00`,
        page: 1,
        limit: 1,
      },
    },
  ],
  truth(res) {
    const d = dataOf(res.shifts);
    const rows = list(d.items);
    const N = toNum(rec(d.pagination).total) || rows.length;
    const NIso = toNum(rec(dataOf(res.shiftsIso).pagination).total);
    let SC = 0;
    let SK = 0;
    let D = 0;
    let AUTO = 0;
    let legacy = 0;
    for (const r of rows) {
      const dc = toNum(r.discrepancy_cash);
      const dk = toNum(r.discrepancy_card);
      if (dc < 0) SC += dc;
      if (dk < 0) SK += dk;
      if (dc !== 0 || dk !== 0) D += 1;
      if (r.close_reason === 'auto') AUTO += 1;
      else if (r.status !== 'open' && r.close_reason == null) legacy += 1;
    }
    const notes = [
      `close_reason=null bilan yopilgan eski smenalar: ${legacy} (avto emas)`,
    ];
    let blocked: string | undefined;
    if (NIso !== N) {
      blocked = `D1 tuzatishi serverda yo'q: YYYY-MM-DD bilan ${N} ta, ISO chegaralar bilan ${NIso} ta — finance-service'ni yangilang`;
    } else if (N > 200) {
      blocked = `smenalar ${N} ta (> 200) — tool faqat 200 tasini o'qiydi; qisqaroq davr tanlang`;
    } else if (N === 0) {
      blocked =
        "davrda smena yo'q — ELCHI_TC_TODAY bilan boshqa haftani tanlang";
    }
    return {
      items: [
        count('N', 'Smenalar soni', N, [
          /ochilgan/,
          /smena(?:lar)? soni/,
          /\bsmena/,
        ]),
        money('SC', 'Kamomad naqd', round2(SC), [[/kamomad/, /naqd/], /naqd/], {
          absOk: true,
          table: [{ row: /naqd/ }, { col: /naqd/ }],
        }),
        money(
          'SK',
          'Kamomad karta',
          round2(SK),
          [[/kamomad/, /karta/], /karta/],
          { absOk: true, table: [{ row: /karta/ }, { col: /karta/ }] },
        ),
        count('D', 'Farqli smenalar', D, [
          /farq/,
          /kamomad(?:li)? (?:bor|bo'lgan|qayd)/,
        ]),
        count('AUTO', 'Avto-yopilgan', AUTO, [/avto(?:matik)?/]),
      ],
      notes,
      blocked,
    };
  },
  extraChecks: (_ctx, run) => {
    const withStatus = toolCallsOf(run, 'get_shift_summaries').filter(
      (c) => c.input.status !== undefined,
    );
    return [
      check(
        'status',
        withStatus.length === 0,
        'review',
        withStatus.length
          ? 'status filtri berilgan — barcha smenalar so‘ralgan'
          : 'status filtri yo‘q',
      ),
    ];
  },
};

const Q7: QuestionSpec = {
  n: 7,
  title: 'O‘tgan oy qo‘lda xarajatlar kategoriyalari + P&L daftari',
  live: false,
  text: (ctx) => {
    const p = ctx.periods.m1;
    const when = ctx.explicit ? `${p.from} dan ${p.to} gacha` : "O'tgan oy";
    // «Shu oy» — joriy oy deb ham o'qiladi (Q10 period_stated shunday):
    // P&L davri o'tgan oy ekani qayta aytiladi.
    const same = ctx.explicit ? 'Shu davrda' : "O'tgan oy uchun";
    return `${when} asosiy kassadan qo'lda kiritilgan xarajatlar qaysi 3 ta kategoriyaga eng ko'p ketdi (summa va soni bilan)? Qo'lda kiritilgan xarajatlar jami qancha va shundan kategoriyasizi qancha? ${same} moliyaviy daftar (P&L) bo'yicha jami kirim, jami chiqim va sof o'zgarish qancha?`;
  },
  requiredTools: ['get_expenses_by_category', 'get_revenue_profit'],
  expectedPeriods: (ctx) => ({
    get_expenses_by_category: [ctx.periods.m1],
    get_revenue_profit: [ctx.periods.m1],
  }),
  defaultPeriod: (ctx) => ctx.periods.m1,
  reads: (_ctx, p) => {
    const base = {
      cashbox_type: 'main',
      operation_type: 'expense',
      from_date: p!.from,
      to_date: p!.to,
    };
    return [
      {
        id: 'manualRows',
        path: '/finance/history',
        query: { ...base, source_type: 'manual_expense', limit: 0 },
      },
      { id: 'categories', path: '/finance/cashbox/expense-categories' },
      {
        id: 'manualDaily',
        path: '/finance/history/daily',
        query: { ...base, source_type: 'manual_expense' },
      },
      { id: 'allDaily', path: '/finance/history/daily', query: base },
      {
        id: 'ledger',
        path: '/finance/financial-balance/analytics',
        query: { from_date: p!.from, to_date: p!.to },
      },
    ];
  },
  truth(res) {
    const rows = list(dataOf(res.manualRows).items);
    const names = new Map(
      list(dataOf(res.categories).items).map(
        (c) => [strOf(c.id) ?? '', strOf(c.name)] as const,
      ),
    );
    const manual = rec(dataOf(res.manualDaily).totals);
    const M = toNum(manual.expense);
    const Mcount = toNum(manual.expense_count);
    const allTotal = toNum(rec(dataOf(res.allDaily).totals).expense);
    const groups = new Map<string, { count: number; amount: number }>();
    let unc = 0;
    for (const r of rows) {
      const id = strOf(r.expense_category_id);
      if (!id) {
        unc += toNum(r.amount);
        continue;
      }
      const g = groups.get(id) ?? { count: 0, amount: 0 };
      g.count += 1;
      g.amount += toNum(r.amount);
      groups.set(id, g);
    }
    const notes: string[] = [];
    if (
      !approxEq(sum(rows.map((r) => toNum(r.amount))), M) ||
      rows.length !== Mcount
    ) {
      notes.push(
        `⚠️ /finance/history (limit=0) qatorlari history/daily bilan mos emas (${rows.length} ≠ ${Mcount})`,
      );
    }
    const ledger = rec(dataOf(res.ledger).summary);
    const top = [...groups.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .slice(0, 3);
    const items: ExpectedItem[] = [];
    top.forEach(([id, g], i) => {
      const n = i + 1;
      const current = names.get(id);
      const name = current ?? `#${id}`;
      if (!current)
        notes.push(
          `kategoriya ${id} o'chirilgan — tool '#${id}' (deleted_category) deb beradi`,
        );
      const re = current ? nameRegex(current) : new RegExp(`#${id}(?!\\d)`);
      items.push(
        nameItem(`cat${n}_name`, `${n}-kategoriya`, name),
        money(
          `cat${n}_amount`,
          `${n}-kategoriya summasi (${name})`,
          round2(g.amount),
          [re],
          {
            table: [{ row: re, col: /summa|jami|miqdor/ }, { row: re }],
          },
        ),
        count(
          `cat${n}_count`,
          `${n}-kategoriya soni (${name})`,
          g.count,
          [re],
          {
            table: [{ row: re, col: RE.countCol }],
          },
        ),
      );
    });
    const catNames = top.map(([id]) => names.get(id) ?? `#${id}`);
    if (catNames.length >= 2)
      items.push({
        key: 'cat_order',
        label: 'Top-3 tartibi',
        kind: 'order',
        value: catNames,
      });
    items.push(
      money('M', 'Qo‘lda xarajatlar jami', M, [/qo'lda/], {
        traps: [
          {
            value: allTotal,
            note: 'asosiy kassaning BARCHA chiqimi (total_expense) «qo‘lda» deb berilgan — FAIL',
          },
        ],
      }),
      money(
        'UNC',
        'Kategoriyasiz qo‘lda xarajat',
        round2(unc),
        [/kategoriyasiz/],
        {
          table: [
            { row: /kategoriyasiz/, col: /summa|jami|miqdor/ },
            { row: /kategoriyasiz/ },
          ],
        },
      ),
      money(
        'L1',
        'Daftar: jami kirim',
        toNum(ledger.totalPositive),
        [/kirim/],
        { table: [{ row: /kirim/ }] },
      ),
      money(
        'L2',
        'Daftar: jami chiqim',
        toNum(ledger.totalNegative),
        [/chiqim/],
        {
          absOk: true,
          table: [{ row: /chiqim/ }],
          traps: [
            {
              value: allTotal,
              note: 'kassa chiqimi (total_expense) daftar chiqimi deb berilgan — FAIL',
            },
          ],
        },
      ),
      money(
        'L3',
        'Daftar: sof o‘zgarish',
        toNum(ledger.netChange),
        [/\bsof\b/, /o'zgarish/],
        {
          absOk: true,
          signedIfExplicit: true,
          table: [{ row: /\bsof|o'zgarish/ }],
        },
      ),
    );
    let blocked: string | undefined;
    if (Mcount > 1000) {
      blocked = `qo'lda xarajatlar ${Mcount} ta (> 1000) — kategoriya kesimi qisman (by_category_complete=false); qisqaroq davr tanlang`;
    } else if (!top.length) {
      blocked =
        "davrda kategoriyali qo'lda xarajat yo'q — ELCHI_TC_TODAY bilan boshqa oyni tanlang";
    }
    return { items, notes, blocked };
  },
};

const DIRECTION_UP = [
  /o'sdi/,
  /o'sgan/,
  /oshdi/,
  /oshgan/,
  /ortdi/,
  /ortgan/,
  /o'sish/,
];
const DIRECTION_DOWN = [
  /kamaydi/,
  /kamaygan/,
  /pasaydi/,
  /pasaygan/,
  /tushdi/,
  /qisqardi/,
  /kamayish/,
  /pasayish/,
];

const Q8: QuestionSpec = {
  n: 8,
  title: 'Ikki oy: tushum, foyda, sotilgan buyurtmalar, foyda o‘zgarishi %',
  live: false,
  text: (ctx) => {
    const { m0, m1 } = ctx.periods;
    if (!ctx.explicit) {
      return "O'tgan oy va undan oldingi oyda sotuvdan qancha tushum va sof foyda bo'lgan, har oyda nechta buyurtma sotilgan? O'tgan oy foydasi undan oldingi oyga nisbatan necha foizga o'sdi yoki kamaydi?";
    }
    return `${monthTitle(m0.from)} (${m0.from} — ${m0.to}) va ${monthTitle(m1.from)} (${m1.from} — ${m1.to}) oylarida sotuvdan qancha tushum va sof foyda bo'lgan, har oyda nechta buyurtma sotilgan? ${monthTitle(m1.from)} foydasi ${monthTitle(m0.from)} ga nisbatan necha foizga o'sdi yoki kamaydi?`;
  },
  requiredTools: ['get_revenue_profit'],
  expectedPeriods: (ctx) => ({
    get_revenue_profit: [ctx.periods.m0, ctx.periods.m1, ctx.periods.m0m1],
  }),
  defaultPeriod: () => null,
  reads: (ctx) => [
    {
      id: 'revenue',
      path: '/analytics/revenue',
      query: {
        startDate: ctx.periods.m0.from,
        endDate: ctx.periods.m1.to,
        period: 'monthly',
      },
    },
  ],
  truth(res, ctx) {
    const d = dataOf(res.revenue);
    const rows = list(d.data);
    const bucket = (p: Period) =>
      rec(rows.find((r) => r.period === `M:${p.from.slice(0, 7)}`));
    const b0 = bucket(ctx.periods.m0);
    const b1 = bucket(ctx.periods.m1);
    const [R0, P0, O0] = [
      toNum(b0.revenue),
      toNum(b0.profit),
      toNum(b0.ordersCount),
    ];
    const [R1, P1, O1] = [
      toNum(b1.revenue),
      toNum(b1.profit),
      toNum(b1.ordersCount),
    ];
    const notes: string[] = [];
    if (!approxEq(toNum(rec(d.summary).totalRevenue), R0 + R1))
      notes.push('⚠️ summary.totalRevenue ≠ R0 + R1');
    const re0 = monthRegex(ctx.periods.m0.from);
    const re1 = monthRegex(ctx.periods.m1.from);
    const items: ExpectedItem[] = [];
    for (const [k, re, R, P, O] of [
      ['0', re0, R0, P0, O0],
      ['1', re1, R1, P1, O1],
    ] as const) {
      const mt = monthTitle(
        k === '0' ? ctx.periods.m0.from : ctx.periods.m1.from,
      );
      items.push(
        money(`R${k}`, `Tushum — ${mt}`, R, [[re, /tushum|daromad|savdo/]], {
          table: [{ row: re, col: /tushum|daromad|savdo/ }],
        }),
        money(`P${k}`, `Sof foyda — ${mt}`, P, [[re, /foyda/]], {
          table: [{ row: re, col: /foyda/ }],
        }),
        count(
          `O${k}`,
          `Sotilgan buyurtmalar — ${mt}`,
          O,
          [[re, /buyurtma|sotilgan/]],
          { table: [{ row: re, col: /buyurtma|soni|sotilgan/ }] },
        ),
      );
    }
    const dP = P0 !== 0 ? round1(((P1 - P0) / Math.abs(P0)) * 100) : null;
    items.push(
      {
        key: 'dP',
        label: 'Foyda o‘zgarishi, %',
        kind: 'percent',
        value: dP,
        labels: [/foyda/, /o'zgar|o'sdi|kamaydi|o'sish|pasay/],
        absOk: true,
        ...(dP === null ? { skip: 'P0 = 0 — foiz aniqlanmagan' } : {}),
      },
      {
        key: 'dP_dir',
        label: 'Yo‘nalish (o‘sdi/kamaydi)',
        kind: 'yesno',
        value: P1 >= P0,
        yes: DIRECTION_UP,
        no: DIRECTION_DOWN,
      },
    );
    let blocked: string | undefined;
    if (d.degraded === true)
      blocked = 'analytics degraded=true — qayta ishga tushiring';
    else if (P0 === 0)
      blocked =
        'undan oldingi oy foydasi 0 — foiz aniqlanmagan; ELCHI_TC_TODAY bilan sotuvli oylarni tanlang';
    return { items, notes, blocked };
  },
  extraChecks: (ctx, run) => {
    const periods = run.toolResults
      .filter((r) => r.tool === 'get_revenue_profit' && r.ok)
      .map((r) => r.period);
    const covered =
      periods.some((p) => samePeriod(p, ctx.periods.m0m1)) ||
      (periods.some((p) => samePeriod(p, ctx.periods.m0)) &&
        periods.some((p) => samePeriod(p, ctx.periods.m1)));
    const flow = toolCallsOf(run, 'get_order_flow').length > 0;
    return [
      check(
        'coverage',
        covered,
        'fail',
        covered
          ? 'ikkala oy qamrab olingan'
          : 'get_revenue_profit ikkala oyni qamrab olmagan',
      ),
      check(
        'no_order_flow',
        !flow,
        'review',
        flow
          ? 'get_order_flow ham chaqirilgan — uning `previous` oynasi kalendar oy EMAS; raqamlar qayerdan olinganini tekshiring'
          : 'get_order_flow ishlatilmagan',
      ),
    ];
  },
};

const IN_TRANSIT = [
  /yo'l(?:da|dagi)/,
  /tranzit/,
  /yetkazilayotgan/,
  /yetkazish jarayonida/,
];
const REFUSAL = [
  /yo'q/,
  /mavjud emas/,
  /ko'rsatilmagan/,
  /berilmagan/,
  /bera olmayman/,
  /aniqlab bo'lmaydi/,
  /mumkin emas/,
  /ma'lumot(?:i|lar)?(?:im)?(?:da)? (?:yo'q|mavjud emas|berilmagan)/,
];

const Q9: QuestionSpec = {
  n: 9,
  title: 'O‘tgan hafta buyurtmalar oqimi + «yo‘lda» (raqam bo‘lmasligi kerak)',
  live: false,
  text: (ctx) => {
    const { week, weekBefore } = ctx.periods;
    const when = ctx.explicit
      ? `${week.from} dan ${week.to} gacha`
      : "O'tgan hafta (dushanbadan yakshanbagacha)";
    const prev = ctx.explicit
      ? `oldingi 7 kunga (${weekBefore.from} — ${weekBefore.to})`
      : 'undan oldingi haftaga';
    return `${when} nechta buyurtma qabul qilindi, nechtasi sotildi va nechtasi bekor qilindi? ${prev[0].toUpperCase()}${prev.slice(1)} nisbatan har biri qancha ko'p yoki kam? Muvaffaqiyat ulushi bo'yicha eng yaxshi market qaysi? Hozir yo'lda nechta buyurtma bor?`;
  },
  requiredTools: ['get_order_flow'],
  expectedPeriods: (ctx) => ({
    get_order_flow: [ctx.periods.week, ctx.periods.weekBefore],
  }),
  defaultPeriod: (ctx) => ctx.periods.week,
  reads: (_ctx, p) => [
    {
      id: 'dash',
      path: '/analytics/dashboard',
      query: { startDate: p!.from, endDate: p!.to },
    },
    {
      id: 'dashPrev',
      path: '/analytics/dashboard',
      query: { startDate: addDays(p!.from, -7), endDate: addDays(p!.to, -7) },
    },
  ],
  truth(res, _ctx, period) {
    const d = dataOf(res.dash);
    const o = rec(d.orders);
    const prev = rec(d.previous);
    const A1 = toNum(o.acceptedCount ?? o.total);
    const S1 = toNum(o.soldAndPaid);
    const C1 = toNum(o.cancelled);
    const A0 = toNum(prev.acceptedCount);
    const S0 = toNum(prev.soldAndPaid);
    const C0 = toNum(prev.cancelled);
    const notes: string[] = [];
    const po = rec(dataOf(res.dashPrev).orders);
    if (
      toNum(po.acceptedCount) !== A0 ||
      toNum(po.soldAndPaid) !== S0 ||
      toNum(po.cancelled) !== C0
    ) {
      notes.push('⚠️ previous ≠ oldingi haftaning alohida dashboard o‘qishi');
    }
    const cur = new RegExp(
      `o'tgan hafta|joriy|shu hafta|bu hafta|${dayHeaderRe(period!.from)}`,
    );
    const old = new RegExp(
      `oldingi|avvalgi|${dayHeaderRe(addDays(period!.from, -7))}`,
    );
    const diff = /farq|o'zgarish|δ|±|ko'p|kam/;
    const items: ExpectedItem[] = [];
    for (const [k, re, now, before] of [
      ['A', /qabul/, A1, A0],
      ['S', /sotil/, S1, S0],
      ['C', /bekor/, C1, C0],
    ] as const) {
      const what = k === 'A' ? 'Qabul' : k === 'S' ? 'Sotilgan' : 'Bekor';
      items.push(
        count(`${k}1`, `${what} (o‘tgan hafta)`, now, [re], {
          table: [{ row: re, col: cur }],
        }),
        count(
          `${k}0`,
          `${what} (oldingi hafta)`,
          before,
          [[re, /oldingi|avvalgi/]],
          { table: [{ row: re, col: old }], valueAfter: true },
        ),
        count(
          `d${k}`,
          `${what}: farq`,
          now - before,
          [[re, /farq|ko'p|kam|o'zgar|\+|-/]],
          {
            absOk: true,
            signedIfExplicit: true,
            table: [{ row: re, col: diff }],
          },
        ),
      );
    }
    const allowed = [A1, S1, C1, A0, S0, C0, A1 - A0, S1 - S0, C1 - C0];
    items.push({
      key: 'in_transit',
      label: '«Yo‘lda» — raqam bo‘lmasligi kerak (9b)',
      kind: 'absent',
      value: null,
      labels: IN_TRANSIT,
      refusal: REFUSAL,
      allowed,
      // «qabul − sotilgan − bekor» — tipik o'ylab topilgan «yo'ldagi» soni.
      // Ruxsat etilgan raqamga teng bo'lsa olinmaydi (to'g'ri javob FAIL
      // bo'lmasin).
      suspect: [A1 - S1 - C1, A0 - S0 - C0].filter(
        (x) => x !== 0 && !allowed.some((a) => Math.abs(a) === Math.abs(x)),
      ),
    });
    const top = list(d.topMarkets);
    if (top.length) {
      const lead = top[0];
      const leaders = top
        .filter(
          (r) =>
            toNum(r.success_rate) === toNum(lead.success_rate) &&
            toNum(r.total_orders) === toNum(lead.total_orders),
        )
        .map((r) => strOf(r.market_name))
        .filter((x): x is string => !!x);
      items.push(
        nameItem(
          'top_market',
          'Eng yaxshi market (success_rate, 9c)',
          leaders.length ? leaders : null,
        ),
      );
      if (leaders.length) {
        items.push({
          key: 'top_market_rate',
          label: 'Uning muvaffaqiyat ulushi, %',
          kind: 'percent',
          value: toNum(lead.success_rate),
          labels: leaders.map(nameRegex),
        });
      }
    } else {
      notes.push('topMarkets bo‘sh — 9c baholanmaydi');
    }
    let blocked: string | undefined;
    if (d.degraded === true || d.previous == null)
      blocked = 'dashboard degraded yoki previous=null — qayta ishga tushiring';
    else if (A1 === 0)
      blocked =
        "o'tgan haftada buyurtma yo'q — ELCHI_TC_TODAY bilan boshqa haftani tanlang";
    return { items, notes, blocked };
  },
};

const Q10: QuestionSpec = {
  n: 10,
  title: 'Cheklar tekshiruvi (sukut davr — joriy oy)',
  live: true,
  text: (ctx) => {
    const p = ctx.periods.currentMonth;
    return ctx.explicit
      ? `${p.from} dan ${p.to} gacha kassa cheklari tekshiruvi bo'yicha holat qanday: nechta chekda summa mos kelmadi, farqlar yig'indisi qancha so'm va nechta karta operatsiyasiga chek umuman yuklanmagan?`
      : "Kassa cheklari tekshiruvi bo'yicha holat qanday: nechta chekda summa mos kelmadi, farqlar yig'indisi qancha so'm va nechta karta operatsiyasiga chek umuman yuklanmagan?";
  },
  requiredTools: ['get_receipt_checks'],
  expectedPeriods: (ctx) => ({
    get_receipt_checks: [ctx.periods.currentMonth],
  }),
  defaultPeriod: (ctx) => ctx.periods.currentMonth,
  reads: (_ctx, p) => [
    {
      id: 'summary',
      path: '/finance/receipts/summary',
      query: { from: p!.from, to: p!.to },
    },
  ],
  truth(res, ctx) {
    const d = dataOf(res.summary);
    const counts = rec(d.counts);
    const TOT = toNum(d.total);
    const notes: string[] = [];
    if (Number(ctx.periods.today.slice(8, 10)) <= 3) {
      notes.push(
        "oyning 1–3-kuni: sukut davr juda qisqa — «Oxirgi 30 kunda …» variantini qo'lda bering",
      );
    }
    return {
      items: [
        count('MM', 'Mos kelmagan cheklar', toNum(counts.mismatch), [
          /mos kelma/,
          /mos emas/,
          /mismatch/,
          /nomuvofiq/,
          /farq (?:bor|aniqlangan|chiqqan)/,
        ]),
        money('MT', 'Farqlar yig‘indisi (Σ|farq|)', toNum(d.mismatch_total), [
          /farq(?:lar)?(?:ning)? (?:yig'indisi|jami|summasi)/,
          /jami farq/,
          /σ/,
          /farq/,
        ]),
        count('NONE', 'Chek yuklanmagan', toNum(counts.none), [
          /yuklanmagan/,
          /chek (?:umuman )?yo'q/,
          /cheksiz/,
          /\bnone\b/,
        ]),
      ],
      notes,
      blocked:
        TOT === 0
          ? "davrda chek tekshiruvi yo'q (total=0) — ELCHI_TC_TODAY yoki «oxirgi 30 kun» bilan qayta"
          : undefined,
    };
  },
  extraChecks: (ctx, run, p) => {
    const cp = ctx.periods.currentMonth;
    const said =
      p.norm.includes(cp.from) ||
      p.norm.includes(cp.to) ||
      monthRegex(cp.from).test(p.norm) ||
      /joriy oy|shu oy|bu oy/.test(p.norm);
    const filtered = toolCallsOf(run, 'get_receipt_checks').filter(
      (c) => c.input.kind !== undefined || c.input.ai_status !== undefined,
    );
    return [
      check(
        'period_stated',
        said,
        'review',
        said
          ? 'davr javobda aytilgan'
          : 'qoida 4: sukut davr javobda aytilmagan',
      ),
      check(
        'no_filters',
        filtered.length === 0,
        'review',
        filtered.length
          ? 'kind/ai_status filtri berilgan — umumiy holat so‘ralgan'
          : 'filtr yo‘q',
      ),
    ];
  },
};

export const QUESTIONS: readonly QuestionSpec[] = [
  Q1,
  Q2,
  Q3,
  Q4,
  Q5,
  Q6,
  Q7,
  Q8,
  Q9,
  Q10,
];

/** Tool natijasidagi asosiy davr: kutilganiga teng natija, bo'lmasa birinchisi. */
export function effectivePeriod(
  spec: QuestionSpec,
  run: AssistantRun,
  expected: Period | null,
): Period | null {
  if (!expected) return null;
  const rows = run.toolResults.filter(
    (r) => r.tool === spec.requiredTools[0] && r.ok && r.period,
  );
  return (
    (rows.find((r) => samePeriod(r.period, expected)) ?? rows[0])?.period ??
    expected
  );
}

/** Hamma savol uchun umumiy tuzilma tekshiruvlari. */
export function structuralChecks(
  spec: QuestionSpec,
  ctx: TcContext,
  run: AssistantRun,
  p: PreparedAnswer,
): Check[] {
  const out: Check[] = [];
  const sources = run.done?.sources ?? [];
  for (const tool of spec.requiredTools) {
    const ok = sources.some((s) => s.tool === tool && s.ok);
    out.push(
      check(
        `tool:${tool}`,
        ok,
        'fail',
        ok
          ? `${tool} chaqirilgan`
          : `${tool} chaqirilmagan yoki xato bilan tugagan`,
      ),
    );
  }
  const failed = sources.filter((s) => !s.ok);
  if (failed.length) {
    out.push(
      check(
        'sources_ok',
        false,
        'review',
        `ok=false manbalar: ${failed.map((s) => s.tool).join(', ')}`,
      ),
    );
  }
  const expected = spec.expectedPeriods(ctx);
  for (const r of run.toolResults) {
    const accepted = expected[r.tool];
    if (!accepted || !r.ok) continue;
    const ok = accepted.some((a) => samePeriod(a, r.period));
    out.push(
      check(
        `period:${r.tool}`,
        ok,
        'fail',
        ok
          ? `${r.tool}: ${periodText(r.period)}`
          : `${r.tool}: davr ${periodText(r.period)}, kutilgan ${accepted.map(periodText).join(' yoki ')}`,
      ),
    );
  }
  // Qoida 6 (§5): ok manbada truncated=true bo'lsa — javob buni aytishi shart.
  const cut = sources.filter((s) => s.ok && s.truncated);
  if (cut.length) {
    const said = RE.truncNote.test(p.norm);
    out.push(
      check(
        'truncated_stated',
        said,
        'review',
        said
          ? 'qisqartirilgan natija javobda aytilgan'
          : `qoida 6: ${[...new Set(cut.map((s) => s.tool))].join(', ')} truncated=true — javob buni aytmagan`,
      ),
    );
  }
  const manba = RE.manba.test(p.norm);
  out.push(
    check(
      'manba',
      manba,
      'review',
      manba ? '«Manba:» qatori bor' : '«Manba:» qatori yo‘q (qoida 5)',
    ),
  );
  if (run.done && run.done.stop !== 'end_turn') {
    out.push(
      check(
        'stop',
        false,
        'review',
        `stop=${run.done.stop} (javob to'liq bo'lmasligi mumkin)`,
      ),
    );
  }
  return out;
}

export interface QuestionEvaluation {
  verdict: Verdict;
  items: ItemResult[];
  checks: Check[];
  notes: string[];
  reason: string | null;
}

/** Savolni baholaydi (javob + haqiqat + jonli holat farqi). */
export function evaluateQuestion(
  spec: QuestionSpec,
  ctx: TcContext,
  run: AssistantRun,
  truth: TruthResult,
  drift: readonly string[] | null,
): QuestionEvaluation {
  if (!run.done) {
    const reason = run.error
      ? `${run.error.code}: ${run.error.message}`
      : 'done hodisasi kelmadi';
    return {
      verdict: 'ERROR',
      items: [],
      checks: [],
      notes: truth.notes,
      reason,
    };
  }
  const p = prepareAnswer(run.done.answer, truth.masks ?? []);
  const items = truth.items.map((i) => evaluateItem(p, i));
  const checks = [
    ...structuralChecks(spec, ctx, run, p),
    ...(spec.extraChecks?.(ctx, run, p) ?? []),
  ];
  // Tool davri xato bo'lsa (qoida 2) — FAIL ustun: noto'g'ri davr bo'yicha
  // qayta o'qilgan haqiqatning BLOCKED sababi faqat izoh bo'ladi (BLOCKED
  // faqat savoldan OLDINGI o'qishdan — runner savolni yubormaydi).
  const periodFail = checks.some(
    (c) => !c.ok && c.severity === 'fail' && c.id.startsWith('period:'),
  );
  const notes =
    periodFail && truth.blocked
      ? [
          ...truth.notes,
          `tool davri bo'yicha haqiqat yaroqsiz: ${truth.blocked}`,
        ]
      : truth.notes;
  const verdict = decideVerdict({
    items,
    checks,
    drift,
    blocked: periodFail ? null : (truth.blocked ?? null),
  });
  const reason =
    verdict === 'BLOCKED'
      ? (truth.blocked ?? null)
      : verdict === 'DRIFT'
        ? `jonli holat o'zgardi: ${(drift ?? []).join('; ')}`
        : null;
  return { verdict, items, checks, notes, reason };
}

// ─── Sozlama ─────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = 'https://test-api.elchipochta.uz';
export const DEFAULT_OUT = './assistant-tc-results.json';

export class TcConfigError extends Error {}

export interface TcConfig {
  baseUrl: string;
  /** ELCHI_TC_TODAY (yo'q bo'lsa — har savolda haqiqiy Toshkent sanasi). */
  today: string | null;
  only: number[] | null;
  out: string;
}

/**
 * Env'ni tekshiradi (tarmoqdan OLDIN). Telefon va parol qiymati qaytarilmaydi
 * — runner ularni faqat login so'rovida env'dan o'qiydi.
 */
export function parseTcConfig(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): TcConfig {
  const missing = ['ELCHI_TC_PHONE', 'ELCHI_TC_PASSWORD'].filter(
    (k) => !(env[k] ?? '').trim(),
  );
  if (missing.length) {
    throw new TcConfigError(
      `${missing.join(', ')} berilmagan — SUPERADMIN login ma'lumoti faqat env orqali beriladi (qiymatlar hech qayerga yozilmaydi va chiqarilmaydi)`,
    );
  }
  const rawBase = (env.ELCHI_TC_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new TcConfigError(`ELCHI_TC_BASE_URL yaroqsiz: ${rawBase}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new TcConfigError(
      'ELCHI_TC_BASE_URL https:// bo‘lishi kerak (http:// faqat localhost uchun) — parol ochiq kanalda yuborilmaydi',
    );
  }
  const today = (env.ELCHI_TC_TODAY ?? '').trim() || null;
  if (today !== null) {
    if (!isValidYmd(today))
      throw new TcConfigError(
        `ELCHI_TC_TODAY YYYY-MM-DD bo'lishi kerak: ${today}`,
      );
    if (today > tashkentToday(now))
      throw new TcConfigError(`ELCHI_TC_TODAY kelajakda: ${today}`);
  }
  const rawOnly = (env.ELCHI_TC_ONLY ?? '').trim();
  let only: number[] | null = null;
  if (rawOnly) {
    const parts = rawOnly
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const nums = parts.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
    if (
      !nums.length ||
      nums.some((n) => !Number.isInteger(n) || n < 1 || n > QUESTIONS.length)
    ) {
      throw new TcConfigError(
        `ELCHI_TC_ONLY — 1..${QUESTIONS.length} oralig'idagi raqamlar, vergul bilan: ${rawOnly}`,
      );
    }
    only = [...new Set(nums)].sort((a, b) => a - b);
  }
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    today,
    only,
    out: (env.ELCHI_TC_OUT ?? '').trim() || DEFAULT_OUT,
  };
}

// ─── Hisobot ─────────────────────────────────────────────────────────────

export interface QuestionReport {
  n: number;
  title: string;
  question: string | null;
  verdict: Verdict;
  reason: string | null;
  conversation_id: string | null;
  message_id: string | null;
  audit_path: string | null;
  expected_period: Period | null;
  tool_period: Period | null;
  tool_calls: AssistantRun['toolCalls'];
  tool_results: ToolResultEvent[];
  sources: AssistantSourceRow[];
  answer: string | null;
  stop: string | null;
  cost_usd: number | null;
  items: ItemResult[];
  checks: Check[];
  notes: string[];
  drift: string[] | null;
}

function cell(v: unknown): string {
  const s =
    typeof v === 'number'
      ? formatAmount(v)
      : Array.isArray(v)
        ? v.join(' → ')
        : typeof v === 'boolean'
          ? v
            ? 'ha'
            : "yo'q"
          : v === null || v === undefined
            ? '—'
            : typeof v === 'string'
              ? v
              : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function short(items: ItemResult[], pick: 'expected' | 'assistant'): string {
  const shown = items.filter((i) => i.status !== 'skipped').slice(0, 4);
  const more = items.length > shown.length ? ' …' : '';
  return shown.map((i) => `${i.key}=${cell(i[pick])}`).join('; ') + more;
}

/** Konsol/Trello uchun Markdown: umumiy jadval + har savol tafsiloti. */
export function renderMarkdown(
  meta: { baseUrl: string; startedAt: string; today: string },
  reports: QuestionReport[],
): string {
  const lines: string[] = [];
  lines.push(`## F7PWp6cK — AI yordamchi TC natijalari (${meta.today})`, '');
  lines.push(`Server: ${meta.baseUrl} · boshlandi: ${meta.startedAt}`, '');
  lines.push(
    '| # | Savol | Kutilgan | Assistent | Verdikt | Izoh |',
    '|---|---|---|---|---|---|',
  );
  for (const r of reports) {
    const note =
      r.reason ??
      r.items
        .filter((i) => i.status !== 'match' && i.status !== 'skipped')
        .map((i) => `${i.key}: ${i.status}`)
        .join(', ');
    lines.push(
      `| ${r.n} | ${cell(r.title)} | ${cell(short(r.items, 'expected'))} | ${cell(short(r.items, 'assistant'))} | **${r.verdict}** | ${cell(note || '')} |`,
    );
  }
  const counts = reports.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }),
    {},
  );
  const cost = reports.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  lines.push(
    '',
    `Jami: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} · AI xarajati ≈ $${cost.toFixed(4)}`,
    '',
  );
  for (const r of reports) {
    lines.push(`### Q${r.n} — ${r.title}: ${r.verdict}`, '');
    if (r.reason) lines.push(`Sabab: ${r.reason}`, '');
    if (r.conversation_id)
      lines.push(
        `Audit: \`GET /ai/assistant/conversations/${r.conversation_id}\``,
        '',
      );
    lines.push(
      `Davr: kutilgan ${periodText(r.expected_period)} · tool ${periodText(r.tool_period)}`,
      '',
    );
    if (r.items.length) {
      lines.push(
        '| Qiymat | Kutilgan | Assistent | Holat | Izoh |',
        '|---|---|---|---|---|',
      );
      for (const i of r.items) {
        lines.push(
          `| ${cell(i.label)} | ${cell(i.expected)} | ${cell(i.assistant)} | ${i.status}${i.optional ? ' (ixtiyoriy)' : ''} | ${cell(i.note ?? '')} |`,
        );
      }
      lines.push('');
    }
    const bad = r.checks.filter((c) => !c.ok);
    if (bad.length)
      lines.push(
        `Tekshiruvlar: ${bad.map((c) => `${c.severity === 'fail' ? '❌' : '⚠️'} ${c.note}`).join('; ')}`,
        '',
      );
    if (r.notes.length) lines.push(`Izohlar: ${r.notes.join('; ')}`, '');
  }
  return lines.join('\n');
}
