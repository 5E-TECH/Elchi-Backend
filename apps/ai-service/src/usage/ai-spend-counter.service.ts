import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiSpendCounter } from '../entities/ai-spend-counter.entity';
import { roundMoney2, roundUsd } from './ai-pricing';
import { isYmd } from './tashkent-day';

/** `add` / `addOverride` RETURNING natijasi (numeric → number). */
export interface AiSpendTotals {
  cost_usd: number;
  override_usd: number;
  warned_at: Date | null;
  exceeded_at: Date | null;
}

/** Bitta kunning to'liq hisoblagich qatori (`read`). */
export interface AiSpendCounterRow extends AiSpendTotals {
  period_key: string;
  cost_uzs: number;
  calls: number;
}

/**
 * Atomik oshirish — BITTA statement: parallel 10 ta javob ham aniq 10 marta
 * qo'shiladi (ON CONFLICT DO UPDATE qatorni qulflaydi, o'qish-yozish poygasi
 * yo'q). Kun qatori yo'q bo'lsa shu statement o'zi yaratadi.
 */
export const AI_SPEND_ADD_SQL = `
  INSERT INTO ai_schema.ai_spend_counter
    (scope, period_key, cost_usd, cost_uzs, calls, "createdAt", "updatedAt")
  VALUES ('global', $1::date, $2, $3, 1, now(), now())
  ON CONFLICT (scope, period_key) DO UPDATE SET
    cost_usd = ai_spend_counter.cost_usd + EXCLUDED.cost_usd,
    cost_uzs = ai_spend_counter.cost_uzs + EXCLUDED.cost_uzs,
    calls = ai_spend_counter.calls + 1,
    "updatedAt" = now()
  RETURNING cost_usd::float8 AS cost_usd,
            override_usd::float8 AS override_usd,
            warned_at,
            exceeded_at
`;

/**
 * Kunlik jami — BITTA PK lookup (wFSMEIIy #20): butun jadval yoki
 * ai_usage_log skanerlanmaydi.
 */
export const AI_SPEND_READ_SQL = `
  SELECT period_key::text AS period_key,
         cost_usd::float8 AS cost_usd,
         cost_uzs::float8 AS cost_uzs,
         calls,
         override_usd::float8 AS override_usd,
         warned_at,
         exceeded_at
  FROM ai_schema.ai_spend_counter
  WHERE scope = 'global' AND period_key = $1::date
`;

/** 80% bildirishnomasi kuniga BIR marta — `IS NULL` sharti g'olibni tanlaydi. */
export const AI_SPEND_MARK_WARNED_SQL = `
  UPDATE ai_schema.ai_spend_counter
  SET warned_at = now(), "updatedAt" = now()
  WHERE scope = 'global' AND period_key = $1::date AND warned_at IS NULL
  RETURNING 1 AS won
`;

/** 100% bildirishnomasi kuniga BIR marta. */
export const AI_SPEND_MARK_EXCEEDED_SQL = `
  UPDATE ai_schema.ai_spend_counter
  SET exceeded_at = now(), "updatedAt" = now()
  WHERE scope = 'global' AND period_key = $1::date AND exceeded_at IS NULL
  RETURNING 1 AS won
`;

/** SUPERADMIN "shiftni ko'tarish" — atomik `override_usd += extra`. */
export const AI_SPEND_ADD_OVERRIDE_SQL = `
  INSERT INTO ai_schema.ai_spend_counter
    (scope, period_key, override_usd, "createdAt", "updatedAt")
  VALUES ('global', $1::date, $2, now(), now())
  ON CONFLICT (scope, period_key) DO UPDATE SET
    override_usd = ai_spend_counter.override_usd + EXCLUDED.override_usd,
    "updatedAt" = now()
  RETURNING cost_usd::float8 AS cost_usd,
            override_usd::float8 AS override_usd,
            warned_at,
            exceeded_at
`;

interface RawTotals {
  cost_usd: unknown;
  override_usd: unknown;
  warned_at: Date | null;
  exceeded_at: Date | null;
}

