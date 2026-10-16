import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiBudgetService } from '../budget/ai-budget.service';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { globalAiOrderPriceUzs } from './ai-order-price';
import {
  CACHE_WRITE_MULTIPLIER,
  priceFor,
  roundMoney2,
  roundUsd,
} from './ai-pricing';
import {
  AI_DASHBOARD_FILL_MAX_DAYS,
  resolveTashkentRange,
} from './ai-usage.service';
import {
  addDaysYmd,
  TASHKENT_DAY_SQL,
  TASHKENT_DAY_SQL_CREATED_AT,
} from './tashkent-day';

/**
 * NFiXfmq6 — "AI xarajat va marja" hisoboti (`ai.usage.margin`).
 *
 * Savol: "AI bizga foyda keltiryaptimi?" — bitta ekranda, market kesimida:
 *  - CHARGED — mijozdan olinadigan narx: har yaratilgan AI buyurtmada
 *    muzlatilgan `ai_order_draft_item.applied_price_uzs` (market
 *    `ai_price_per_order` yoki global `AI_PRICE_PER_ORDER`, 0 — bepul);
 *  - COST — real Anthropic xarajati: `ai_usage_log.cost_uzs` (yozish
 *    paytidagi kurs bilan muzlatilgan);
 *  - MARGIN = charged − cost.
 * Ikkalasi AYNAN bir Toshkent-kun oynasida (`resolveTashkentRange`): xarajat
 * `"createdAt"`, charj `created_at` bo'yicha, bir xil `[from, to+1)` chegara.
 *
 * `request_area = 'internal'` — ichki AI: charj qilinmaydi, alohida xarajat
 * markazi (`internal`) sifatida ko'rsatiladi va market kesimiga kirmaydi.
 *
 * ⚠️ Barcha SUM/COUNT `::float8` / `::int` va `num()` (Number) orqali — pg
 * numeric satr bo'lib kelib, jami satr konkatenatsiyasiga aylanmaydi.
 * ⚠️ Kun bucketi FAQAT SQL'da (`AT TIME ZONE 'Asia/Tashkent'`).
 */

/** Davr + (ixtiyoriy) market filtri: $1 from, $2 to, $3 market_id|null. */
const USAGE_RANGE = `is_deleted = false AND "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz`;
const ITEM_RANGE = `created_at >= $1::timestamptz AND created_at < $2::timestamptz`;
const MARKET_FILTER = `($3::bigint IS NULL OR market_id = $3::bigint)`;

/** Market kesimi — real xarajat (ichki AI'siz). market_id NULL — bog'lanmagan. */
export const AI_MARGIN_COST_BY_MARKET_SQL = `
  SELECT market_id::text AS market_id,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE} AND request_area <> 'internal' AND ${MARKET_FILTER}
  GROUP BY market_id
`;

/** Market kesimi — charj (yaratilgan AI buyurtmalar, muzlatilgan narx). */
export const AI_MARGIN_CHARGED_BY_MARKET_SQL = `
  SELECT market_id::text AS market_id,
         COUNT(*)::int AS ai_orders,
         COUNT(*) FILTER (WHERE applied_price_uzs IS NULL)::int AS unpriced_orders,
         COUNT(*) FILTER (WHERE applied_price_uzs = 0)::int AS free_orders,
         COALESCE(SUM(applied_price_uzs), 0)::float8 AS charged_uzs
  FROM ai_schema.ai_order_draft_item
  WHERE ${ITEM_RANGE} AND ${MARKET_FILTER}
  GROUP BY market_id
`;

/** Ichki AI (charj qilinmaydi) — budjetdagi xarajat markazi. */
export const AI_MARGIN_INTERNAL_SQL = `
  SELECT COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE} AND request_area = 'internal' AND ${MARKET_FILTER}
`;

/** Feature kesimi — order_extract_image ALOHIDA qator (rasm matndan qimmat). */
export const AI_MARGIN_BY_FEATURE_SQL = `
  SELECT feature,
         request_area AS area,
         COUNT(*)::int AS calls,
         COALESCE(SUM(image_count), 0)::int AS images,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE} AND ${MARKET_FILTER}
  GROUP BY feature, request_area
  ORDER BY uzs DESC, feature, area
`;

