import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import {
  AI_ADVISOR_INPUT_MAX_PERIODS,
  AI_ADVISOR_INPUT_MAX_SINCE_DAYS,
  AI_ADVISOR_SYSTEM_SUBJECT_NAME,
  startOfTashkentDay,
  rmqSend,
  type AiAdvisorCandidate,
  type AiAdvisorCashboxRef,
  type AiAdvisorRef,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleInputsResponse,
  type AiAdvisorRuleKey,
} from '@app/common';
import { FinanceDailyService } from '../aggregates/finance-daily.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { Shift } from '../entities/shift.entity';
import { ShiftAccountCheck } from '../entities/shift-account-check.entity';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { PaymentCorrection } from '../entities/payment-correction.entity';
import { CashboxReceiptService } from '../cashbox-receipt/cashbox-receipt.service';
import { loadReceiptChecksSummary } from '../cashbox-receipt/cashbox-receipt.summary';
import { notReversedSql } from '../cashbox-receipt/cashbox-receipt.views';

/**
 * BE-5 (LhTIno57) — `finance.advisor.rule_inputs`: AI maslahatchi
 * qoidalari uchun FAQAT O'QIYDIGAN agregatlar (API shartnomasi §4.4).
 *
 * - Hech narsa yozmaydi; barcha chegara solishtiruvi SQL `numeric` da.
 * - Kun chegaralari Asia/Tashkent (`AT TIME ZONE`), «oxirgi …» — `createdAt`.
 * - Ism snapshotlari shu yerda (IDENTITY/BRANCH mijozlari finance'da bor);
 *   ism olinmasa `name: null` (FE «#id» ko'rsatadi) — xato emas.
 * - Telefon va boshqa PII qaytarilmaydi.
 */
export const ADVISOR_EVIDENCE_LIMIT = 15;
/** R1: bitta tekshiruvda ko'riladigan yangi smenalar chegarasi. */
const R1_MAX_NEW_SHIFTS = 2_000;
/** R3: bitta tekshiruvda ko'riladigan yangi qo'lda chiqimlar chegarasi. */
const R3_MAX_NEW_ROWS = 2_000;
/** R3: statistika oynasi (kun) va minimal namuna (Q18). */
export const R3_WINDOW_DAYS = 30;
export const R3_MIN_SAMPLE = 5;
/** BQ9 (ega): minimal MAD = mediana × 5%. */
export const R3_MIN_MAD_RATIO = 0.05;
/** R7: bitta tekshiruvda ko'riladigan qatorlar chegarasi (har manba). */
const R7_MAX_ROWS = 2_000;
/** R8: baza oynasi (kun) va minimal haftalik son ([TAKLIF]). */
export const R8_BASELINE_DAYS = 30;
export const R8_MIN_COUNT = 3;

const NAME_TIMEOUT_MS = 5_000;
/** Filial nomlari: parallel so'rovlar chegarasi (round-2 #652). */
const BRANCH_NAME_CONCURRENCY = 5;
/** `branch.user.find_by_user_ids` chegarasi (USER_BRANCH_LOOKUP_MAX). */
const USER_BRANCH_CHUNK = 500;
/**
 * Har SQL ifoda chegarasi — AdvisorReader 30 s timeout'idan PAST (round-2
 * #651 ops-B1): og'ir so'rov finance'ni band qilib qolmaydi, qoida xatosi
 * faqat o'sha qoidaga tegadi (`errors`).
 */
export const ADVISOR_STATEMENT_TIMEOUT_MS = 15_000;
/**
 * Qoidalar SQL qismining UMUMIY byudjeti (#704 review B1): statement_timeout
 * har ifodaga — qoidalar ketma-ket, bitta qulflangan jadval 5 × 15 s = 75 s
 * bo'lardi. 30 s AdvisorReader − 5 s nomlar − zaxira = 22 s; har qoida
 * qolgan vaqt bilan cheklanadi, tugasa — keyingi qoidalar `errors` ga.
 */
export const ADVISOR_RULES_BUDGET_MS = 22_000;
/** Butun `rule_inputs` (nomlar bilan) — AdvisorReader 30 s dan past. */
export const ADVISOR_TOTAL_BUDGET_MS = 28_000;
/** Qulflangan jadval butun byudjetni yemasin — har tranzaksiyada. */
const ADVISOR_LOCK_TIMEOUT = '2s';
/**
 * Ism/filial qidiruvining UMUMIY chegarasi (round-4 #651-2 / #652): osilgan
 * identity/branch-service bilan ham `rule_inputs` AdvisorReader 30 s
 * budjetidan oshmaydi — chegarada nomlar null, `names_degraded` (P6).
 */
export const ADVISOR_NAMES_DEADLINE_MS = 5_000;
/**
 * R2/R4/R5 «hisoblanadigan topshirish» va T6 qaytarish (P4) qidiruvi oynasi
 * (#702 review B1): butun tarix emas, oxirgi 90 kun (chegaralar ≤ 60 kun).
 * Oynada hisoblanadigan kun bo'lmasa — chegara musbat qator boshi (P2).
 */
export const ADVISOR_EPISODE_LOOKBACK_DAYS = 90;
/** R3: bitta tekshiruvdagi vaqt byudjeti — oshsa, ishlangan qismgacha kursor. */
export const R3_TIME_BUDGET_MS = 12_000;
/** R3: yangi qatorlar shu bo'laklarda ishlanadi (progress kafolati). */
const R3_CHUNK = 200;
/** R1: ketma-ketlik uzunligini aniqlash uchun oldingi smenalar chegarasi. */
const R1_STREAK_LOOKBACK = 50;
const SYSTEM_BRANCH_REQUESTER = { id: 'system', roles: ['superadmin'] };
const MAIN_CASHBOX_NAME = 'Asosiy kassa';

const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const moneyOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : money(v);
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,18}$/.test(v);