interface RawRow extends RawTotals {
  period_key: unknown;
  cost_uzs: unknown;
  calls: unknown;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toTotals(row: RawTotals): AiSpendTotals {
  return {
    cost_usd: toNumber(row.cost_usd),
    override_usd: toNumber(row.override_usd),
    warned_at: row.warned_at ?? null,
    exceeded_at: row.exceeded_at ?? null,
  };
}

/**
 * TypeORM `query()` postgres'da UPDATE/DELETE uchun `[rows, rowCount]`,
 * boshqa buyruqlar uchun `rows` qaytaradi — ikkalasidan qatorlarni oladi.
 */
function rowsOf<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

function assertPeriodKey(periodKey: string): void {
  if (!isYmd(periodKey)) {
    throw new Error(`period_key noto'g'ri: YYYY-MM-DD kutilgan`);
  }
}

/**
 * `ai_schema.ai_spend_counter` ustidagi xom SQL amallari.
 *
 * ⚠️ Faqat `scope='global'` + Toshkent sanasi. Market/foydalanuvchi kesimi
 * YO'Q (wFSMEIIy #19) — `no-quota.guard.spec.ts` buni statik tekshiradi.
 * Xatolar YUTILMAYDI: `read` throw qilsa ClaudeService AI'ni fail-closed
 * ('disabled') qiladi.
 */
@Injectable()
export class AiSpendCounterService {
  constructor(
    @InjectRepository(AiSpendCounter)
    private readonly repo: Repository<AiSpendCounter>,
  ) {}

  /** Kun hisoblagichiga xarajat qo'shadi; yangi jami qaytadi. */
  async add(
    periodKey: string,
    usd: number,
    uzs: number,
  ): Promise<AiSpendTotals> {
    assertPeriodKey(periodKey);
    const rows = rowsOf<RawTotals>(
      await this.repo.query(AI_SPEND_ADD_SQL, [
        periodKey,
        roundUsd(usd),
        roundMoney2(uzs),
      ]),
    );
    if (rows.length === 0) {
      throw new Error('ai_spend_counter UPSERT qator qaytarmadi');
    }
    return toTotals(rows[0]);
  }

  /** Kun qatori (PK lookup) yoki null — qator yo'q = hali xarajat yo'q. */
  async read(periodKey: string): Promise<AiSpendCounterRow | null> {
    assertPeriodKey(periodKey);
    const rows = rowsOf<RawRow>(
      await this.repo.query(AI_SPEND_READ_SQL, [periodKey]),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...toTotals(row),
      period_key: String(row.period_key),
      cost_uzs: toNumber(row.cost_uzs),
      calls: toNumber(row.calls),
    };
  }

  /** true — shu chaqiruv 80% bildirishnomasining "g'olibi" (birinchisi). */
  async markWarned(periodKey: string): Promise<boolean> {
    assertPeriodKey(periodKey);
    const rows = rowsOf<unknown>(
      await this.repo.query(AI_SPEND_MARK_WARNED_SQL, [periodKey]),
    );
    return rows.length > 0;
  }

  /** true — shu chaqiruv 100% bildirishnomasining "g'olibi" (birinchisi). */
  async markExceeded(periodKey: string): Promise<boolean> {
    assertPeriodKey(periodKey);
    const rows = rowsOf<unknown>(
      await this.repo.query(AI_SPEND_MARK_EXCEEDED_SQL, [periodKey]),
    );
    return rows.length > 0;
  }

  /** Shu kun shiftiga `extraUsd` qo'shadi (override_usd += extra). */
  async addOverride(
    periodKey: string,
    extraUsd: number,
  ): Promise<AiSpendTotals> {
    assertPeriodKey(periodKey);
    const rows = rowsOf<RawTotals>(
      await this.repo.query(AI_SPEND_ADD_OVERRIDE_SQL, [
        periodKey,
        roundMoney2(extraUsd),
      ]),
    );
    if (rows.length === 0) {
      throw new Error('ai_spend_counter override UPSERT qator qaytarmadi');
    }
    return toTotals(rows[0]);
  }
}