/**
 * Kesh — model bo'yicha (yozish jarimasi model kirish narxiga bog'liq).
 * `saved_*` — qatorda muzlatilgan `cache_saved_usd` (cache_read × in × 0.9).
 * `creation_rate_tokens` — Σ(cache_creation × kurs), so'm jarimasi uchun.
 */
export const AI_MARGIN_CACHE_BY_MODEL_SQL = `
  SELECT model,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cache_read_tokens), 0)::float8 AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0)::float8 AS cache_creation_tokens,
         COALESCE(SUM(cache_saved_usd), 0)::float8 AS saved_usd,
         COALESCE(SUM(cache_saved_usd * usd_uzs_rate), 0)::float8 AS saved_uzs,
         COALESCE(SUM(cache_creation_tokens::numeric * usd_uzs_rate), 0)::float8 AS creation_rate_tokens
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE} AND ${MARKET_FILTER}
  GROUP BY model
`;

/** Kunlik xarajat (Toshkent kuni). */
export const AI_MARGIN_COST_BY_DAY_SQL = `
  SELECT to_char(${TASHKENT_DAY_SQL}, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE} AND ${MARKET_FILTER}
  GROUP BY ${TASHKENT_DAY_SQL}
  ORDER BY ${TASHKENT_DAY_SQL}
`;

/** Kunlik charj (Toshkent kuni). */
export const AI_MARGIN_CHARGED_BY_DAY_SQL = `
  SELECT to_char(${TASHKENT_DAY_SQL_CREATED_AT}, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS orders,
         COALESCE(SUM(applied_price_uzs), 0)::float8 AS charged_uzs
  FROM ai_schema.ai_order_draft_item
  WHERE ${ITEM_RANGE} AND ${MARKET_FILTER}
  GROUP BY ${TASHKENT_DAY_SQL_CREATED_AT}
  ORDER BY ${TASHKENT_DAY_SQL_CREATED_AT}
`;

/** Market × kun xarajati — "o'rtachadan N barobar" alerti uchun. */
export const AI_MARGIN_MARKET_DAY_COST_SQL = `
  SELECT market_id::text AS market_id,
         to_char(${TASHKENT_DAY_SQL}, 'YYYY-MM-DD') AS day,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${USAGE_RANGE}
    AND market_id IS NOT NULL
    AND request_area <> 'internal'
    AND ${MARKET_FILTER}
  GROUP BY market_id, ${TASHKENT_DAY_SQL}
`;

/** Alert chegaralari — HAMMASI konfiguratsiyadan (hardcode emas). */
export interface AiMarginThresholds {
  /** AI_CAP_WARN_RATIO — kunlik global shiftning ulushi. */
  capWarnRatio: number;
  /** AI_ALERT_CACHE_HIT_MIN_RATIO — kesh hit-rate pastki chegarasi. */
  cacheHitMinRatio: number;
  /** AI_ALERT_MARKET_SPIKE_FACTOR — market kunlik xarajati / o'z o'rtachasi. */
  marketSpikeFactor: number;
  /** AI_ALERT_MARGIN_MIN_UZS — market marjasi shundan past bo'lsa alert. */
  marginMinUzs: number;
}

export const AI_MARGIN_DEFAULT_THRESHOLDS: Readonly<AiMarginThresholds> =
  Object.freeze({
    capWarnRatio: 0.8,
    cacheHitMinRatio: 0.5,
    marketSpikeFactor: 5,
    marginMinUzs: 0,
  });

export type AiMarginAlertType =
  | 'daily_cap_warn'
  | 'negative_margin'
  | 'cache_broken'
  | 'cache_hit_low'
  | 'market_spike';

export interface AiMarginAlert {
  type: AiMarginAlertType;
  severity: 'warning' | 'critical';
  marketId: string | null;
  day: string | null;
  value: number;
  threshold: number;
  message: string;
}