/** Toshkent kalendar kuni `YYYY-MM-DD`. */
export function tashkentDateKey(date: Date): string {
  // Kun boshi (UTC lahza) + 12 soat — Toshkent kalendar kunining ichida;
  // qo'lda «+5 soat» yo'q (§10, round-2 #651 S9).
  return new Date(startOfTashkentDay(date).getTime() + 12 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/** `YYYY-MM-DD` + n kun. */
export function addDaysKey(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bitta tranzaksiya ichidagi so'rov (statement_timeout bilan). */
type SqlQuery = <R = unknown>(sql: string, params?: unknown[]) => Promise<R>;

interface ShiftRow {
  id: string;
  owner: string;
  closed_at: Date;
  closed_by: string | null;
  closed_by_system: boolean;
  expected_balance_cash: string | null;
  expected_balance_card: string | null;
  discrepancy_cash: string | null;
  discrepancy_card: string | null;
  difference: string;
  is_short: boolean;
  is_negative: boolean;
}

interface EpisodeRow {
  cashbox_id: string;
  owner: string;
  balance: string;
  /** Oxirgi (T6 qaytarilmagan) chiqish — dalil va `last_*` faktlar uchun. */
  last_id: string | null;
  last_at: Date | null;
  last_amount: string | null;
  /** Oxirgi «hisoblanadigan» topshirish kuni (kun yig'indisi ≥ N% boshlang'ich qoldiq). */
  qual_id: string | null;
  qual_at: Date | null;
  /** Joriy musbat qatorning boshi (oxirgi `balance_after <= 0` dan keyingi qator). */
  run_id: string | null;
  run_at: Date | null;
  /** Hisoblanadigan topshirishdan keyingi T6 qaytarish (P4). */
  rev_id: string | null;
  rev_orig_id: string | null;
  rev_at: Date | null;
}

interface Episode {
  /**
   * v0.4: `ep:h:<topshirish id>` | `ep:p:<musbat qator boshi id>` |
   * `ep:h:<asl id>:r<qaytarish id>` (R2 o'sish — `ep:g:<kun>`, r2() da).
   */
  key: string;
  /** Epizod boshlangan Toshkent kuni 00:00 (ISO). */
  at: string;
  /** «N kundan beri» = bugun − chegara kuni (to'liq kalendar kunlari). */
  days: number;
}

/**
 * Epizod chegarasi (shartnoma v0.4, ega qarori 2026-11-18) — eng kechki:
 * - hisoblanadigan topshirish (kun yig'indisi ≥ min_pct × kun boshidagi
 *   qoldiq; R4 — har qanday to'lov) → `ep:h:<o'sha kunning oxirgi chiqishi>`;
 * - joriy musbat qatorning boshi (qoldiq 0 dan o'tgan) → `ep:p:<id>` (P2;
 *   chegaraga bog'liq emas — P3);
 * - hisoblanadigan topshirishdan keyin T6 qaytarilgan topshirish →
 *   `ep:h:<asl>:r<qaytarish>` (P4).
 */
export function episodeOf(r: EpisodeRow, today: string): Episode | null {
  // Teng vaqtda ustunlik: qaytarish > topshirish > musbat qator boshi
  // (qaytarish qatori qoldiqni 0 dan o'tkazsa ikkalasi bir lahzada).
  const options: Array<{ key: string; at: Date }> = [];
  if (r.rev_id && r.rev_orig_id && r.rev_at)
    options.push({
      key: `ep:h:${r.rev_orig_id}:r${r.rev_id}`,
      at: new Date(r.rev_at),
    });
  if (r.qual_id && r.qual_at)
    options.push({ key: `ep:h:${r.qual_id}`, at: new Date(r.qual_at) });
  if (r.run_id && r.run_at)
    options.push({ key: `ep:p:${r.run_id}`, at: new Date(r.run_at) });
  if (!options.length) return null;
  const boundary = options.reduce((a, b) => (b.at > a.at ? b : a));
  const day = tashkentDateKey(boundary.at);
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      86_400_000,
  );
  return {
    key: boundary.key,
    at: new Date(`${day}T00:00:00.000+05:00`).toISOString(),
    days,
  };
}

/**
 * R2 o'sish epizodi (P1): kechagacha uzluksiz, qat'iy o'sib borayotgan
 * yopilishlar qatorining birinchi kuni. Kun yetishmasa (snapshot yo'q) —
 * qator o'sha yerda uziladi (shartnoma v0.4 (b): yo'q kun o'tkaziladi).
 */
export function growthRunStart(
  days: Array<{ date: string; closing: number }>,
  today: string,
): string | null {
  let i = days.length - 1;
  if (i < 0 || days[i].date !== addDaysKey(today, -1)) return null;
  while (
    i > 0 &&
    days[i - 1].date === addDaysKey(days[i].date, -1) &&
    days[i].closing > days[i - 1].closing
  )
    i -= 1;
  return days[i].date;
}

interface CardCheckRow {
  id: string;
  shift_id: string;
  card_id: string;
  entered_balance: string;
  ai_read_balance: string;
  expected_balance: string | null;
  ai_entered_ok: boolean | null;
  ai_last4_detected: string | null;
  card_last4: string | null;
  ai_confidence: string | null;
  /** Kursor qiymati: GREATEST(ai_checked_at, confirmed_at). */
  seen_at: Date;
  closed_at: Date | null;
  opened_at: Date | null;
  owner: string;
  card_name: string | null;
}

interface ReceiptRow {
  id: string;
  kind: string;
  ai_status: string;
  ai_flags: unknown;
  entered_amount: string | null;
  ai_amount: string | null;
  ai_difference: string | null;
  ai_currency: string | null;
  ai_error_reason: string | null;
  ai_date: string | null;
  ai_recipient_last4: string | null;
  ai_payer_last4: string | null;
  ai_bank: string | null;
  ai_reference: string | null;
  ai_confidence: string | null;
  /** Kursor qiymati: GREATEST(ai_checked_at, "updatedAt") (T6 qayta hisobi). */
  seen_at: Date;
  history_id: string | null;
  counter_history_id: string | null;
  receipt_branch_id: string | null;
  op_at: Date | null;
  source_type: string | null;
  category_name: string | null;
  created_by: string | null;
  cashbox_type: string | null;
  owner: string | null;
  counter_cashbox_type: string | null;
  counter_owner: string | null;
}

interface CorrectionCounts {
  manual_correction: number;
  order_rollback: number;
  payment_reverse: number;
  payment_edit: number;
}

/** Karta/chek summasi bo'yicha farq chegarasi (so'm) — `AI_MATCH_TOLERANCE` bilan bir xil. */
const R7_TOLERANCE = 1;

/**
 * Chek sanasi (XOM OCR matni) → `{date_at, date_day}` (§5.4 `date_at`):
 * - aniq mintaqa (`…Z`, `+05:00`) — o'sha bo'yicha;
 * - sana + vaqt, mintaqasiz — Toshkent (+05:00) deb olinadi;
 * - faqat sana — `date_at: null`, `date_day: 'YYYY-MM-DD'` (soxta 00:00 yo'q);
 * - `dd.mm.yyyy` / `dd/mm/yyyy` / `dd-mm-yyyy` (1–2 xonali kun/oy) va
 *   `yyyy-mm-dd`, matn ichida ham (`receipt.rules.ts` parseReceiptDate bilan
 *   bir xil kun); kalendar tekshiriladi (31.02 — yo'q), vaqt ≤ 23:59:59.
 * - `date_day` — mintaqali kirishda o'sha lahzaning TOSHKENT kuni
 *   (`2026-10-22T22:00:00Z` → 2026-10-23); `T` o'rnida bo'sh joy ham bo'ladi.
 */
export function parseReceiptDateTime(raw: string | null | undefined): {
  date_at: string | null;
  date_day: string | null;
} {
  const none = { date_at: null, date_day: null };
  if (typeof raw !== 'string') return none;
  const text = raw.trim();
  const zoned =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(
      text,
    );
  if (zoned) {
    if (
      !validDate(+zoned[1], +zoned[2], +zoned[3]) ||
      !validTime(+zoned[4], +zoned[5], +(zoned[6] ?? 0))
    ) {
      return none;
    }
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return none;
    const at = new Date(ms);
    return { date_at: at.toISOString(), date_day: tashkentDateKey(at) };
  }
  let y: number, mo: number, d: number, rest: string;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const dmy = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(text);
  if (iso) {
    [y, mo, d] = [+iso[1], +iso[2], +iso[3]];
    rest = text.slice(iso.index + iso[0].length);
  } else if (dmy) {
    [d, mo, y] = [+dmy[1], +dmy[2], +dmy[3]];
    rest = text.slice(dmy.index + dmy[0].length);
  } else {
    return none;
  }
  if (!validDate(y, mo, d)) return none;
  const day = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const time = /^[ T,]*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(rest);
  if (!time) return { date_at: null, date_day: day };
  const [hh, mi, ss] = [+time[1], +time[2], +(time[3] ?? 0)];
  if (!validTime(hh, mi, ss)) return { date_at: null, date_day: day };
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = new Date(`${day}T${pad(hh)}:${pad(mi)}:${pad(ss)}.000+05:00`);
  return { date_at: at.toISOString(), date_day: day };
}

/**
 * R7 kursori ikki manba (karta, chek) bo'yicha, har biri o'z LIMIT'i bilan:
 * qaysidir manba LIMIT'ga yetsa (qolgan qatorlar bor) — kursor o'sha
 * manbaning oxirgi ko'rilgan qiymatidan oshmaydi (review S8). Aks holda —
 * eng katta ko'rilgan qiymat; hech narsa ko'rilmasa — null (dvigatel `now`).
 */
export function r7Cursor(
  sources: Array<Array<{ seen_at: Date }>>,
): string | null {
  const last = (rows: Array<{ seen_at: Date }>) =>
    new Date(rows[rows.length - 1].seen_at).getTime();
  const truncated = sources
    .filter((rows) => rows.length >= R7_MAX_ROWS)
    .map(last);
  if (truncated.length) return new Date(Math.min(...truncated)).toISOString();
  const seen = sources.filter((rows) => rows.length).map(last);
  return seen.length ? new Date(Math.max(...seen)).toISOString() : null;
}

function validDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

function validTime(h: number, m: number, s: number): boolean {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59;
}

/** Chek valyutasi so'm emasmi (#643 semantikasi va undan oldingi qatorlar ham). */
export function isForeignReceipt(
  currency: string | null,
  errorReason: string | null,
): boolean {
  if (errorReason === 'currency_not_uzs') return true;
  const c = (currency ?? '')
    .trim()
    .toUpperCase()
    .replace(/[ʻ‘’`]/g, "'");
  return c !== '' && !R7_UZS_SYNONYMS.has(c);
}

/**
 * So'm yozuvlari — `cashbox-receipt/receipt.rules.ts` UZS_SYNONYMS bilan
 * BIR XIL (#643; round-3 N2 tozalash). O'zgarsa — ikkalasi birga.
 */
const R7_UZS_SYNONYMS: ReadonlySet<string> = new Set([
  'UZS',
  'UZB',
  'SUM',
  'SOM',
  "SO'M",
  'СУМ',
  'СЎМ',
]);

interface R3Row {
  id: string;
  amount: string;
  createdAt: Date;
  cashbox_id: string;
  cashbox_type: string;
  owner: string;
  category_id: string;
  category_name: string | null;
  created_by: string | null;
  scope: 'category_branch' | 'category';
  sample_size: number;
  median: number;
  mad: number;
  threshold: string;
}

@Injectable()
export class AdvisorInputsService {
  private readonly logger = new Logger(AdvisorInputsService.name);
  /** Ism qidiruvi umumiy chegarasi (testlarda qisqartiriladi). */
  namesDeadlineMs = ADVISOR_NAMES_DEADLINE_MS;
  /** Har SQL ifoda chegarasi (testlarda qisqartiriladi). */
  statementTimeoutMs = ADVISOR_STATEMENT_TIMEOUT_MS;
  /** Qoidalar SQL byudjeti (testlarda qisqartiriladi). */
  rulesBudgetMs = ADVISOR_RULES_BUDGET_MS;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly daily: FinanceDailyService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Optional() @Inject('BRANCH') private readonly branchClient?: ClientProxy,
    @Optional() private readonly receiptService?: CashboxReceiptService,
  ) {}

  /** Jadval yo'llari entity metadata'sidan (sxema bilan). */
  private tables() {
    const path = (entity: Parameters<DataSource['getMetadata']>[0]) =>
      this.ds
        .getMetadata(entity)
        .tablePath.split('.')
        .map((part) => `"${part.replace(/"/g, '""')}"`)
        .join('.');
    return {
      shifts: path(Shift),
      history: path(CashboxHistory),
      cashboxes: path(Cashbox),
      categories: path(CashboxExpenseCategory),
      daily: path(FinanceCashboxDaily),
      checks: path(ShiftAccountCheck),
      receipts: path(CashboxReceipt),
      cards: path(CashboxCard),
      corrections: path(PaymentCorrection),
    };
  }

  async ruleInputs(
    input: AiAdvisorRuleInputsRequest,
  ): Promise<AiAdvisorRuleInputsResponse> {
    const now = new Date(input?.now ?? Date.now());
    if (Number.isNaN(now.getTime())) throw new Error('now noto‘g‘ri');
    const started = Date.now();
    const deadline = started + this.rulesBudgetMs;
    const rules = new Set(Array.isArray(input?.rules) ? input.rules : []);
    const out: AiAdvisorRuleInputsResponse = { candidates: [], cursors: {} };
    const names = new NameCache(this, () =>
      Math.max(
        0,
        Math.min(
          this.namesDeadlineMs,
          started + ADVISOR_TOTAL_BUDGET_MS - Date.now(),
        ),
      ),
    );
    // Har qoida alohida: biri yiqilsa (timeout) — boshqalari odatdagidek,
    // yiqilgan qoida `errors` da, kursorsiz (round-2 #651 ops-B1).
    const guard = async (rule: AiAdvisorRuleKey, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        (out.errors ??= {})[rule] = short(error);
        this.logger.warn(`advisor.rule_inputs ${rule} xato: ${short(error)}`);
      }
    };

    if (rules.has('R1')) {
      await guard('R1', async () => {
        const t = input.thresholds?.R1 ?? {};
        const since = parseSince(input.since?.R1, now);
        const r = await this.withTimeout(deadline, (q) =>
          this.r1(q, since, now, t, names),
        );
        out.candidates.push(...r.candidates);
        out.cursors.R1 = r.cursor;
      });
    }
    if (rules.has('R3')) {
      await guard('R3', async () => {
        const t = input.thresholds?.R3 ?? {};
        const since = parseSince(input.since?.R3, now);
        const r = await this.withTimeout(deadline, (q) =>
          this.r3(q, since, now, t, names, started + R3_TIME_BUDGET_MS),
        );
        out.candidates.push(...r.candidates);
        out.cursors.R3 = r.cursor;
      });
    }
    const today = tashkentDateKey(now);
    if (rules.has('R2')) {
      await guard('R2', async () => {
        out.candidates.push(
          ...(await this.withTimeout(deadline, (q) =>
            this.r2(q, input.thresholds?.R2 ?? {}, today, names),
          )),
        );
      });
    }
    if (rules.has('R4')) {
      await guard('R4', async () => {
        out.candidates.push(
          ...(await this.withTimeout(deadline, (q) =>
            this.r4(q, input.thresholds?.R4 ?? {}, today, names),
          )),
        );
      });
    }
    if (rules.has('R5')) {
      await guard('R5', async () => {
        out.candidates.push(
          ...(await this.withTimeout(deadline, (q) =>
            this.r5(q, input.thresholds?.R5 ?? {}, today, names),
          )),
        );
      });
    }
    if (rules.has('R7')) {
      await guard('R7', async () => {
        const since = parseSince(input.since?.R7, now);
        const r = await this.withTimeout(deadline, (q) =>
          this.r7(q, since, now, names, deadline),
        );
        out.candidates.push(...r.candidates);
        out.cursors.R7 = r.cursor;
      });
    }
    // R8/R6 (kunlik guruh) o'z so'rovlari bilan — byudjet tugagan bo'lsa
    // boshlanmaydi (kursorsiz `errors`).
    const budgetLeft = () => {
      if (deadline - Date.now() < 250)
        throw new Error('advisor budget exhausted');
    };
    if (rules.has('R8')) {
      await guard('R8', async () => {
        budgetLeft();
        out.candidates.push(
          ...(await this.withTimeout(deadline, (q) =>
            this.r8(
              q,
              input.thresholds?.R8 ?? {},
              (input.periods?.weeks ?? []).slice(-AI_ADVISOR_INPUT_MAX_PERIODS),
              now,
            ),
          )),
        );
      });
    }
    if (rules.has('R6')) {
      await guard('R6', async () => {
        budgetLeft();
        out.candidates.push(...(await this.r6(input.periods ?? {}, now)));
      });
    }
    await names.fill(out.candidates);
    // P6 (v0.4): ism qidiruvi yiqilgan — dvigatel saqlangan nom/filial/
    // sarlavhani yangilamaydi (null bilan almashtirmaydi).
    if (names.degraded) out.names_degraded = true;
    return out;
  }

  /**
   * O'qish so'rovlari alohida ulanishda, `statement_timeout` bilan (SET
   * LOCAL — faqat shu tranzaksiya). Hech narsa yozilmaydi.
   */
  private async withTimeout<T>(
    deadline: number,
    fn: (q: SqlQuery, manager: EntityManager) => Promise<T>,
    /**
     * `manager` orqali (q dan tashqari) KETMA-KET yuboriladigan ifodalar
     * soni: ular uchun chegara qayta qo'yilmaydi, shuning uchun boshlang'ich
     * chegara qolgan byudjetning 1/N qismi (jami ≤ qolgan byudjet).
     */
    managerStatements = 1,
  ): Promise<T> {
    if (deadline - Date.now() < 250)
      throw new Error('advisor budget exhausted');
    const runner: QueryRunner = this.ds.createQueryRunner();
    await runner.connect();
    try {
      // Pool kutish vaqti ham hisobga olinadi — qolgan byudjet ulanishdan keyin.
      const remaining = deadline - Date.now();
      if (remaining < 250) throw new Error('advisor budget exhausted');
      await runner.startTransaction();
      // statement_timeout har IFODAGA (#704 review B1): qoida ichidagi har
      // so'rov oldidan qolgan byudjet bilan qayta qo'yiladi — ko'p ifodali
      // qoida (R3: chunk + har anomaliya uchun r3Sample) chegaradan oshmaydi.
      let applied = Math.floor(
        Math.min(this.statementTimeoutMs, remaining / managerStatements),
      );
      await runner.query(`SET LOCAL statement_timeout = ${applied}`);
      await runner.query(`SET LOCAL lock_timeout = '${ADVISOR_LOCK_TIMEOUT}'`);
      const result = await fn(async <R>(sql: string, params?: unknown[]) => {
        const left = deadline - Date.now();
        if (left < 250) throw new Error('advisor budget exhausted');
        const next = Math.floor(Math.min(this.statementTimeoutMs, left));
        if (next < applied) {
          await runner.query(`SET LOCAL statement_timeout = ${next}`);
          applied = next;
        }
        return runner.query(sql, params) as Promise<R>;
      }, runner.manager);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive)
        await runner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
  }

  // ─── R1 Smena kamomadi (§4.2) ─────────────────────────────────────────

  private async r1(
    q: SqlQuery,
    since: Date,
    now: Date,
    t: Record<string, number>,
    names: NameCache,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const shortage = positive(t.shortage_uzs, 50_000);
    const streakLen = Math.max(
      2,
      Math.floor(positive(t.consecutive_negative, 3)),
    );
    const columns = `s."id"::text AS id,
             COALESCE(s."cashbox_user_id", 0)::text AS owner,
             s."closed_at", s."closed_by"::text AS closed_by, s."closed_by_system",
             s."expected_balance_cash", s."expected_balance_card",
             s."discrepancy_cash", s."discrepancy_card",
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) AS difference,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < -($1::numeric) AS is_short,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < 0 AS is_negative`;
    // Mos smena: yopilgan, kamida bitta qismi sanalgan (avtomatik yopilgan —
    // ikkalasi NULL — o'tkaziladi, ketma-ketlikni na uzaytiradi, na uzadi).
    const eligible = (
      a: string,
    ) => `${a}."status" = 'closed' AND ${a}."is_deleted" = false
        AND (${a}."discrepancy_cash" IS NOT NULL OR ${a}."discrepancy_card" IS NOT NULL)`;
    const fresh = await q<ShiftRow[]>(
      `SELECT ${columns} FROM ${this.tables().shifts} s
        WHERE ${eligible('s')} AND s."closed_at" >= $2 AND s."closed_at" <= $3
        ORDER BY s."closed_at" ASC, s."id" ASC
        LIMIT ${R1_MAX_NEW_SHIFTS}`,
      [shortage, since, now],
    );
    if (!fresh.length) return { candidates: [], cursor: null };
    const cursor = iso(fresh[fresh.length - 1].closed_at);
    warnIfStalled(
      this.logger,
      'R1',
      fresh.length,
      R1_MAX_NEW_SHIFTS,
      fresh[0].closed_at,
      cursor,
    );
    const owners = [...new Set(fresh.map((r) => r.owner))];
    // Har kassa uchun birinchi yangi smenadan OLDINGI mos smenalar (≤ 50):
    // ketma-ketlik oynasi har YANGI smenada tugaydigan qilib tekshiriladi
    // (orqa oynada tugagan ketma-ketlik ham — round-2 #651 S1), uzunligi
    // esa butun uzluksiz manfiy qator bo'yicha.
    const prior = await q<ShiftRow[]>(
      `SELECT p.* FROM unnest($2::text[]) AS o(owner)
         CROSS JOIN LATERAL (
           SELECT ${columns} FROM ${this.tables().shifts} s
            WHERE ${eligible('s')} AND COALESCE(s."cashbox_user_id", 0) = o.owner::bigint
              AND (s."closed_at", s."id") < (
                SELECT f."closed_at", f."id" FROM ${this.tables().shifts} f
                 WHERE ${eligible('f')} AND COALESCE(f."cashbox_user_id", 0) = o.owner::bigint
                   AND f."closed_at" >= $3 AND f."closed_at" <= $4
                 ORDER BY f."closed_at" ASC, f."id" ASC LIMIT 1)
            ORDER BY s."closed_at" DESC, s."id" DESC
            LIMIT ${R1_STREAK_LOOKBACK}
         ) p`,
      [shortage, owners, since, now],
    );
    const types = await this.cashboxTypes(q, owners);

    const candidates: AiAdvisorCandidate[] = [];
    for (const owner of owners) {
      const freshRows = fresh.filter((r) => r.owner === owner);
      const freshIds = new Set(freshRows.map((r) => r.id));
      const series = [...prior.filter((r) => r.owner === owner), ...freshRows]
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
        .sort(byClosedAt);
      const byId = new Map<string, ShiftRow>();
      for (const r of freshRows) if (r.is_short) byId.set(r.id, r);
      // Oxirgi N ta mos smena hammasi manfiy bo'lgan har oyna, oxiri YANGI
      // smena bo'lsa — oynadagi N smena fakt.
      let lastStreakEnd = -1;
      for (let i = streakLen - 1; i < series.length; i++) {
        if (!freshIds.has(series[i].id)) continue;
        const window = series.slice(i - streakLen + 1, i + 1);
        if (!window.every((r) => r.is_negative)) continue;
        for (const r of window) byId.set(r.id, r);
        lastStreakEnd = i;
      }
      if (!byId.size) continue;
      const shifts = [...byId.values()].sort(byClosedAt);
      const last = shifts[shifts.length - 1];
      const total = money(
        shifts.reduce((sum, r) => sum + Number(r.difference), 0),
      );
      const lastDiff = money(last.difference);
      // trigger — OXIRGI fakt-smenani chaqirgan shart (§4.2).
      const streak = lastStreakEnd >= 0 && series[lastStreakEnd].id === last.id;
      const trigger = streak ? 'consecutive_negative' : 'single_shortage';
      // Ketma-ketlik uzunligi/jami — oxirgi oynani o'z ichiga olgan butun
      // uzluksiz manfiy qator (sarlavha «N smena ketma-ket», round-2 B1).
      let streakFrom = lastStreakEnd;
      if (streak) {
        while (streakFrom > 0 && series[streakFrom - 1].is_negative)
          streakFrom -= 1;
      }
      const run = streak ? series.slice(streakFrom, lastStreakEnd + 1) : [];
      const cashbox = cashboxRef(owner, types.get(owner));
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: owner, name: null } : null;
      const closedBy = [
        ...new Set(
          [...shifts]
            .reverse()
            .map((r) => r.closed_by)
            .filter(isId),
        ),
      ].slice(0, 5);
      for (const id of closedBy) names.wantUser(id);
      if (branch) names.wantBranch(branch.id);
      candidates.push({
        rule_key: 'R1',
        dedup_key: `R1:cashbox:${owner}`,
        fact_keys: shifts.map((r) => ({
          fact_key: r.id,
          fact_at: iso(r.closed_at),
          amount: money(r.difference),
        })),
        branch,
        subject: { kind: 'cashbox', id: owner, name: null },
        headline_amount: trigger === 'single_shortage' ? lastDiff : total,
        facts: {
          trigger,
          cashbox,
          branch,
          shifts_count: shifts.length,
          total_difference: total,
          last_difference: lastDiff,
          closed_by: closedBy.map((id) => ({ id, name: null })),
          last_shift_id: last.id,
          streak_length: streak ? run.length : null,
          streak_total: streak
            ? money(run.reduce((sum, r) => sum + Number(r.difference), 0))
            : null,
        },
        evidence: {
          kind: 'shifts',
          total_rows: shifts.length,
          truncated: shifts.length > ADVISOR_EVIDENCE_LIMIT,
          rows: shifts.slice(-ADVISOR_EVIDENCE_LIMIT).map(shiftEvidenceRow),
          totals: { count: shifts.length, difference: total },
        },
      });
    }
    return { candidates, cursor };
  }

  // ─── R3 G'ayrioddiy xarajat (§4.2, BQ9, Q18, Q24) ─────────────────────

  private async r3(
    q: SqlQuery,
    since: Date,
    now: Date,
    t: Record<string, number>,
    names: NameCache,
    deadline: number,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const k = positive(t.mad_multiplier, 3);
    const fresh = await q<Array<{ id: string; createdAt: Date }>>(
      `SELECT h."id"::text AS id, h."createdAt"
         FROM ${this.tables().history} h
        WHERE h."source_type" = 'manual_expense' AND h."operation_type" = 'expense'
          AND h."is_deleted" = false AND h."expense_category_id" IS NOT NULL
          AND h."createdAt" >= $1 AND h."createdAt" <= $2
        ORDER BY h."createdAt" ASC, h."id" ASC
        LIMIT ${R3_MAX_NEW_ROWS}`,
      [since, now],
    );
    if (!fresh.length) return { candidates: [], cursor: null };
    warnIfStalled(
      this.logger,
      'R3',
      fresh.length,
      R3_MAX_NEW_ROWS,
      fresh[0].createdAt,
      iso(fresh[fresh.length - 1].createdAt),
    );
    // Har yangi qator uchun oldingi 30 kun statistikasi (joriy qatorsiz):
    // avval shu kassa + kategoriya, namuna < 5 bo'lsa butun tizim + kategoriya.
    // Oyna — qator vaqtidan 30×24 soat orqaga (sirpanuvchi; Toshkent kun
    // chegarasi emas). Mediana/MAD `percentile_cont` (float8) → 2 xonaga
    // yaxlitlanadi, chegara solishtiruvi numeric'da (so'm aniqligi yetarli).
    const window = (scopeCashbox: boolean) => `
      SELECT ABS(w."amount") AS a FROM ${this.tables().history} w
       WHERE w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
         AND w."is_deleted" = false AND w."expense_category_id" = h."expense_category_id"
         ${scopeCashbox ? 'AND w."cashbox_id" = h."cashbox_id"' : ''}
         AND w."id" <> h."id"
         AND w."createdAt" >= h."createdAt" - INTERVAL '${R3_WINDOW_DAYS} days'
         AND w."createdAt" < h."createdAt"`;
    // `gate` — butun tizim statistikasi FAQAT kassa namunasi < 5 bo'lsa
    // hisoblanadi (aks holda skan yo'q — round-2 #651 ops-B1).
    const stats = (alias: string, scopeCashbox: boolean, gate = '') => `
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY a)::numeric, 2) AS med
          FROM (${window(scopeCashbox)}) x ${gate ? `WHERE ${gate}` : ''}
      ) ${alias} ON true
      LEFT JOIN LATERAL (
        SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(a - ${alias}.med))::numeric, 2) AS mad
          FROM (${window(scopeCashbox)}) x ${gate ? `WHERE ${gate}` : ''}
      ) ${alias}m ON true`;
    const sql = `SELECT * FROM (
         SELECT h."id"::text AS id, ABS(h."amount") AS amount, h."createdAt",
                h."cashbox_id"::text AS cashbox_id, c."cashbox_type"::text AS cashbox_type,
                COALESCE(c."user_id", 0)::text AS owner,
                h."expense_category_id"::text AS category_id,
                COALESCE(cat."name", h."expense_category_name") AS category_name,
                h."created_by"::text AS created_by,
                CASE WHEN sb.n >= $3 THEN 'category_branch' ELSE 'category' END AS scope,
                CASE WHEN sb.n >= $3 THEN sb.n ELSE sc.n END AS sample_size,
                CASE WHEN sb.n >= $3 THEN sb.med ELSE sc.med END AS median,
                CASE WHEN sb.n >= $3 THEN sbm.mad ELSE scm.mad END AS mad
           FROM ${this.tables().history} h
           JOIN ${this.tables().cashboxes} c ON c."id" = h."cashbox_id"
           LEFT JOIN ${this.tables().categories} cat ON cat."id" = h."expense_category_id"
           ${stats('sb', true)}
           ${stats('sc', false, 'sb.n < $3')}
          WHERE h."id" = ANY($1::bigint[])
       ) r,
       LATERAL (
         SELECT (r.median + $2::numeric * GREATEST(r.mad, ROUND(r.median * $4::numeric, 2)))::numeric(20,2) AS threshold
       ) th
       WHERE r.sample_size >= $3 AND r.amount > th.threshold
       ORDER BY r."createdAt" ASC, r.id ASC`;
    // Bo'laklarda: vaqt byudjeti tugasa — ishlangan qismgacha kursor
    // (keyingi tick davom ettiradi; bir xil oyna qayta-qayta o'qilmaydi).
    const rows: R3Row[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < fresh.length; i += R3_CHUNK) {
      const chunk = fresh.slice(i, i + R3_CHUNK);
      rows.push(
        ...(await q<R3Row[]>(sql, [
          chunk.map((r) => r.id),
          k,
          R3_MIN_SAMPLE,
          R3_MIN_MAD_RATIO,
        ])),
      );
      cursor = iso(chunk[chunk.length - 1].createdAt);
      if (Date.now() > deadline && i + R3_CHUNK < fresh.length) {
        this.logger.warn(
          `advisor R3: vaqt byudjeti tugadi — ${i + chunk.length}/${fresh.length} qator, kursor ${cursor}`,
        );
        break;
      }
    }

    const candidates: AiAdvisorCandidate[] = [];
    for (const row of rows) {
      const cashbox = cashboxRef(row.owner, row.cashbox_type);
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: row.owner, name: null } : null;
      if (branch) names.wantBranch(branch.id);
      if (isId(row.created_by)) names.wantUser(row.created_by);
      const amount = money(row.amount);
      const median = money(row.median);
      const mad = money(row.mad);
      const threshold = money(row.threshold);
      const sample = await this.r3Sample(q, row);
      for (const r of sample.rows) names.wantCashbox(r.cashbox);
      candidates.push({
        rule_key: 'R3',
        dedup_key: `R3:history:${row.id}`,
        fact_keys: [{ fact_key: row.id, fact_at: iso(row.createdAt) }],
        branch,
        subject: { kind: 'cashbox', id: row.owner, name: null },
        headline_amount: amount,
        facts: {
          history_id: row.id,
          amount,
          category: { id: row.category_id, name: row.category_name ?? null },
          cashbox,
          branch,
          created_by: isId(row.created_by)
            ? { id: row.created_by, name: null }
            : null,
          created_at: iso(row.createdAt),
          median,
          mad,
          threshold,
          ratio_to_median:
            median > 0 ? Math.round((amount / median) * 10) / 10 : null,
          sample_size: Number(row.sample_size),
          window_days: R3_WINDOW_DAYS,
          scope: row.scope,
        },
        evidence: {
          kind: 'expense_stats',
          stats: {
            window_days: R3_WINDOW_DAYS,
            sample_size: Number(row.sample_size),
            median,
            mad,
            multiplier: k,
            threshold,
            scope: row.scope,
          },
          total_rows: sample.total + 1,
          truncated: sample.total + 1 > ADVISOR_EVIDENCE_LIMIT,
          rows: [
            {
              history_id: row.id,
              created_at: iso(row.createdAt),
              amount,
              cashbox_name: null,
              created_by: isId(row.created_by)
                ? { id: row.created_by, name: null }
                : null,
              is_trigger: true,
              href: null,
              cashbox,
            },
            ...sample.rows,
          ],
        },
      });
      for (const r of sample.rows) {
        const by = r.created_by as AiAdvisorRef | null;
        if (by) names.wantUser(by.id);
      }
    }
    return { candidates, cursor };
  }

  /**
   * R3 dalili: statistika oynasidagi eng katta 14 qator. Har qator O'Z
   * kassasi bilan (`cashbox` — ai-service `href` va nom uchun; REST'ga
   * chiqishidan oldin olib tashlanadi; round-2 #651 S2).
   */
  private async r3Sample(
    q: SqlQuery,
    row: R3Row,
  ): Promise<{
    total: number;
    rows: Array<Record<string, unknown> & { cashbox: AiAdvisorCashboxRef }>;
  }> {
    const scopeCashbox = row.scope === 'category_branch';
    const params = [
      row.category_id,
      row.createdAt,
      row.id,
      ...(scopeCashbox ? [row.cashbox_id] : []),
    ];
    const where = `w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
         AND w."is_deleted" = false AND w."expense_category_id" = $1
         AND w."id" <> $3 AND w."createdAt" >= $2::timestamptz - INTERVAL '${R3_WINDOW_DAYS} days'
         AND w."createdAt" < $2::timestamptz
         ${scopeCashbox ? 'AND w."cashbox_id" = $4' : ''}`;
    const list = await q<
      Array<{
        id: string;
        createdAt: Date;
        amount: string;
        created_by: string | null;
        owner: string | null;
        cashbox_type: string | null;
        total: string;
      }>
    >(
      `SELECT w."id"::text AS id, w."createdAt", ABS(w."amount") AS amount,
              w."created_by"::text AS created_by, COALESCE(c."user_id", 0)::text AS owner,
              c."cashbox_type"::text AS cashbox_type, COUNT(*) OVER () AS total
         FROM ${this.tables().history} w
         LEFT JOIN ${this.tables().cashboxes} c ON c."id" = w."cashbox_id"
        WHERE ${where}
        ORDER BY ABS(w."amount") DESC, w."id" DESC
        LIMIT ${ADVISOR_EVIDENCE_LIMIT - 1}`,
      params,
    );
    return {
      total: list.length ? Number(list[0].total) : 0,
      rows: list.map((r) => ({
        history_id: r.id,
        created_at: iso(r.createdAt),
        amount: money(r.amount),
        cashbox_name: null,
        created_by: isId(r.created_by)
          ? { id: r.created_by, name: null }
          : null,
        is_trigger: false,
        href: null,
        cashbox: cashboxRef(r.owner ?? '0', r.cashbox_type ?? undefined),
      })),
    };
  }

  // ─── R6 Zarar (§4.2): yopilgan kun / hafta ────────────────────────────

  private async r6(
    periods: NonNullable<AiAdvisorRuleInputsRequest['periods']>,
    now: Date,
  ): Promise<AiAdvisorCandidate[]> {
    const today = tashkentDateKey(now);
    // Faqat yopilgan davrlar, ≤ 14 tadan (round-2 #651 S10).
    const days = [...new Set(periods.days ?? [])]
      .filter((d) => isDay(d) && d < today)
      .slice(-AI_ADVISOR_INPUT_MAX_PERIODS);
    const weeks = [...new Set(periods.weeks ?? [])]
      .filter((d) => isDay(d) && addDaysKey(d, 6) < today)
      .slice(-AI_ADVISOR_INPUT_MAX_PERIODS);
    const candidates: AiAdvisorCandidate[] = [];
    const load = async (from: string, to: string) => {
      const res = (await this.daily.financialBalanceDaily({
        from_date: from,
        to_date: to,
      })) as {
        data?: {
          days?: Array<{
            date: string;
            ledger: { income: number; expense: number; net: number };
          }>;
        };
      };
      return (res?.data?.days ?? []).map((d) => ({
        date: d.date,
        income: money(d.ledger?.income),
        expense: money(d.ledger?.expense),
        net: money(d.ledger?.net),
      }));
    };
    const build = (
      period: 'day' | 'week',
      from: string,
      to: string,
      rows: Array<{
        date: string;
        income: number;
        expense: number;
        net: number;
      }>,
    ): AiAdvisorCandidate | null => {
      const income = money(rows.reduce((s, r) => s + r.income, 0));
      const expense = money(rows.reduce((s, r) => s + r.expense, 0));
      const net = money(income - expense);
      if (!(net < 0)) return null;
      const key = period === 'day' ? `R6:day:${from}` : `R6:week:${from}`;
      // §5.1: R6 — first_fact_at = davr boshi, last_fact_at = davr oxiri.
      const factAt = new Date(`${to}T23:59:59.999+05:00`).toISOString();
      return {
        rule_key: 'R6',
        dedup_key: key,
        fact_keys: [{ fact_key: key, fact_at: factAt }],
        first_fact_at: new Date(`${from}T00:00:00.000+05:00`).toISOString(),
        branch: null,
        subject: {
          kind: 'system',
          id: null,
          name: AI_ADVISOR_SYSTEM_SUBJECT_NAME,
        },
        headline_amount: net,
        facts: { period, from, to, income, expense, net },
        evidence: {
          kind: 'profit_days',
          total_rows: rows.length,
          truncated: false,
          rows: rows.map((r) => ({ ...r, is_trigger: r.net < 0 })),
          totals: { income, expense, net },
        },
      };
    };
    for (const day of days) {
      const c = build('day', day, day, await load(day, day));
      if (c) candidates.push(c);
    }
    for (const monday of weeks) {
      const sunday = addDaysKey(monday, 6);
      const c = build('week', monday, sunday, await load(monday, sunday));
      if (c) candidates.push(c);
    }
    return candidates;
  }

  // ─── R2/R4/R5 holat qoidalari: epizod (§4.1, §4.2, BE-rev B5) ─────────

  /**
   * Kassa turi bo'yicha joriy holat va epizod chegaralari (v0.4):
   * - `lh` — oxirgi chiqish (T6 qaytarilmagan) — dalil;
   * - `qh` — oxirgi «hisoblanadigan» topshirish kuni: shu kundagi chiqishlar
   *   yig'indisi × 100 ≥ `minPct` × kun boshidagi qoldiq (R4 — `minPct` 0);
   *   kalit — o'sha kunning oxirgi chiqishi;
   * - `zr`/`rs` — joriy musbat qatorning boshi (oxirgi `balance_after <= 0`
   *   dan keyingi birinchi qator; bo'lmasa — birinchi qator);
   * - `rv` — `qh` dan keyin qilingan, o'zi hisoblanadigan bo'lgan va T6
   *   bilan qaytarilgan topshirish (qaytarish lahzasi — chegara, P4).
   */
  private async episodes(
    q: SqlQuery,
    type: 'couriers' | 'markets' | 'branch',
    source: 'courier_payment' | 'market_payment' | 'branch_to_main',
    minBalance: number,
    minPct: number,
    today: string,
  ): Promise<EpisodeRow[]> {
    const t = this.tables();
    // P5 (v0.4): T6 tahririning almashtiruvchi oyog'i — vaqti va id'si
    // zanjirning BIRINCHI (root) oyog'idan (ayni kassa): tahrir «oxirgi
    // topshirish»ni oldinga surmaydi, kunlar sanog'ini nolga tushirmaydi.
    const effective = (a: string) => this.effectiveJoin(a);
    const day = (at: string) => `(${at} AT TIME ZONE 'Asia/Tashkent')::date`;
    // Toshkent kuni boshi (timestamptz): `day(at) = d` ⇔ `dayStart(d) <= at < dayStart(d + 1)`.
    const dayStart = (d: string) =>
      `((${d})::timestamp AT TIME ZONE 'Asia/Tashkent')`;
    // Oyna: [today − N kun] dan (bir kun oldingi qatorlar — kun boshi qoldig'i uchun).
    const since = dayStart('$5::date');
    // `lh` uchun «amaldagi chiqish oyog'i»: turi va manbasi mos, T6 bilan
    // qaytarilmagan (qaytarish ham, tahrir ham asl oyoqni chiqaradi).
    // `fence` (2-qadam): `OFFSET 0` — NOT EXISTS anti-join'ga aylantirilmaydi,
    // har nomzod uchun UQ_CASHBOX_HISTORY_REVERSES bo'yicha bitta qadam: aks
    // holda rejalashtiruvchi qisqa nomzodlar ro'yxatiga Merge Anti Join
    // tanlab, har kassa uchun BUTUN qaytarish indeksini o'qiydi (kassalar ×
    // qaytarishlar). 1-qadamda (LIMIT 1, indeks tartibida) fence'siz: SubPlan
    // narxi har o'qiladigan qatorga qo'shilib, rejalashtiruvchi tartibli
    // skan o'rniga IDX_CASHBOX_HISTORY_OP_TYPE/SOURCE BitmapAnd tanlaydi.
    const liveLeg = (a: string, fence = false) => `${a}."cashbox_id" = cb."id"
              AND ${a}."operation_type" = 'expense'
              AND ${a}."source_type" = $2 AND ${a}."is_deleted" = false
              AND NOT EXISTS (
                SELECT 1 FROM ${t.history} rr
                 WHERE rr."source_type" = 'payment_reversal'
                   AND rr."reverses_history_id" = ${a}."id" AND rr."is_deleted" = false
                ${fence ? 'OFFSET 0' : ''})`;
    // #702 review B1: kun boshidagi qoldiq oynadan, qaytarish/qh kunlik
    // agregatdan. #702 perf: kun boshi — faqat chiqishli kunlar uchun ikki
    // indeks qadami (IDX_CASHBOX_HISTORY_CASHBOX_CREATED), oynaning barcha
    // qatorlari bo'yicha LAG o'tishi emas.
    // JIT o'chiq: rejalashtiruvchi lateral'lar narxini katta baholab JIT
    // kompilyatsiyasiga (~1.4 s) kiradi, so'rovning o'zi ~0.5 s (#702 B1).
    // withTimeout tranzaksiyasi ichida (SET LOCAL).
    await q('SET LOCAL jit = off');
    return q<EpisodeRow[]>(
      `WITH cb AS (
         SELECT c."id", c."user_id", c."balance" FROM ${t.cashboxes} c
          WHERE c."cashbox_type" = $1 AND c."is_deleted" = false
            AND c."balance" > $3::numeric
       ),
       -- Chiqish oyoqlari: samarali vaqt/id (P5) va T6 qaytarilishi (turi bilan).
       legs AS (
         SELECT o."cashbox_id", o."id", COALESCE(oe.rid, o."id") AS kid,
                COALESCE(oe.rat, o."createdAt") AS at, ABS(o."amount") AS amount,
                rv.rid, rv.rat, rv.kind
           FROM ${t.history} o JOIN cb ON cb."id" = o."cashbox_id"
           ${effective('o')}
           LEFT JOIN LATERAL (
             SELECT r."id" AS rid, r."createdAt" AS rat,
                    CASE WHEN EXISTS (
                      SELECT 1 FROM ${t.corrections} pe
                       WHERE pe."reversal_transfer_id" = r."transfer_id"
                         AND pe."action" = 'edit' AND pe."is_deleted" = false)
                    THEN 'edit' ELSE 'reverse' END AS kind
               FROM ${t.history} r
              WHERE r."reverses_history_id" = o."id"
                AND r."source_type" = 'payment_reversal' AND r."is_deleted" = false
              ORDER BY r."createdAt" DESC, r."id" DESC LIMIT 1
           ) rv ON true
          WHERE o."operation_type" = 'expense' AND o."source_type" = $2
            AND o."is_deleted" = false AND o."createdAt" >= ${since}
       ),
       -- Kun yig'indilari: \`live\` — amaldagi oyoqlar; \`with_rev\` — T6
       -- «qaytarish» bilan bekor qilinganlari ham (tahrir — almashtiruvchi
       -- oyoq allaqachon \`live\` da, root kunida).
       days AS (
         SELECT l."cashbox_id" AS cashbox_id, ${day('l.at')} AS day,
                SUM(l.amount) FILTER (WHERE l.rid IS NULL) AS live,
                SUM(l.amount) FILTER (WHERE l.rid IS NULL OR l.kind = 'reverse') AS with_rev,
                MAX(l.at) FILTER (WHERE l.rid IS NULL) AS last_at,
                (array_agg(l.kid::text ORDER BY l.at DESC, l.kid DESC)
                   FILTER (WHERE l.rid IS NULL))[1] AS last_id,
                -- O'z createdAt'i shu kunda bo'lgan oyoq bor (kid = id ⇒ at = createdAt):
                -- kunda oyna qatori bor.
                bool_or(l.kid = l."id") AS own
           FROM legs l GROUP BY 1, 2
       ),
       -- Kun boshidagi qoldiq (oyna ichida): kunning birinchi qatoridan
       -- oldingi qatorning balance_after (\`pv\`); oldingi qator oynada
       -- bo'lmasa — birinchi qatorning (\`fd\`) o'zidan (balance_after ∓ summa);
       -- kunda oyna qatori bo'lmasa — 0. Oyna qatorlari (createdAt, id)
       -- tartibida, kun — Toshkent bo'yicha. \`fd\` faqat kerak bo'lganda.
       -- $4 = 0 (R4): \`sb\` hech bir shartga ta'sir qilmaydi (0 × sb) — qadamsiz.
       dq AS (
         SELECT d.*, GREATEST(COALESCE(CASE WHEN d.own OR fd."id" IS NOT NULL THEN
                  COALESCE(pv."balance_after", fd."balance_after"
                    + CASE WHEN fd."operation_type" = 'expense'
                        THEN ABS(fd."amount") ELSE -ABS(fd."amount") END)
                END, 0), 0) AS sb
           FROM days d
           LEFT JOIN LATERAL (
             SELECT x."balance_after" FROM ${t.history} x
              WHERE $4::numeric <> 0
                AND x."cashbox_id" = d.cashbox_id AND x."is_deleted" = false
                AND x."createdAt" >= ${since}
                AND x."createdAt" < ${dayStart('d.day')}
              ORDER BY x."createdAt" DESC, x."id" DESC LIMIT 1
           ) pv ON true
           LEFT JOIN LATERAL (
             SELECT x."id", x."balance_after", x."operation_type", x."amount"
               FROM ${t.history} x
              WHERE $4::numeric <> 0 AND (pv."balance_after" IS NULL OR NOT d.own)
                AND x."cashbox_id" = d.cashbox_id AND x."is_deleted" = false
                AND x."createdAt" >= ${dayStart('d.day')}
                AND x."createdAt" < ${dayStart('d.day + 1')}
              ORDER BY x."createdAt" ASC, x."id" ASC LIMIT 1
           ) fd ON true
          -- Oyna birinchi kunining boshlang'ich qoldig'i oynadan tashqarida.
          WHERE d.day > $5::date
       ),
       qh AS (
         SELECT DISTINCT ON (dq.cashbox_id) dq.cashbox_id, dq.day, dq.last_id, dq.last_at
           FROM dq
          WHERE dq.live IS NOT NULL AND dq.live * 100 >= $4::numeric * dq.sb
          ORDER BY dq.cashbox_id, dq.day DESC
       ),
       -- P4 (#702 review B3): T6 «qaytarish» — chegara faqat qaytarilgan
       -- oyoq kuni oxirgi hisoblanadigan kundan KEYIN va o'sha kun qaytarilgan
       -- oyoqlari bilan birga hisoblanadigan bo'lgan bo'lsa (kun yig'indisi).
       -- Har kun uchun: kun 80% dan PASTGA tushgan BIRINCHI qaytarish
       -- (qolgan = with_rev − shu paytgacha qaytarilganlar).
       rvd AS (
         SELECT DISTINCT ON (x.cashbox_id, x.day) x.cashbox_id, x.rid, x.oid, x.rat
           FROM (
             SELECT l."cashbox_id" AS cashbox_id, dq.day, dq.sb, l.rid, l."id" AS oid, l.rat,
                    dq.with_rev - SUM(l.amount) OVER (
                      PARTITION BY l."cashbox_id", dq.day ORDER BY l.rat, l.rid) AS remaining
               FROM legs l
               JOIN dq ON dq.cashbox_id = l."cashbox_id" AND dq.day = ${day('l.at')}
               LEFT JOIN qh ON qh.cashbox_id = l."cashbox_id"
              WHERE l.kind = 'reverse'
                AND dq.with_rev * 100 >= $4::numeric * dq.sb
                AND (qh.day IS NULL OR dq.day > qh.day)
           ) x
          WHERE x.remaining <= 0 OR x.remaining * 100 < $4::numeric * x.sb
          ORDER BY x.cashbox_id, x.day, x.rat ASC, x.rid ASC
       ),
       rv AS (
         SELECT DISTINCT ON (r.cashbox_id) r.cashbox_id, r.rid::text AS rid,
                r.oid::text AS oid, r.rat
           FROM rvd r ORDER BY r.cashbox_id, r.rat DESC, r.rid DESC
       ),
       -- \`lh\` chegarasi himoyasi: samarali vaqti (root oyog'i) o'z
       -- createdAt'idan KEYIN bo'lgan almashtiruvchi oyoqlar (ilova yaratmaydi:
       -- tahrir root'dan keyin, createdAt — tranzaksiya now(); qo'lda
       -- tuzatilgan ma'lumot uchun). Odatda bo'sh. Tahrirlar soniga chiziqli:
       -- har tahrir uchun IDX_CASHBOX_HISTORY_TRANSFER bo'yicha qadam
       -- (\`OFFSET 0\` — rejalashtiruvchi Merge Join bilan transfer_id'li
       -- BARCHA qatorlarni o'qimasin).
       la AS (
         SELECT a."cashbox_id", MIN(a."createdAt") AS lo
           FROM ${t.corrections} pc
           JOIN LATERAL (
             SELECT x."cashbox_id", x."createdAt", x."source_type" FROM ${t.history} x
              WHERE x."transfer_id" = pc."replacement_transfer_id"
                AND x."operation_type" = 'expense' AND x."source_type" = $2
             OFFSET 0
           ) a ON true
          WHERE pc."replacement_transfer_id" IS NOT NULL AND pc."is_deleted" = false
            AND EXISTS (
              SELECT 1 FROM ${t.history} ro
               WHERE ro."transfer_id" = pc."root_transfer_id"
                 AND ro."cashbox_id" = a."cashbox_id" AND ro."operation_type" = 'expense'
                 AND ro."source_type" = a."source_type" AND ro."createdAt" > a."createdAt"
              OFFSET 0)
          GROUP BY a."cashbox_id"
       )
       SELECT cb."id"::text AS cashbox_id, cb."user_id"::text AS owner, cb."balance",
              lh.id AS last_id, lh.at AS last_at, lh.amount AS last_amount,
              qh.last_id AS qual_id, qh.last_at AS qual_at,
              rs.id AS run_id, rs."createdAt" AS run_at,
              rv.rid AS rev_id, rv.oid AS rev_orig_id, rv.rat AS rev_at
         FROM cb
         -- Oxirgi (T6 qaytarilmagan) chiqish — dalil; butun tarix bo'yicha,
         -- samarali vaqt (P5) tartibida, IKKI chegaralangan qadamda
         -- (IDX_CASHBOX_HISTORY_CASHBOX_CREATED): \`lh0\` — createdAt bo'yicha
         -- oxirgi amaldagi oyoq; \`lh\` — samarali vaqt bo'yicha eng oxirgisi,
         -- faqat createdAt ∈ [lh0 samarali vaqti (yoki \`la\`), lh0.createdAt]
         -- bo'lganlar orasida. Aniq: \`la\` dan tashqari har oyoqda samarali
         -- vaqt <= createdAt, demak createdAt < lh0 samarali vaqti bo'lgan oyoq
         -- lh0 dan oldin turadi; createdAt > lh0.createdAt bo'lgan amaldagi
         -- oyoq yo'q (lh0 ta'rifi). Yuqori chegara rejalashtiruvchiga ham
         -- kerak: bir tomonli oraliqni 1/3 deb baholab, butun
         -- IDX_CASHBOX_HISTORY_OP_TYPE ni har kassa uchun BitmapAnd qilardi.
         LEFT JOIN LATERAL (
           SELECT COALESCE(h0e.rat, h0."createdAt") AS at, h0."createdAt" AS ca
             FROM ${t.history} h0
             ${effective('h0')}
            WHERE ${liveLeg('h0')}
            ORDER BY h0."createdAt" DESC, h0."id" DESC
            LIMIT 1
         ) lh0 ON true
         LEFT JOIN la ON la."cashbox_id" = cb."id"
         LEFT JOIN LATERAL (
           SELECT h."id"::text AS id, COALESCE(he.rat, h."createdAt") AS at,
                  ABS(h."amount") AS amount
             FROM ${t.history} h
             ${effective('h')}
            WHERE ${liveLeg('h', true)}
              AND h."createdAt" >= LEAST(lh0.at, la.lo)
              AND h."createdAt" <= lh0.ca
            ORDER BY COALESCE(he.rat, h."createdAt") DESC, h."id" DESC
            LIMIT 1
         ) lh ON true
         LEFT JOIN qh ON qh.cashbox_id = cb."id"
         LEFT JOIN rv ON rv.cashbox_id = cb."id"
         -- Oxirgi \`balance_after <= 0\` qatori: IDX_CASHBOX_HISTORY_ZERO_BAL
         -- (migratsiya 244, qisman) — hech qachon nolga tushmagan kassada ham
         -- butun tarix o'qilmaydi.
         LEFT JOIN LATERAL (
           SELECT z."createdAt", z."id" FROM ${t.history} z
            WHERE z."cashbox_id" = cb."id" AND z."is_deleted" = false
              AND z."balance_after" <= 0
            ORDER BY z."createdAt" DESC, z."id" DESC LIMIT 1
         ) zr ON true
         -- Bitta qator taqqoslashi (OR emas): IDX_CASHBOX_HISTORY_CASHBOX_CREATED
         -- (migratsiya 243) bo'yicha kassa ichida zr dan keyingi birinchi qator.
         -- OR bilan rejalashtiruvchi "createdAt" indeksini jadval boshidan
         -- o'qib, har kassa uchun cashbox_id bo'yicha filtrlardi (kvadratik).
         LEFT JOIN LATERAL (
           SELECT s."id"::text AS id, s."createdAt" FROM ${t.history} s
            WHERE s."cashbox_id" = cb."id" AND s."is_deleted" = false
              AND (s."createdAt", s."id") >
                  (COALESCE(zr."createdAt", '-infinity'::timestamptz), COALESCE(zr."id", 0))
            ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1
         ) rs ON true
        ORDER BY cb."id"`,
      [
        type,
        source,
        minBalance,
        minPct,
        addDaysKey(today, -ADVISOR_EPISODE_LOOKBACK_DAYS - 1),
      ],
    );
  }

  /**
   * P5 (v0.4): T6 tahririning almashtiruvchi oyog'i uchun samarali vaqt/id —
   * zanjirning BIRINCHI (root) oyog'idan (ayni kassa). Natija: `<a>e.rid`,
   * `<a>e.rat` (tahrir bo'lmasa — NULL).
   */
  private effectiveJoin(a: string): string {
    const t = this.tables();
    return `LEFT JOIN LATERAL (
                SELECT ro."id" AS rid, ro."createdAt" AS rat
                  FROM ${t.corrections} pc
                  JOIN ${t.history} ro ON ro."transfer_id" = pc."root_transfer_id"
                   AND ro."cashbox_id" = ${a}."cashbox_id" AND ro."operation_type" = 'expense'
                   AND ro."source_type" = ${a}."source_type"
                 WHERE ${a}."transfer_id" IS NOT NULL
                   AND pc."replacement_transfer_id" = ${a}."transfer_id"
                   AND pc."is_deleted" = false
                 ORDER BY ro."createdAt" ASC, ro."id" ASC LIMIT 1
              ) ${a}e ON true`;
  }

  /** Kassa kunlik yopilishlari (`finance_cashbox_daily`) — oxirgi kunlar. */
  private async dailyClosings(
    q: SqlQuery,
    cashboxIds: string[],
    fromDay: string,
    toDay: string,
  ): Promise<
    Map<
      string,
      Array<{ date: string; opening: number; income: number; closing: number }>
    >
  > {
    const out = new Map<
      string,
      Array<{ date: string; opening: number; income: number; closing: number }>
    >();
    if (!cashboxIds.length) return out;
    const rows = await q<
      Array<{
        cashbox_id: string;
        date: string;
        opening_balance: string;
        income: string;
        closing_balance: string;
      }>
    >(
      `SELECT "cashbox_id"::text AS cashbox_id, to_char("snapshot_date", 'YYYY-MM-DD') AS date,
              "opening_balance", "income", "closing_balance"
         FROM ${this.tables().daily}
        WHERE "cashbox_id" = ANY($1::bigint[]) AND "snapshot_date" BETWEEN $2::date AND $3::date
          AND "is_deleted" = false
        ORDER BY "cashbox_id", "snapshot_date"`,
      [cashboxIds, fromDay, toDay],
    );
    for (const r of rows) {
      const list = out.get(r.cashbox_id) ?? [];
      list.push({
        date: r.date,
        opening: money(r.opening_balance),
        income: money(r.income),
        closing: money(r.closing_balance),
      });
      out.set(r.cashbox_id, list);
    }
    return out;
  }

  /**
   * P1 (#702 review B2): kechagacha tugaydigan qat'iy o'suvchi kunlik
   * yopilishlar qatorining BOSHI — butun tarix bo'yicha (gaps-and-islands),
   * 15 kunlik dalil oynasi bilan cheklanmaydi (aks holda uzun o'sishda
   * `ep:g:<kun>` har kuni bir kun oldinga siljirdi).
   */
  private async growthRunStarts(
    q: SqlQuery,
    cashboxIds: string[],
    yesterday: string,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!cashboxIds.length) return out;
    const rows = await q<Array<{ cashbox_id: string; start: string | null }>>(
      `SELECT x.cashbox_id::text AS cashbox_id,
              to_char(MAX(x.snapshot_date) FILTER (WHERE x.brk), 'YYYY-MM-DD') AS start
         FROM (
           SELECT d."cashbox_id", d."snapshot_date",
                  NOT COALESCE(
                    LAG(d."snapshot_date") OVER w = d."snapshot_date" - 1
                      AND d."closing_balance" > LAG(d."closing_balance") OVER w,
                    false) AS brk
             FROM ${this.tables().daily} d
            WHERE d."cashbox_id" = ANY($1::bigint[]) AND d."snapshot_date" <= $2::date
              AND d."is_deleted" = false
           WINDOW w AS (PARTITION BY d."cashbox_id" ORDER BY d."snapshot_date")
         ) x
        GROUP BY x.cashbox_id`,
      [cashboxIds, yesterday],
    );
    for (const r of rows) if (r.start) out.set(r.cashbox_id, r.start);
    return out;
  }

  /** Kun bo'yicha «chiqish» yig'indisi (T6 qaytarilganlarsiz). */
  private async dailyOutflows(
    q: SqlQuery,
    cashboxIds: string[],
    source: string,
    fromDay: string,
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    if (!cashboxIds.length) return out;
    const t = this.tables();
    const rows = await q<
      Array<{ cashbox_id: string; day: string; total: string }>
    >(
      `SELECT h."cashbox_id"::text AS cashbox_id,
              to_char(h."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
              SUM(ABS(h."amount")) AS total
         FROM ${t.history} h
        WHERE h."cashbox_id" = ANY($1::bigint[]) AND h."operation_type" = 'expense'
          AND h."source_type" = $2 AND h."is_deleted" = false
          AND h."createdAt" >= ($3::date::timestamp AT TIME ZONE 'Asia/Tashkent')
          AND NOT EXISTS (
            SELECT 1 FROM ${t.history} r
             WHERE r."source_type" = 'payment_reversal'
               AND r."reverses_history_id" = h."id" AND r."is_deleted" = false)
        GROUP BY 1, 2`,
      [cashboxIds, source, fromDay],
    );
    for (const r of rows) {
      const m = out.get(r.cashbox_id) ?? new Map<string, number>();
      m.set(r.day, money(r.total));
      out.set(r.cashbox_id, m);
    }
    return out;
  }

  /** R2 Kuryer qarzi o'smoqda: (o'sish VA > balance_uzs) YOKI (> N kun topshirilmagan). */
  private async r2(
    q: SqlQuery,
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const balanceUzs = positive(t.balance_uzs, 2_000_000);
    const growthDays = Math.floor(positive(t.growth_days, 3));
    const noHandover = Math.floor(positive(t.no_handover_days, 3));
    const minPct = clampPct(t.min_handover_pct, 80);
    const rows = await this.episodes(
      q,
      'couriers',
      'courier_payment',
      0,
      minPct,
      today,
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.cashbox_id);
    const window = Math.max(growthDays + 1, ADVISOR_EVIDENCE_LIMIT);
    const closings = await this.dailyClosings(
      q,
      ids,
      addDaysKey(today, -window),
      addDaysKey(today, -1),
    );
    const outflows = await this.dailyOutflows(
      q,
      ids,
      'courier_payment',
      addDaysKey(today, -window),
    );
    const closedDays = (r: EpisodeRow) =>
      (closings.get(r.cashbox_id) ?? []).filter((d) => d.date < today);
    // (a) o'sish: oxirgi growthDays+1 ta YOPILGAN kun (kechagacha) — har kuni
    // oldingisidan qat'iy katta. Kun yetishmasa (snapshot hali yo'q) — o'tkaziladi.
    const expected = Array.from({ length: growthDays + 1 }, (_, i) =>
      addDaysKey(today, i - growthDays - 1),
    );
    const isGrowth = (r: EpisodeRow) => {
      const tail = closedDays(r).slice(-(growthDays + 1));
      return (
        tail.length === growthDays + 1 &&
        tail.every((d, i) => d.date === expected[i]) &&
        tail.every((d, i) => i === 0 || d.closing > tail[i - 1].closing) &&
        money(r.balance) > balanceUzs
      );
    };
    const runStarts = await this.growthRunStarts(
      q,
      rows.filter(isGrowth).map((r) => r.cashbox_id),
      addDaysKey(today, -1),
    );
    const candidates: AiAdvisorCandidate[] = [];
    for (const r of rows) {
      const ep = episodeOf(r, today);
      if (!ep) continue;
      const balance = money(r.balance);
      const days = closedDays(r);
      const growth = isGrowth(r);
      const stale = balance > 0 && ep.days > noHandover;
      if (!growth && !stale) continue;
      // O'sish signali kechagacha yopilgan kunlardan; bugun topshirish bo'lsa
      // (epizod bugun boshlangan) — o'sha holat, yangi epizod emas (§6, Q23;
      // round-2 #652 B1). Ertaga topshirishdan keyingi yopilishlar bilan
      // shart qayta rost bo'lsa — yangi epizod.
      if (growth && !stale && ep.days <= 0) continue;
      const trigger =
        growth && stale ? 'both' : growth ? 'growth' : 'no_handover';
      // P1 (v0.4): faqat o'sish — epizod o'sish qatorining boshi; qisman
      // topshirishlar (har kuni yangi `ep:h`) occurrence ko'paytirmaydi.
      const runStart =
        trigger === 'growth'
          ? (runStarts.get(r.cashbox_id) ?? growthRunStart(days, today))
          : null;
      const fact = runStart
        ? {
            fact_key: `ep:g:${runStart}`,
            fact_at: new Date(`${runStart}T00:00:00.000+05:00`).toISOString(),
          }
        : { fact_key: ep.key, fact_at: ep.at };
      names.wantUser(r.owner);
      names.wantUserBranch(r.owner);
      const out = outflows.get(r.cashbox_id) ?? new Map<string, number>();
      const ev = days.slice(-ADVISOR_EVIDENCE_LIMIT);
      candidates.push({
        rule_key: 'R2',
        dedup_key: `R2:courier:${r.owner}`,
        fact_keys: [fact],
        branch: null,
        subject: { kind: 'courier', id: r.owner, name: null },
        headline_amount: balance,
        facts: {
          trigger,
          courier: { id: r.owner, name: null },
          branch: null,
          balance,
          growth_days: growth ? growthDays : 0,
          days_without_handover: ep.days,
          last_handover_at: r.last_at ? iso(r.last_at) : null,
        },
        evidence: {
          kind: 'courier_days',
          total_rows: days.length,
          truncated: days.length > ev.length,
          rows: ev.map((d) => ({
            date: d.date,
            opening_balance: d.opening,
            income: d.income,
            handed_over: out.get(d.date) ?? 0,
            closing_balance: d.closing,
          })),
          last_handover: r.last_id
            ? {
                at: iso(r.last_at),
                amount: money(r.last_amount),
                history_id: r.last_id,
              }
            : null,
          // v0.4: «topshirilmagan kunlar» faqat ≥ min_handover_pct topshirishda nolga tushadi.
          min_handover_pct: minPct,
        },
      });
    }
    return candidates;
  }

  /** R4 Market to'lovi kechikmoqda: qarz > 0 VA > N kun to'lov yo'q. */
  private async r4(
    q: SqlQuery,
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const limitDays = Math.floor(positive(t.days_without_payout, 7));
    // R4 o'zgarmaydi (ega, 2026-11-18): har qanday to'lov — minPct 0.
    const rows = await this.episodes(
      q,
      'markets',
      'market_payment',
      0,
      0,
      today,
    );
    const hits = rows
      .map((r) => ({ r, ep: episodeOf(r, today) }))
      .filter(
        (x): x is { r: EpisodeRow; ep: Episode } =>
          !!x.ep && x.ep.days > limitDays,
      );
    if (!hits.length) return [];
    const ids = hits.map((x) => x.r.cashbox_id);
    const from = addDaysKey(today, -ADVISOR_EVIDENCE_LIMIT);
    const closings = await this.dailyClosings(
      q,
      ids,
      from,
      addDaysKey(today, -1),
    );
    const paid = await this.dailyOutflows(q, ids, 'market_payment', from);
    return hits.map(({ r, ep }) => {
      names.wantUser(r.owner);
      const debt = money(r.balance);
      const days = closings.get(r.cashbox_id) ?? [];
      const p = paid.get(r.cashbox_id) ?? new Map<string, number>();
      return {
        rule_key: 'R4',
        dedup_key: `R4:market:${r.owner}`,
        fact_keys: [{ fact_key: ep.key, fact_at: ep.at }],
        branch: null,
        subject: { kind: 'market', id: r.owner, name: null },
        headline_amount: debt,
        facts: {
          market: { id: r.owner, name: null },
          debt,
          days_without_payout: ep.days,
          last_payout_at: r.last_at ? iso(r.last_at) : null,
          last_payout_amount: r.last_id ? money(r.last_amount) : null,
        },
        evidence: {
          kind: 'market_debt_days',
          total_rows: days.length,
          truncated: false,
          rows: days.map((d) => ({
            date: d.date,
            debt: d.closing,
            paid: p.get(d.date) ?? 0,
          })),
          last_payout: r.last_id
            ? {
                at: iso(r.last_at),
                amount: money(r.last_amount),
                history_id: r.last_id,
              }
            : null,
        },
      } satisfies AiAdvisorCandidate;
    });
  }

  /** R5 HQ'ga o'tkazma kechikmoqda: qoldiq > balance_uzs VA > N kun o'tkazma yo'q (Q17). */
  private async r5(
    q: SqlQuery,
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const balanceUzs = positive(t.balance_uzs, 5_000_000);
    const limitDays = Math.floor(positive(t.days_without_transfer, 3));
    const minPct = clampPct(t.min_transfer_pct, 80);
    // P3: epizod boshi chegaraga (balance_uzs) bog'liq emas — musbat qator.
    const rows = await this.episodes(
      q,
      'branch',
      'branch_to_main',
      balanceUzs,
      minPct,
      today,
    );
    const hits = rows
      .map((r) => ({ r, ep: episodeOf(r, today) }))
      .filter(
        (x): x is { r: EpisodeRow; ep: Episode } =>
          !!x.ep && x.ep.days > limitDays,
      );
    if (!hits.length) return [];
    const ids = hits.map((x) => x.r.cashbox_id);
    const closings = await this.dailyClosings(
      q,
      ids,
      addDaysKey(today, -ADVISOR_EVIDENCE_LIMIT),
      addDaysKey(today, -1),
    );
    const t2 = this.tables();
    const transfers = await q<
      Array<{
        cashbox_id: string;
        id: string;
        createdAt: Date;
        amount: string;
        rn: string;
      }>
    >(
      `SELECT * FROM (
         SELECT h."cashbox_id"::text AS cashbox_id, h."id"::text AS id,
                COALESCE(he.rat, h."createdAt") AS "createdAt", ABS(h."amount") AS amount,
                ROW_NUMBER() OVER (PARTITION BY h."cashbox_id"
                  ORDER BY COALESCE(he.rat, h."createdAt") DESC, h."id" DESC) AS rn
           FROM ${t2.history} h
           ${this.effectiveJoin('h')}
          WHERE h."cashbox_id" = ANY($1::bigint[]) AND h."operation_type" = 'expense'
            AND h."source_type" = 'branch_to_main' AND h."is_deleted" = false
            AND NOT EXISTS (
              SELECT 1 FROM ${t2.history} r
               WHERE r."source_type" = 'payment_reversal'
                 AND r."reverses_history_id" = h."id" AND r."is_deleted" = false)
       ) x WHERE x.rn <= ${ADVISOR_EVIDENCE_LIMIT}`,
      [ids],
    );
    return hits.map(({ r, ep }) => {
      const branch: AiAdvisorRef = { id: r.owner, name: null };
      names.wantBranch(r.owner);
      const balance = money(r.balance);
      return {
        rule_key: 'R5',
        dedup_key: `R5:branch:${r.owner}`,
        fact_keys: [{ fact_key: ep.key, fact_at: ep.at }],
        branch,
        subject: { kind: 'branch', id: r.owner, name: null },
        headline_amount: balance,
        facts: {
          branch,
          balance,
          days_without_transfer: ep.days,
          last_transfer_at: r.last_at ? iso(r.last_at) : null,
          last_transfer_amount: r.last_id ? money(r.last_amount) : null,
        },
        evidence: {
          kind: 'branch_transfers',
          // v0.4: «o'tkazmasiz kunlar» faqat ≥ min_transfer_pct o'tkazmada nolga tushadi.
          min_transfer_pct: minPct,
          total_rows: (closings.get(r.cashbox_id) ?? []).length,
          truncated: false,
          days: (closings.get(r.cashbox_id) ?? []).map((d) => ({
            date: d.date,
            closing_balance: d.closing,
          })),
          transfers: transfers
            .filter((x) => x.cashbox_id === r.cashbox_id)
            .map((x) => ({
              at: iso(x.createdAt),
              amount: money(x.amount),
              history_id: x.id,
              href: null,
            })),
        },
      } satisfies AiAdvisorCandidate;
    });
  }

  // ─── R7 Chek yoki karta farqi (§4.2, BE-rev B4; #653 review) ──────────

  private async r7(
    q: SqlQuery,
    since: Date,
    now: Date,
    names: NameCache,
    deadline: number,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const t = this.tables();
    // (a) karta qoldig'i: faqat TASDIQLANGAN (smena yopilgan) tekshiruvlar.
    // AI natijasi smena OCHIQ paytda keladi, `confirmed_at` — yopishda
    // (`confirmAtClose` `ai_status` ni yangi kutilgan qoldiq bilan qayta
    // hisoblaydi, `ai_checked_at` ga tegmaydi). Shuning uchun kursor —
    // GREATEST(ai_checked_at, confirmed_at): yopishdan oldingi tick qatorni
    // ko'rmasa ham, yopishdan keyingisi ko'radi (`attachLatePhoto` ham).
    const cardSeen = `GREATEST(k."ai_checked_at", k."confirmed_at")`;
    const cards = await q<CardCheckRow[]>(
      `SELECT k."id"::text AS id, k."shift_id"::text AS shift_id, k."cashbox_card_id"::text AS card_id,
              k."entered_balance", k."ai_read_balance", k."expected_balance", k."ai_entered_ok",
              k."ai_last4_detected", cc."last4" AS card_last4, k."ai_confidence",
              ${cardSeen} AS seen_at,
              s."closed_at", s."opened_at", COALESCE(s."cashbox_user_id", 0)::text AS owner,
              cc."name" AS card_name
         FROM ${t.checks} k
         JOIN ${t.shifts} s ON s."id" = k."shift_id"
         LEFT JOIN ${t.cards} cc ON cc."id" = k."cashbox_card_id"
        WHERE k."ai_status" = 'mismatch' AND k."confirmed_at" IS NOT NULL
          AND k."entered_balance" IS NOT NULL AND k."ai_read_balance" IS NOT NULL
          AND k."is_deleted" = false
          AND ${cardSeen} >= $1 AND ${cardSeen} <= $2
        ORDER BY ${cardSeen} ASC, k."id" ASC
        LIMIT ${R7_MAX_ROWS}`,
      [since, now],
    );
    // (b) T3 cheki: bog'langan, AI `mismatch` yoki `card_mismatch`; T6 bilan
    // qaytarilgan operatsiya cheklari — yo'q (week_summary va T3 ro'yxatlari
    // bilan bir xil). Kursor GREATEST(ai_checked_at, updatedAt): T6 tahriri
    // (`carryOverForCorrection`) holat/farqni qayta hisoblaydi.
    const receiptSeen = `GREATEST(r."ai_checked_at", r."updatedAt")`;
    const receipts = await q<ReceiptRow[]>(
      `SELECT r."id"::text AS id, r."kind"::text AS kind, r."ai_status"::text AS ai_status, r."ai_flags",
              r."entered_amount", r."ai_amount", r."ai_difference", r."ai_currency", r."ai_error_reason",
              r."ai_date", r."ai_recipient_last4", r."ai_payer_last4",
              r."ai_bank", r."ai_reference", r."ai_confidence", ${receiptSeen} AS seen_at,
              r."history_id"::text AS history_id, r."counter_history_id"::text AS counter_history_id,
              r."branch_id"::text AS receipt_branch_id,
              h."createdAt" AS op_at, h."source_type"::text AS source_type,
              h."expense_category_name" AS category_name, h."created_by"::text AS created_by,
              c."cashbox_type"::text AS cashbox_type, c."user_id"::text AS owner,
              cc2."cashbox_type"::text AS counter_cashbox_type, cc2."user_id"::text AS counter_owner
         FROM ${t.receipts} r
         LEFT JOIN ${t.history} h ON h."id" = r."history_id"
         LEFT JOIN ${t.cashboxes} c ON c."id" = h."cashbox_id"
         LEFT JOIN ${t.history} h2 ON h2."id" = r."counter_history_id"
         LEFT JOIN ${t.cashboxes} cc2 ON cc2."id" = h2."cashbox_id"
        WHERE r."state" = 'linked' AND r."is_deleted" = false
          AND (r."ai_status" = 'mismatch' OR COALESCE(r."ai_flags", '[]'::jsonb) @> '["card_mismatch"]'::jsonb)
          AND r."ai_checked_at" IS NOT NULL
          AND ${receiptSeen} >= $1 AND ${receiptSeen} <= $2
          AND (r."history_id" IS NULL OR ${notReversedSql(t.history, 'r', 'history_id')})
        ORDER BY ${receiptSeen} ASC, r."id" ASC
        LIMIT ${R7_MAX_ROWS}`,
      [since, now],
    );
    const cursor = r7Cursor([cards, receipts]);
    // Bir lahzadagi > R7_MAX_ROWS qator (ommaviy updatedAt) — kursor
    // siljimaydi; jim qolmasin (round-3 S3).
    for (const [name, rows] of [
      ['card', cards],
      ['receipt', receipts],
    ] as const) {
      if (rows.length)
        warnIfStalled(
          this.logger,
          `R7 ${name}`,
          rows.length,
          R7_MAX_ROWS,
          rows[0].seen_at,
          iso(rows[rows.length - 1].seen_at),
        );
    }
    if (!cards.length && !receipts.length) return { candidates: [], cursor };

    const receiptAi = await this.receiptAiEnabled(deadline);
    const types = await this.cashboxTypes(q, [
      ...new Set(cards.map((r) => r.owner)),
    ]);
    const candidates: AiAdvisorCandidate[] = [];

    for (const r of cards) {
      const cashbox = cashboxRef(r.owner, types.get(r.owner));
      // #726: filial kassasi bitta jami (balance_card doim 0, filial
      // smenasida karta sanalmaydi) - karta qoldig'i tekshiruvi filialda
      // R7 ochmaydi (eski / aralash qatorlar bo'lsa ham).
      if (cashbox.type === 'branch') continue;
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: r.owner, name: null } : null;
      if (branch) names.wantBranch(branch.id);
      const entered = money(r.entered_balance);
      const read = money(r.ai_read_balance);
      const expected = moneyOrNull(r.expected_balance);
      // `difference` — kassir xatosi (AI o'qigan − kiritilgan);
      // `system_difference` — haqiqiy kamomad/ortiqcha (AI o'qigan − tizimdagi).
      const difference = money(read - entered);
      const systemDifference =
        expected === null ? null : money(read - expected);
      const mismatch: string[] = [];
      // Ega qarori 2026-11-14: R7 karta faqat HAQIQIY farqda — AI o'qigan ≠
      // tizimdagi (yoki boshqa karta). Kassir faqat noto'g'ri raqam kiritgan
      // (AI = tizim) — R7 emas, smena hisobotida ko'rinadi. Tizim qoldig'i
      // noma'lum (eski qator) — AI o'qigan vs kiritilgan.
      const amountGap = systemDifference ?? difference;
      if (Math.abs(amountGap) > R7_TOLERANCE) mismatch.push('amount');
      const last4 = (r.card_last4 ?? '').trim();
      const detected = (r.ai_last4_detected ?? '').trim();
      if (
        /^\d{4}$/.test(last4) &&
        /^\d{4}$/.test(detected) &&
        last4 !== detected
      )
        mismatch.push('card');
      // Haqiqiy farq yo'q (masalan AI karta raqamini o'qiy olmadi — finance
      // buni `mismatch` deb belgilaydi): R7 «farq» ochmaydi (round-3 N1).
      if (!mismatch.length) continue;
      const at = r.closed_at ?? r.seen_at;
      const shiftDate = tashkentDateKey(new Date(r.opened_at ?? at));
      candidates.push({
        rule_key: 'R7',
        dedup_key: `R7:card_check:${r.id}`,
        fact_keys: [{ fact_key: `R7:card_check:${r.id}`, fact_at: iso(at) }],
        branch,
        subject: { kind: 'cashbox', id: r.owner, name: null },
        headline_amount: mismatch.includes('amount') ? amountGap : null,
        facts: {
          source: 'card_balance',
          receipt_ai_enabled: receiptAi,
          mismatch,
          cashbox,
          branch,
          entered_amount: entered,
          read_amount: read,
          difference,
          expected_balance: expected,
          system_difference: systemDifference,
          entered_ok: r.ai_entered_ok,
          operation: null,
          shift: { id: r.shift_id, date: shiftDate },
          card: { id: r.card_id, name: r.card_name ?? null },
          created_by: null,
          created_at: iso(at),
        },
        evidence: {
          kind: 'card_balance_check',
          total_rows: 1,
          truncated: false,
          shift: {
            id: r.shift_id,
            date: shiftDate,
            closed_at: r.closed_at ? iso(r.closed_at) : null,
          },
          card: { id: r.card_id, name: r.card_name ?? null },
          entered_balance: entered,
          ai_read_balance: read,
          expected_balance: expected,
          difference,
          system_difference: systemDifference,
          ai_confidence:
            r.ai_confidence === null ? null : Number(r.ai_confidence),
        },
      });
    }

    const week = receipts.length
      ? await this.receiptWeekSummary(now, deadline)
      : null;
    for (const r of receipts) {
      const transfer = r.kind === 'courier_to_hq' || r.kind === 'branch_to_hq';
      // O'tkazma chekida `history_id` — MAIN kirim oyog'i; jo'natuvchi —
      // qarshi oyoq (`counter_history_id`) kassasi.
      const ownType =
        transfer && r.counter_owner ? r.counter_cashbox_type : r.cashbox_type;
      const owner =
        (transfer && r.counter_owner ? r.counter_owner : r.owner) ?? '0';
      const cashbox = cashboxRef(owner, ownType ?? 'main');
      const branchId =
        r.receipt_branch_id ?? (cashbox.type === 'branch' ? owner : null);
      const branch: AiAdvisorRef | null = branchId
        ? { id: branchId, name: null }
        : null;
      if (branch) names.wantBranch(branch.id);
      if (cashbox.type === 'couriers') names.wantUser(owner);
      if (isId(r.created_by)) names.wantUser(r.created_by);
      const flags = Array.isArray(r.ai_flags)
        ? r.ai_flags.filter((f): f is string => typeof f === 'string')
        : [];
      const foreign = isForeignReceipt(r.ai_currency, r.ai_error_reason);
      // 'amount' — faqat haqiqiy so'm farqi (> 1 so'm): #643 dan oldingi
      // sinonim valyutali (SUM, …) cheklar 0 farq bilan `mismatch` bo'lib
      // qolgan — «0 so'm» ogohlantirishi yo'q (round-3 S2).
      const gap = foreign ? null : moneyOrNull(r.ai_difference);
      const mismatch = [
        ...(r.ai_status === 'mismatch' &&
        gap !== null &&
        Math.abs(gap) > R7_TOLERANCE
          ? ['amount']
          : []),
        ...(foreign ? ['currency'] : []),
        ...(flags.includes('card_mismatch') ? ['card'] : []),
      ];
      if (!mismatch.length) continue;
      // Valyuta so'm emas — summalarni solishtirib bo'lmaydi (#643, review B2).
      const difference = foreign ? null : moneyOrNull(r.ai_difference);
      const at = r.op_at ?? r.seen_at;
      const date = foreign
        ? { date_at: null, date_day: null }
        : parseReceiptDateTime(r.ai_date);
      candidates.push({
        rule_key: 'R7',
        dedup_key: `R7:receipt:${r.id}`,
        fact_keys: [{ fact_key: `R7:receipt:${r.id}`, fact_at: iso(at) }],
        branch,
        subject: { kind: 'cashbox', id: owner, name: null },
        headline_amount: difference,
        facts: {
          source: 'receipt',
          receipt_kind: r.kind,
          receipt_ai_enabled: receiptAi,
          mismatch,
          cashbox,
          branch,
          entered_amount: moneyOrNull(r.entered_amount),
          read_amount: foreign ? null : moneyOrNull(r.ai_amount),
          read_amount_original: foreign ? moneyOrNull(r.ai_amount) : null,
          read_currency: foreign
            ? (r.ai_currency ?? '').trim().toUpperCase() || null
            : null,
          difference,
          operation: r.history_id
            ? {
                // O'tkazmada — jo'natuvchining CHIQIM oyog'i (facts.cashbox
                // tarixida bor; MAIN kirim oyog'i emas — round-3 S1).
                history_id:
                  transfer && r.counter_owner && r.counter_history_id
                    ? r.counter_history_id
                    : r.history_id,
                // Shartnoma enum (CASHBOX_RECEIPT_KINDS) — chek turi, `source_type` emas
                // (round-2 #654: HQ o'tkazmalari courier_to_hq / branch_to_hq).
                kind: r.kind,
                category_name: r.category_name ?? null,
              }
            : null,
          shift: null,
          card: null,
          created_by: isId(r.created_by)
            ? { id: r.created_by, name: null }
            : null,
          created_at: iso(at),
        },
        evidence: {
          kind: 'receipt_check',
          total_rows: 1,
          truncated: false,
          receipt: {
            id: r.id,
            kind: r.kind,
            ai_status: r.ai_status,
            flags,
            date: r.ai_date ?? null,
            date_at: date.date_at,
            date_day: date.date_day,
            amount: moneyOrNull(r.ai_amount),
            currency: r.ai_currency ?? null,
            error_reason: r.ai_error_reason ?? null,
            // PII minimallashtirish (review S4, §3.5): ism saqlanmaydi —
            // faqat oxirgi 4 raqam; maket ham faqat «··last4» ko'rsatadi.
            recipient: null,
            recipient_last4: r.ai_recipient_last4 ?? null,
            payer: null,
            payer_last4: r.ai_payer_last4 ?? null,
            bank: r.ai_bank ?? null,
            reference: r.ai_reference ?? null,
            confidence:
              r.ai_confidence === null ? null : Number(r.ai_confidence),
          },
          week_summary: week,
        },
      });
    }
    return { candidates, cursor };
  }

  /** Chek AI yoqiqmi (manual_expense YOKI hq_transfer). O'qilmasa — null. */
  private async receiptAiEnabled(deadline: number): Promise<boolean | null> {
    const svc = this.receiptService;
    if (!svc) return null;
    try {
      // O'z tranzaksiyasi, byudjet ichida (#704 review S3).
      const s = await this.withTimeout(deadline, (_q, m) =>
        svc.loadSettings(m),
      );
      return Boolean(s.manual_expense.ai_enabled || s.hq_transfer.ai_enabled);
    } catch {
      return null;
    }
  }

  /** Joriy Toshkent haftasi chek tekshiruvi sanoqlari (`checked = match + mismatch + unreadable`). */
  private async receiptWeekSummary(
    now: Date,
    deadline: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      const today = tashkentDateKey(now);
      const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = dushanba
      const from = addDaysKey(today, -weekday);
      const to = addDaysKey(from, 6);
      // loadReceiptChecksSummary — `m` orqali 2 ta ifoda (Promise.all,
      // bitta ulanishda ketma-ket): har biriga qolgan byudjetning yarmi.
      const summary = await this.withTimeout(
        deadline,
        (_q, m) =>
          loadReceiptChecksSummary(
            m,
            {
              receipts: this.ds.getMetadata(CashboxReceipt).tablePath,
              history: this.ds.getMetadata(CashboxHistory).tablePath,
              cashbox: this.ds.getMetadata(Cashbox).tablePath,
            },
            {
              start: new Date(`${from}T00:00:00.000+05:00`),
              end: new Date(
                new Date(`${to}T00:00:00.000+05:00`).getTime() + 86_400_000,
              ),
            },
          ),
        2,
      );
      const c = summary.counts as Record<string, number>;
      const match = Number(c.match ?? 0);
      const mismatch = Number(c.mismatch ?? 0);
      const unreadable = Number(c.unreadable ?? 0);
      return {
        from,
        to,
        checked: match + mismatch + unreadable,
        match,
        mismatch,
        unreadable,
      };
    } catch (error) {
      this.logger.warn(
        `advisor: chek haftalik xulosasi olinmadi — ${short(error)}`,
      );
      return null;
    }
  }

  // ─── R8 Tuzatishlar ko'paydi (§4.2, BE-rev B2, Q4) ────────────────────

  private async r8(
    q: SqlQuery,
    t: Record<string, number>,
    weeks: string[],
    now: Date,
  ): Promise<AiAdvisorCandidate[]> {
    const ratio = positive(t.ratio, 2);
    // Ega qarori 2026-11-14: haftada kamida `min_count` (sukut 3) ta; ≥ 1 doim.
    const minCount = Math.max(
      1,
      Math.floor(positive(t.min_count, R8_MIN_COUNT)),
    );
    const today = tashkentDateKey(now);
    const out: AiAdvisorCandidate[] = [];
    for (const monday of weeks.filter(
      (w) => isDay(w) && addDaysKey(w, 6) < today,
    )) {
      const from = monday;
      const to = addDaysKey(monday, 6);
      const start = new Date(`${from}T00:00:00.000+05:00`);
      const end = new Date(start.getTime() + 7 * 86_400_000);
      const baseStart = new Date(
        start.getTime() - R8_BASELINE_DAYS * 86_400_000,
      );
      const week = await this.correctionCounts(q, start, end);
      const base = await this.correctionCounts(q, baseStart, start);
      const counted = (k: CorrectionCounts) =>
        k.manual_correction + k.payment_reverse + k.payment_edit;
      const count = counted(week);
      const baselineTotal = counted(base);
      const weeklyAvg =
        Math.round((baselineTotal / R8_BASELINE_DAYS) * 7 * 100) / 100;
      // count ≥ max(min_count, ratio × weekly_avg). Solishtiruv BUTUN sonlarda
      // (BE-rev S9): count × 30 × 10 ≥ round(ratio × 10) × baseline × 7 —
      // yaxlitlangan `weekly_avg` faqat ko'rsatish uchun.
      if (count < minCount) continue;
      if (
        count * R8_BASELINE_DAYS * 10 <
        Math.round(ratio * 10) * baselineTotal * 7
      )
        continue;
      const days = await this.correctionDays(q, start, end);
      const key = `R8:week:${monday}`;
      out.push({
        rule_key: 'R8',
        dedup_key: key,
        fact_keys: [
          { fact_key: key, fact_at: new Date(end.getTime() - 1).toISOString() },
        ],
        // §5.1: R8 — first_fact_at = davr boshi; system — «Butun tizim».
        first_fact_at: start.toISOString(),
        branch: null,
        subject: {
          kind: 'system',
          id: null,
          name: AI_ADVISOR_SYSTEM_SUBJECT_NAME,
        },
        headline_amount: null,
        facts: {
          from,
          to,
          count,
          baseline_weekly_avg: weeklyAvg,
          ratio:
            weeklyAvg > 0 ? Math.round((count / weeklyAvg) * 10) / 10 : null,
        },
        evidence: {
          kind: 'corrections',
          total_rows: days.length,
          truncated: false,
          by_kind: week,
          counted_kinds: [
            'manual_correction',
            'payment_reverse',
            'payment_edit',
          ],
          days,
          baseline: {
            window_days: R8_BASELINE_DAYS,
            total: baselineTotal,
            weekly_avg: weeklyAvg,
            min_count: minCount,
            ratio,
          },
        },
      });
    }
    return out;
  }

  /**
   * Tuzatish turlari: qo'lda (`correction`, `source_id IS NULL`), buyurtma
   * qaytarilishi (`correction`, buyurtma bo'yicha DISTINCT), T6 qaytarish /
   * tahrir (`payment_corrections.action`). `payment_reversal` — hech qachon.
   */
  private async correctionCounts(
    q: SqlQuery,
    start: Date,
    end: Date,
  ): Promise<CorrectionCounts> {
    const t = this.tables();
    const [h] = await q<Array<{ manual: string; orders: string }>>(
      `SELECT COUNT(*) FILTER (WHERE "source_id" IS NULL) AS manual,
              COUNT(DISTINCT "source_id") FILTER (WHERE "source_id" IS NOT NULL) AS orders
         FROM ${t.history}
        WHERE "source_type" = 'correction' AND "is_deleted" = false
          AND "createdAt" >= $1 AND "createdAt" < $2`,
      [start, end],
    );
    const pc = await q<Array<{ action: string; n: string }>>(
      `SELECT "action", COUNT(*) AS n FROM ${t.corrections}
        WHERE "is_deleted" = false AND "createdAt" >= $1 AND "createdAt" < $2
        GROUP BY "action"`,
      [start, end],
    );
    const by = new Map(pc.map((r) => [r.action, Number(r.n)]));
    return {
      manual_correction: Number(h?.manual ?? 0),
      order_rollback: Number(h?.orders ?? 0),
      payment_reverse: by.get('reverse') ?? 0,
      payment_edit: by.get('edit') ?? 0,
    };
  }

  /** Hafta kunlari bo'yicha sanalgan tuzatishlar (counted_kinds). */
  private async correctionDays(
    q: SqlQuery,
    start: Date,
    end: Date,
  ): Promise<Array<{ date: string; count: number }>> {
    const t = this.tables();
    const rows = await q<Array<{ day: string; n: string }>>(
      `SELECT day, SUM(n) AS n FROM (
         SELECT to_char("createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day, COUNT(*) AS n
           FROM ${t.history}
          WHERE "source_type" = 'correction' AND "source_id" IS NULL AND "is_deleted" = false
            AND "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
         UNION ALL
         SELECT to_char("createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day, COUNT(*) AS n
           FROM ${t.corrections}
          WHERE "is_deleted" = false AND "createdAt" >= $1 AND "createdAt" < $2
          GROUP BY 1
       ) x GROUP BY day`,
      [start, end],
    );
    const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
    const first = tashkentDateKey(start);
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDaysKey(first, i);
      return { date, count: byDay.get(date) ?? 0 };
    });
  }

  // ─── Yordamchilar ─────────────────────────────────────────────────────

  private async cashboxTypes(
    q: SqlQuery,
    owners: string[],
  ): Promise<Map<string, string>> {
    const ids = owners.filter((o) => o !== '0');
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await q<Array<{ owner: string; cashbox_type: string }>>(
      `SELECT DISTINCT ON ("user_id") "user_id"::text AS owner, "cashbox_type"::text AS cashbox_type
         FROM ${this.tables().cashboxes}
        WHERE "user_id" = ANY($1::bigint[]) AND "cashbox_type" IN ('branch', 'main')
          AND "is_deleted" = false
        ORDER BY "user_id", ("cashbox_type" = 'branch') DESC`,
      [ids],
    );
    for (const r of rows) out.set(r.owner, r.cashbox_type);
    return out;
  }

  /** `identity.user.find_by_ids` — fail-open. */
  async userNames(
    ids: string[],
    onFail?: () => void,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(isId))];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    try {
      const response = await rmqSend<{ data?: unknown }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        { ids: unique },
        { timeoutMs: NAME_TIMEOUT_MS, retries: 1 },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows as Array<{ id?: unknown; name?: unknown }>) {
        const id =
          typeof row?.id === 'string' || typeof row?.id === 'number'
            ? String(row.id)
            : '';
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        if (id && name) out.set(id, name.slice(0, 120));
      }
    } catch (error) {
      onFail?.();
      this.logger.warn(`advisor: ismlar olinmadi — ${short(error)}`);
    }
    return out;
  }

  /**
   * Foydalanuvchi → filial (`branch.user.find_by_user_ids`) — fail-open.
   * branch-service bir so'rovda ≤ 500 id qabul qiladi — bo'laklarda (round-2).
   */
  async userBranches(
    ids: string[],
    onFail?: () => void,
  ): Promise<Map<string, AiAdvisorRef>> {
    const out = new Map<string, AiAdvisorRef>();
    const unique = [...new Set(ids.filter(isId))];
    if (!this.branchClient || !unique.length) return out;
    for (let i = 0; i < unique.length; i += USER_BRANCH_CHUNK) {
      await this.userBranchChunk(
        unique.slice(i, i + USER_BRANCH_CHUNK),
        out,
        onFail,
      );
    }
    return out;
  }

  private async userBranchChunk(
    unique: string[],
    out: Map<string, AiAdvisorRef>,
    onFail?: () => void,
  ): Promise<void> {
    if (!this.branchClient) return;
    try {
      const response = await rmqSend<{
        data?: Array<{
          user_id?: unknown;
          branch?: { id?: unknown; name?: unknown } | null;
        }>;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user_ids' },
        { user_ids: unique, requester: SYSTEM_BRANCH_REQUESTER },
        { timeoutMs: NAME_TIMEOUT_MS, retries: 0 },
      );
      for (const row of Array.isArray(response?.data) ? response.data : []) {
        const userId =
          typeof row?.user_id === 'string' || typeof row?.user_id === 'number'
            ? String(row.user_id)
            : '';
        const branchId =
          typeof row?.branch?.id === 'string' ||
          typeof row?.branch?.id === 'number'
            ? String(row.branch.id)
            : '';
        if (!userId || !branchId) continue;
        const name =
          typeof row?.branch?.name === 'string' && row.branch.name.trim()
            ? row.branch.name.trim().slice(0, 120)
            : null;
        out.set(userId, { id: branchId, name });
      }
    } catch (error) {
      onFail?.();
      this.logger.warn(`advisor: kuryer filiallari olinmadi — ${short(error)}`);
    }
  }

  /**
   * Filial nomlari (`branch.find_by_id`) — fail-open, parallel (≤ 5 bir
   * vaqtda): osilgan branch-service tick'ni 30 s dan oshirmasin (round-2).
   */
  async branchNames(
    ids: string[],
    onFail?: () => void,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.branchClient) return out;
    const client = this.branchClient;
    const queue = [...new Set(ids.filter(isId))];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const response = await rmqSend<{ data?: { name?: unknown } }>(
            client,
            { cmd: 'branch.find_by_id' },
            { id, requester: SYSTEM_BRANCH_REQUESTER },
            { timeoutMs: NAME_TIMEOUT_MS, retries: 0 },
          );
          const name = response?.data?.name;
          if (typeof name === 'string' && name.trim())
            out.set(id, name.trim().slice(0, 120));
        } catch (error) {
          onFail?.();
          this.logger.warn(
            `advisor: filial nomi olinmadi (${id}) — ${short(error)}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: BRANCH_NAME_CONCURRENCY }, () => worker()),
    );
    return out;
  }
}

/**
 * Ism snapshotlari: qoidalar `want*` bilan yig'adi, oxirida bitta to'plam
 * so'rov bilan `name: null` maydonlarini to'ldiradi.
 */
class NameCache {
  private readonly users = new Set<string>();
  private readonly branches = new Set<string>();
  private readonly userBranches = new Set<string>();

  constructor(
    private readonly svc: AdvisorInputsService,
    /** Chegara `fill()` paytida hisoblanadi (umumiy byudjetdan qolgani). */
    private readonly deadlineMs: () => number = () => ADVISOR_NAMES_DEADLINE_MS,
  ) {}

  wantUser(id: string): void {
    this.users.add(id);
  }

  wantBranch(id: string): void {
    this.branches.add(id);
  }

  /** Kuryerning filiali (R2 `branch`) — `branch.user.find_by_user_ids`. */
  wantUserBranch(id: string): void {
    this.userBranches.add(id);
  }

  /** Dalil qatori kassasi (R3 «tizim bo'yicha» — har qator o'z kassasi). */
  wantCashbox(cb: AiAdvisorCashboxRef | undefined): void {
    if (!cb || cb.owner_id === '0') return;
    if (cb.type === 'branch') this.branches.add(cb.owner_id);
    else if (cb.type !== 'main') this.users.add(cb.owner_id);
  }

  /** Ism/filial qidiruvi yiqildimi (P6 `names_degraded`). */
  degraded = false;

  async fill(candidates: AiAdvisorCandidate[]): Promise<void> {
    const fail = () => {
      this.degraded = true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), this.deadlineMs());
    });
    const within = async <T>(p: Promise<Map<string, T>>) => {
      const r = await Promise.race([p, deadline]);
      if (r !== 'deadline') return r;
      fail();
      return new Map<string, T>();
    };
    const [users, branches, userBranch] = await Promise.all([
      within(this.svc.userNames([...this.users], fail)),
      within(this.svc.branchNames([...this.branches], fail)),
      within(this.svc.userBranches([...this.userBranches], fail)),
    ]).finally(() => clearTimeout(timer));
    const branchRef = (ref: unknown) => {
      const r = ref as AiAdvisorRef | null;
      if (r && r.name === null) r.name = branches.get(r.id) ?? null;
    };
    const userRef = (ref: unknown) => {
      const r = ref as AiAdvisorRef | null;
      if (r && typeof r === 'object' && r.name === null)
        r.name = users.get(r.id) ?? null;
    };
    const cashboxName = (cb: AiAdvisorCashboxRef | undefined) => {
      if (!cb || cb.name !== null) return;
      if (cb.type === 'main') cb.name = MAIN_CASHBOX_NAME;
      else if (cb.type === 'branch') {
        const b = branches.get(cb.owner_id);
        cb.name = b ? `${b} kassasi` : null;
      } else cb.name = users.get(cb.owner_id) ?? null;
    };
    for (const c of candidates) {
      if (c.rule_key === 'R2' && c.subject.id) {
        const b = userBranch.get(c.subject.id) ?? null;
        c.branch = b;
        c.facts.branch = b;
      }
      branchRef(c.branch);
      const f = c.facts;
      if (f.branch && f.branch !== c.branch) branchRef(f.branch);
      cashboxName(f.cashbox as AiAdvisorCashboxRef | undefined);
      for (const u of (f.closed_by as unknown[] | undefined) ?? []) userRef(u);
      userRef(f.created_by);
      userRef(f.courier);
      userRef(f.market);
      if (c.subject.name === null && c.subject.id) {
        if (c.subject.kind === 'cashbox') {
          c.subject.name =
            (f.cashbox as AiAdvisorCashboxRef | undefined)?.name ?? null;
        } else if (
          c.subject.kind === 'courier' ||
          c.subject.kind === 'market'
        ) {
          c.subject.name = users.get(c.subject.id) ?? null;
        } else if (c.subject.kind === 'branch') {
          c.subject.name = branches.get(c.subject.id) ?? null;
        }
      }
      for (const row of (c.evidence.rows as
        Array<Record<string, unknown>> | undefined) ?? []) {
        userRef(row.closed_by);
        userRef(row.created_by);
        if ('cashbox_name' in row && row.cashbox_name === null) {
          const own = row.cashbox as AiAdvisorCashboxRef | undefined;
          if (own) cashboxName(own);
          row.cashbox_name =
            (own ?? (f.cashbox as AiAdvisorCashboxRef | undefined))?.name ??
            null;
        }
      }
    }
  }
}

function shiftEvidenceRow(r: ShiftRow): Record<string, unknown> {
  const expectedCash = moneyOrNull(r.expected_balance_cash);
  const expectedCard = moneyOrNull(r.expected_balance_card);
  const dCash = moneyOrNull(r.discrepancy_cash);
  const dCard = moneyOrNull(r.discrepancy_card);
  const countedCash =
    dCash === null ? null : money((expectedCash ?? 0) + dCash);
  const countedCard =
    dCard === null ? null : money((expectedCard ?? 0) + dCard);
  // «Kutilgan»/«Sanalgan» — faqat SANALGAN qismlar: counted − expected = difference.
  const expected = money(
    (dCash === null ? 0 : (expectedCash ?? 0)) +
      (dCard === null ? 0 : (expectedCard ?? 0)),
  );
  const counted = money((countedCash ?? 0) + (countedCard ?? 0));
  return {
    shift_id: r.id,
    closed_at: iso(r.closed_at),
    closed_by: isId(r.closed_by) ? { id: r.closed_by, name: null } : null,
    closed_by_system: r.closed_by_system === true,
    expected_cash: expectedCash ?? 0,
    expected_card: expectedCard ?? 0,
    counted_cash: countedCash,
    counted_card: countedCard,
    expected,
    counted,
    difference: money(r.difference),
    href: `/payments/shifts/${r.id}`,
  };
}

function cashboxRef(
  owner: string,
  type: string | undefined,
): AiAdvisorCashboxRef {
  if (owner === '0') return { type: 'main', owner_id: '0', name: null };
  if (type === 'main') return { type: 'main', owner_id: owner, name: null };
  if (type === 'couriers' || type === 'markets')
    return { type, owner_id: owner, name: null };
  return { type: 'branch', owner_id: owner, name: null };
}

function parseSince(value: string | undefined, now: Date): Date {
  const d = value ? new Date(value) : null;
  // Orqa oyna ≤ 30 kun (round-2 #651 S10) — finance'ni himoya qiladi.
  const floor = new Date(
    now.getTime() - AI_ADVISOR_INPUT_MAX_SINCE_DAYS * 24 * 3600_000,
  );
  if (d && !Number.isNaN(d.getTime()) && d <= now) return d < floor ? floor : d;
  // Kursor yo'q / noto'g'ri — §4.3 qisqa orqa oyna (7 kun).
  return new Date(now.getTime() - 7 * 24 * 3600_000);
}

/** Foiz chegarasi 1–100 (sozlama limiti bilan bir xil); noto'g'ri — sukut. */
function clampPct(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  return n >= 1 && n <= 100 ? n : fallback;
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Partiya to'la va hammasi bir lahzada (masalan bitta tranzaksiyadagi
 * ommaviy yozuv) — kursor siljiy olmaydi; jim qolmasin (round-2 ops-S8).
 */
function warnIfStalled(
  logger: Logger,
  rule: string,
  count: number,
  limit: number,
  first: Date,
  cursor: string,
): void {
  if (count >= limit && iso(first) === cursor) {
    logger.error(
      `advisor ${rule}: kursor siljimaydi — ${count} qator bir lahzada (${cursor})`,
    );
  }
}

function byClosedAt(a: ShiftRow, b: ShiftRow): number {
  return +new Date(a.closed_at) - +new Date(b.closed_at) || cmpId(a.id, b.id);
}

function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