export interface AiMarginMarketRow {
  /** null — marketga bog'lanmagan xarajat (meta_incomplete qatorlar). */
  marketId: string | null;
  chargedUzs: number;
  costUsd: number;
  costUzs: number;
  marginUzs: number;
  /** margin < 0 — frontend qizil ko'rsatadi. */
  marginNegative: boolean;
  calls: number;
  aiOrders: number;
  /** Narx ustunidan OLDIN yaratilgan (narxi noma'lum) AI buyurtmalar. */
  unpricedAiOrders: number;
  /** 0 so'mga (bepul) yaratilgan AI buyurtmalar. */
  freeAiOrders: number;
  avgCostPerAiOrderUzs: number;
  avgChargedPerAiOrderUzs: number;
}

export interface AiMarginReport {
  from: string;
  to: string;
  /** Filtr: faqat shu market (null — hamma). */
  marketId: string | null;
  pricing: { defaultPricePerOrderUzs: number };
  totals: {
    chargedUzs: number;
    /** Hamma real xarajat (ichki AI ham). */
    costUsd: number;
    costUzs: number;
    /** charged − costUzs (ichki AI ham ayriladi). */
    marginUzs: number;
    marginNegative: boolean;
    /** Ichki AI'siz xarajat (marketlar + bog'lanmagan). */
    chargeableCostUzs: number;
    /** charged − chargeableCostUzs. */
    orderMarginUzs: number;
    calls: number;
    aiOrders: number;
    unpricedAiOrders: number;
    freeAiOrders: number;
    avgCostPerAiOrderUzs: number;
    avgChargedPerAiOrderUzs: number;
  };
  cache: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Kesh tejagan summa: cache_read × in × 0.9 / 1M (× kurs) — cache_read ga proporsional. */
    cacheSavedUsd: number;
    cacheSavedUzs: number;
    /** Kesh YOZISH qo'shimchasi: cache_creation × in × 0.25 / 1M (× kurs). */
    cacheWriteCostUsd: number;
    cacheWriteCostUzs: number;
    /** Sof tejov = tejov − yozish qo'shimchasi (manfiy bo'lishi mumkin). */
    cacheNetSavedUsd: number;
    cacheNetSavedUzs: number;
    /** cache_read / (cache_read + cache_creation); kesh ishlatilmagan — null. */
    hitRate: number | null;
  };
  /** request_area = 'internal' — charj qilinmaydi, budjet xarajat markazi. */
  internal: { calls: number; costUsd: number; costUzs: number; charged: false };
  byMarket: AiMarginMarketRow[];
  byFeature: Array<{
    feature: string;
    area: string;
    calls: number;
    images: number;
    costUsd: number;
    costUzs: number;
    avgCostPerCallUzs: number;
    /** false — ichki AI (charj qilinmaydi). */
    charged: boolean;
  }>;
  /** Toshkent kuni; davr ≤ 366 kun bo'lsa bo'sh kunlar 0 bilan. */
  dailySeries: Array<{
    day: string;
    chargedUzs: number;
    costUzs: number;
    marginUzs: number;
    calls: number;
    aiOrders: number;
  }>;
  alerts: AiMarginAlert[];
  thresholds: AiMarginThresholds;
}

type RawRow = Record<string, unknown>;

/** pg SUM/COUNT natijasi (satr bo'lishi mumkin) → son (Number). */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idText(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

function rowsOf(result: unknown): RawRow[] {
  return Array.isArray(result) ? (result as RawRow[]) : [];
}

const TOKENS_PER_UNIT = 1_000_000;
/** Kesh yozish narxining oddiy kirishdan ORTIQ qismi (1.25 − 1). */
const CACHE_WRITE_EXTRA = CACHE_WRITE_MULTIPLIER - 1;

export interface AiMarginRawInput {
  fromDay: string;
  toDay: string;
  marketId: string | null;
  defaultPricePerOrderUzs: number;
  thresholds: AiMarginThresholds;
  /** `AiBudgetService.status()` (bugungi kun); o'qib bo'lmasa null. */
  capStatus: { state: string; ratio: number; period_key: string } | null;
  costByMarket: unknown;
  chargedByMarket: unknown;
  internal: unknown;
  byFeature: unknown;
  cacheByModel: unknown;
  costByDay: unknown;
  chargedByDay: unknown;
  marketDayCost: unknown;
}

function money(value: number): number {
  return roundMoney2(value);
}

function avg(total: number, count: number): number {
  return count > 0 ? money(total / count) : 0;
}

/**
 * Xom SQL natijalaridan hisobot — SOF funksiya (DB'siz unit-test qilinadi).
 */
export function buildAiMarginReport(input: AiMarginRawInput): AiMarginReport {
  const t = input.thresholds;

  // ─── Market kesimi: xarajat ∪ charj ───
  const markets = new Map<string, AiMarginMarketRow>();
  const keyOf = (id: string | null) => id ?? '';
  const ensure = (id: string | null): AiMarginMarketRow => {
    let row = markets.get(keyOf(id));
    if (!row) {
      row = {
        marketId: id,
        chargedUzs: 0,
        costUsd: 0,
        costUzs: 0,
        marginUzs: 0,
        marginNegative: false,
        calls: 0,
        aiOrders: 0,
        unpricedAiOrders: 0,
        freeAiOrders: 0,
        avgCostPerAiOrderUzs: 0,
        avgChargedPerAiOrderUzs: 0,
      };
      markets.set(keyOf(id), row);
    }
    return row;
  };
  for (const r of rowsOf(input.costByMarket)) {
    const row = ensure(idText(r.market_id));
    row.calls += num(r.calls);
    row.costUsd += num(r.usd);
    row.costUzs += num(r.uzs);
  }
  for (const r of rowsOf(input.chargedByMarket)) {
    const row = ensure(idText(r.market_id));
    row.aiOrders += num(r.ai_orders);
    row.unpricedAiOrders += num(r.unpriced_orders);
    row.freeAiOrders += num(r.free_orders);
    row.chargedUzs += num(r.charged_uzs);
  }
  const byMarket = [...markets.values()]
    .map((row) => {
      const chargedUzs = money(row.chargedUzs);
      const costUzs = money(row.costUzs);
      const marginUzs = money(chargedUzs - costUzs);
      return {
        ...row,
        chargedUzs,
        costUsd: roundUsd(row.costUsd),
        costUzs,
        marginUzs,
        marginNegative: marginUzs < 0,
        avgCostPerAiOrderUzs: avg(costUzs, row.aiOrders),
        avgChargedPerAiOrderUzs: avg(chargedUzs, row.aiOrders),
      };
    })
    .sort(
      (a, b) =>
        b.costUzs - a.costUzs ||
        keyOf(a.marketId).localeCompare(keyOf(b.marketId)),
    );

  // ─── Ichki AI ───
  const internalRow = rowsOf(input.internal)[0] ?? {};
  const internal = {
    calls: num(internalRow.calls),
    costUsd: roundUsd(num(internalRow.usd)),
    costUzs: money(num(internalRow.uzs)),
    charged: false as const,
  };

  // ─── Jami ───
  const sum = (pick: (r: AiMarginMarketRow) => number) =>
    byMarket.reduce((acc, r) => acc + pick(r), 0);
  const chargedUzs = money(sum((r) => r.chargedUzs));
  const chargeableCostUzs = money(sum((r) => r.costUzs));
  const chargeableCostUsd = sum((r) => r.costUsd);
  const costUzs = money(chargeableCostUzs + internal.costUzs);
  const aiOrders = sum((r) => r.aiOrders);
  const marginUzs = money(chargedUzs - costUzs);
  const totals = {
    chargedUzs,
    costUsd: roundUsd(chargeableCostUsd + internal.costUsd),
    costUzs,
    marginUzs,
    marginNegative: marginUzs < 0,
    chargeableCostUzs,
    orderMarginUzs: money(chargedUzs - chargeableCostUzs),
    calls: sum((r) => r.calls) + internal.calls,
    aiOrders,
    unpricedAiOrders: sum((r) => r.unpricedAiOrders),
    freeAiOrders: sum((r) => r.freeAiOrders),
    avgCostPerAiOrderUzs: avg(chargeableCostUzs, aiOrders),
    avgChargedPerAiOrderUzs: avg(chargedUzs, aiOrders),
  };

  // ─── Feature kesimi ───
  const byFeature = rowsOf(input.byFeature).map((r) => {
    const calls = num(r.calls);
    const costUzs = money(num(r.uzs));
    const area = text(r.area);
    return {
      feature: text(r.feature),
      area,
      calls,
      images: num(r.images),
      costUsd: roundUsd(num(r.usd)),
      costUzs,
      avgCostPerCallUzs: avg(costUzs, calls),
      charged: area !== 'internal',
    };
  });

  // ─── Kesh ───
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cacheSavedUsd = 0;
  let cacheSavedUzs = 0;
  let cacheWriteCostUsd = 0;
  let cacheWriteCostUzs = 0;
  for (const r of rowsOf(input.cacheByModel)) {
    const inPrice = priceFor(text(r.model)).in;
    const creation = num(r.cache_creation_tokens);
    cacheReadTokens += num(r.cache_read_tokens);
    cacheCreationTokens += creation;
    cacheSavedUsd += num(r.saved_usd);
    cacheSavedUzs += num(r.saved_uzs);
    cacheWriteCostUsd +=
      (creation * inPrice * CACHE_WRITE_EXTRA) / TOKENS_PER_UNIT;
    cacheWriteCostUzs +=
      (num(r.creation_rate_tokens) * inPrice * CACHE_WRITE_EXTRA) /
      TOKENS_PER_UNIT;
  }
  const cacheDenominator = cacheReadTokens + cacheCreationTokens;
  const hitRate =
    cacheDenominator > 0
      ? Math.round((cacheReadTokens / cacheDenominator) * 10_000) / 10_000
      : null;
  const cache = {
    cacheReadTokens,
    cacheCreationTokens,
    cacheSavedUsd: roundUsd(cacheSavedUsd),
    cacheSavedUzs: money(cacheSavedUzs),
    cacheWriteCostUsd: roundUsd(cacheWriteCostUsd),
    cacheWriteCostUzs: money(cacheWriteCostUzs),
    cacheNetSavedUsd: roundUsd(cacheSavedUsd - cacheWriteCostUsd),
    cacheNetSavedUzs: money(cacheSavedUzs - cacheWriteCostUzs),
    hitRate,
  };

  // ─── Kunlik seriya ───
  const days = new Map<
    string,
    {
      day: string;
      chargedUzs: number;
      costUzs: number;
      marginUzs: number;
      calls: number;
      aiOrders: number;
    }
  >();
  const ensureDay = (day: string) => {
    let entry = days.get(day);
    if (!entry) {
      entry = {
        day,
        chargedUzs: 0,
        costUzs: 0,
        marginUzs: 0,
        calls: 0,
        aiOrders: 0,
      };
      days.set(day, entry);
    }
    return entry;
  };
  const spanDays =
    Math.round(
      (Date.parse(`${input.toDay}T00:00:00Z`) -
        Date.parse(`${input.fromDay}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (spanDays <= AI_DASHBOARD_FILL_MAX_DAYS) {
    for (let d = input.fromDay; d <= input.toDay; d = addDaysYmd(d, 1)) {
      ensureDay(d);
    }
  }
  for (const r of rowsOf(input.costByDay)) {
    const entry = ensureDay(text(r.day));
    entry.calls = num(r.calls);
    entry.costUzs = money(num(r.uzs));
  }
  for (const r of rowsOf(input.chargedByDay)) {
    const entry = ensureDay(text(r.day));
    entry.aiOrders = num(r.orders);
    entry.chargedUzs = money(num(r.charged_uzs));
  }
  const dailySeries = [...days.values()]
    .map((d) => ({ ...d, marginUzs: money(d.chargedUzs - d.costUzs) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // ─── Alertlar ───
  const alerts: AiMarginAlert[] = [];
  const cap = input.capStatus;
  if (cap && (cap.state === 'warn' || cap.state === 'exceeded')) {
    alerts.push({
      type: 'daily_cap_warn',
      severity: cap.state === 'exceeded' ? 'critical' : 'warning',
      marketId: null,
      day: cap.period_key,
      value: num(cap.ratio),
      threshold: t.capWarnRatio,
      message:
        cap.state === 'exceeded'
          ? 'Kunlik AI shifti tugadi — AI parse to‘xtatilgan'
          : `Kunlik AI shiftining ${Math.round(num(cap.ratio) * 100)}% sarflandi`,
    });
  }
  for (const row of byMarket) {
    if (row.marketId === null) continue;
    const allFree = row.aiOrders > 0 && row.freeAiOrders === row.aiOrders;
    if (!allFree && row.marginUzs < t.marginMinUzs) {
      alerts.push({
        type: 'negative_margin',
        severity: 'warning',
        marketId: row.marketId,
        day: null,
        value: row.marginUzs,
        threshold: t.marginMinUzs,
        message: `Market #${row.marketId} marjasi ${row.marginUzs} so‘m`,
      });
    }
  }
  if (totals.calls > 0 && cacheReadTokens === 0) {
    alerts.push({
      type: 'cache_broken',
      severity: 'critical',
      marketId: null,
      day: null,
      value: 0,
      threshold: t.cacheHitMinRatio,
      message:
        'Prompt kesh ishlamayapti (cache_read = 0) — xarajat ~4 barobar oshadi',
    });
  } else if (hitRate !== null && hitRate < t.cacheHitMinRatio) {
    alerts.push({
      type: 'cache_hit_low',
      severity: 'warning',
      marketId: null,
      day: null,
      value: hitRate,
      threshold: t.cacheHitMinRatio,
      message: `Kesh hit-rate ${Math.round(hitRate * 100)}% — chegara ${Math.round(t.cacheHitMinRatio * 100)}%`,
    });
  }
  // Market kunlik xarajati o'zining BOSHQA faol kunlari o'rtachasidan
  // `marketSpikeFactor` barobar oshsa (har market uchun eng so'nggi kun).
  const perMarket = new Map<string, Array<{ day: string; uzs: number }>>();
  for (const r of rowsOf(input.marketDayCost)) {
    const id = idText(r.market_id);
    const uzs = num(r.uzs);
    if (!id || uzs <= 0) continue;
    const list = perMarket.get(id) ?? [];
    list.push({ day: text(r.day), uzs });
    perMarket.set(id, list);
  }
  for (const [marketId, list] of [...perMarket.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (list.length < 2) continue;
    const total = list.reduce((acc, d) => acc + d.uzs, 0);
    const spike = [...list]
      .sort((a, b) => b.day.localeCompare(a.day))
      .find((d) => {
        const baseline = (total - d.uzs) / (list.length - 1);
        return baseline > 0 && d.uzs > t.marketSpikeFactor * baseline;
      });
    if (spike) {
      const baseline = (total - spike.uzs) / (list.length - 1);
      alerts.push({
        type: 'market_spike',
        severity: 'warning',
        marketId,
        day: spike.day,
        value: money(spike.uzs),
        threshold: money(t.marketSpikeFactor * baseline),
        message: `Market #${marketId} ${spike.day} kuni AI xarajati o‘rtachadan ${Math.round((spike.uzs / baseline) * 10) / 10} barobar ko‘p`,
      });
    }
  }

  return {
    from: input.fromDay,
    to: input.toDay,
    marketId: input.marketId,
    pricing: { defaultPricePerOrderUzs: money(input.defaultPricePerOrderUzs) },
    totals,
    cache,
    internal,
    byMarket,
    byFeature,
    dailySeries,
    alerts,
    thresholds: { ...t },
  };
}

const DIGITS_RE = /^\d{1,19}$/;

function readNumber(
  config: Pick<ConfigService, 'get'>,
  key: string,
  fallback: number,
  valid: (n: number) => boolean,
): number {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && valid(n) ? n : fallback;
}

/** Alert chegaralari konfiguratsiyadan (env), sukutlar — `AI_MARGIN_DEFAULT_THRESHOLDS`. */
export function readAiMarginThresholds(
  config: Pick<ConfigService, 'get'>,
): AiMarginThresholds {
  const d = AI_MARGIN_DEFAULT_THRESHOLDS;
  return {
    capWarnRatio: readNumber(
      config,
      'AI_CAP_WARN_RATIO',
      d.capWarnRatio,
      (n) => n > 0 && n < 1,
    ),
    cacheHitMinRatio: readNumber(
      config,
      'AI_ALERT_CACHE_HIT_MIN_RATIO',
      d.cacheHitMinRatio,
      (n) => n >= 0 && n <= 1,
    ),
    marketSpikeFactor: readNumber(
      config,
      'AI_ALERT_MARKET_SPIKE_FACTOR',
      d.marketSpikeFactor,
      (n) => n > 1,
    ),
    marginMinUzs: readNumber(
      config,
      'AI_ALERT_MARGIN_MIN_UZS',
      d.marginMinUzs,
      () => true,
    ),
  };
}

/**
 * `ai.usage.margin` — NFiXfmq6 "AI xarajat va marja" paneli. Rol tekshiruvi
 * gateway'da (SUPERADMIN/ADMIN — hamma yoki `marketId`; MARKET — faqat o'zi).
 */
@Injectable()
export class AiMarginService {
  private readonly logger = new Logger(AiMarginService.name);
  private readonly thresholds: AiMarginThresholds;
  private readonly defaultPriceUzs: number;

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly repo: Repository<AiUsageLog>,
    config: ConfigService,
    @Optional() private readonly budget?: AiBudgetService,
  ) {
    this.thresholds = readAiMarginThresholds(config);
    this.defaultPriceUzs = globalAiOrderPriceUzs(config);
  }

  async margin(
    from?: unknown,
    to?: unknown,
    marketId?: unknown,
  ): Promise<AiMarginReport> {
    const { fromDay, toDay, params } = resolveTashkentRange(
      typeof from === 'string' ? from : undefined,
      typeof to === 'string' ? to : undefined,
    );
    if (fromDay > toDay) {
      throw new BadRequestException(
        'from sanasi to sanasidan keyin bo‘lishi mumkin emas',
      );
    }
    const rawMarket =
      typeof marketId === 'string' || typeof marketId === 'number'
        ? String(marketId).trim()
        : '';
    if (rawMarket && !DIGITS_RE.test(rawMarket)) {
      throw new BadRequestException('market_id noto‘g‘ri');
    }
    const market = rawMarket || null;
    const p = [...params, market];

    const [
      costByMarket,
      chargedByMarket,
      internal,
      byFeature,
      cacheByModel,
      costByDay,
      chargedByDay,
      marketDayCost,
    ]: unknown[] = await Promise.all([
      this.repo.query(AI_MARGIN_COST_BY_MARKET_SQL, p),
      this.repo.query(AI_MARGIN_CHARGED_BY_MARKET_SQL, p),
      this.repo.query(AI_MARGIN_INTERNAL_SQL, p),
      this.repo.query(AI_MARGIN_BY_FEATURE_SQL, p),
      this.repo.query(AI_MARGIN_CACHE_BY_MODEL_SQL, p),
      this.repo.query(AI_MARGIN_COST_BY_DAY_SQL, p),
      this.repo.query(AI_MARGIN_CHARGED_BY_DAY_SQL, p),
      this.repo.query(AI_MARGIN_MARKET_DAY_COST_SQL, p),
    ]);

    return buildAiMarginReport({
      fromDay,
      toDay,
      marketId: market,
      defaultPricePerOrderUzs: this.defaultPriceUzs,
      thresholds: this.thresholds,
      capStatus: await this.readCap(),
      costByMarket,
      chargedByMarket,
      internal,
      byFeature,
      cacheByModel,
      costByDay,
      chargedByDay,
      marketDayCost,
    });
  }

  /** Bugungi shift holati; o'qib bo'lmasa null (hisobot yiqilmaydi). */
  private async readCap(): Promise<AiMarginRawInput['capStatus']> {
    if (!this.budget) return null;
    try {
      const s = await this.budget.status();
      return { state: s.state, ratio: s.ratio, period_key: s.period_key };
    } catch (err) {
      this.logger.warn(
        `ai_margin_cap_read_failed: ${err instanceof Error ? err.message.slice(0, 200) : 'non-error'}`,
      );
      return null;
    }
  }
}
