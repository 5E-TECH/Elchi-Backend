import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ClaudeUsageRecord, ClaudeUsageSink } from '@app/common';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import {
  computeCacheSavedUsd,
  computeCostUsd,
  roundMoney2,
  roundUsd,
  safeTokenCount,
} from './ai-pricing';
import {
  addDaysYmd,
  isYmd,
  tashkentDay,
  tashkentDayStartIso,
  TASHKENT_DAY_SQL,
  TASHKENT_DAY_SQL_CREATED_AT,
} from './tashkent-day';

/** `ai.usage.summary` javobi (C7). */
export interface AiUsageSummary {
  total_usd: number;
  total_uzs: number;
  calls: number;
  cache_saved_usd: number;
  cache_saved_uzs: number;
  /** marketId/userId/traceId/draftId dan biri bo'sh qolgan chaqiruvlar. */
  meta_incomplete_calls: number;
  /** ai-confirm'dan keyin order_ids bog'langan chaqiruvlar. */
  linked_calls: number;
  by_feature: Array<{
    feature: string;
    calls: number;
    usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
  }>;
  by_day: Array<{ day: string; calls: number; usd: number; uzs: number }>;
}

/** Sana berilmasa — oxirgi 30 kun (Toshkent sanasi, bugun bilan). */
export const AI_USAGE_SUMMARY_DEFAULT_DAYS = 30;

const DEFAULT_USD_UZS_RATE = 12800;
const DEFAULT_ORDER_PRICE_UZS = 300;
const DIGITS_RE = /^\d{1,19}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * draft_id bo'yicha qatorlarga order_id'larni bog'laydi (lYVuADRE #18).
 * ⚠️ Mavjud order_ids SAQLANADI va yangilari QO'SHILADI (dublikatsiz):
 * bitta draft bir necha ai-confirm'da (masalan xato bo'lganlarini tuzatib
 * qayta yuborish) tasdiqlanishi mumkin — ustiga yozish oldingi bog'lanishni
 * yo'qotardi. market_id sharti — boshqa marketning draft'iga bog'lab
 * bo'lmaydi.
 */
export const AI_USAGE_LINK_ORDERS_SQL = `
  UPDATE ai_schema.ai_usage_log
  SET order_ids = ARRAY(
        SELECT DISTINCT x FROM unnest(order_ids || $2::bigint[]) AS x ORDER BY x
      ),
      "updatedAt" = now()
  WHERE draft_id = $1 AND market_id = $3
`;

/** Davr filtri — `"createdAt"` indeksini ishlatadigan (sargable) chegaralar. */
const RANGE_WHERE = `is_deleted = false AND "createdAt" >= $1::timestamptz AND "createdAt" < $2::timestamptz`;

export const AI_USAGE_SUMMARY_TOTALS_SQL = `
  SELECT COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS total_usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS total_uzs,
         COALESCE(SUM(cache_saved_usd), 0)::float8 AS cache_saved_usd,
         COALESCE(SUM(cache_saved_usd * usd_uzs_rate), 0)::float8 AS cache_saved_uzs,
         COUNT(*) FILTER (WHERE meta_incomplete)::int AS meta_incomplete_calls,
         COUNT(*) FILTER (WHERE cardinality(order_ids) > 0)::int AS linked_calls
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
`;

export const AI_USAGE_SUMMARY_BY_FEATURE_SQL = `
  SELECT feature,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
         COALESCE(SUM(cache_creation_tokens), 0)::float8 AS cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0)::float8 AS cache_read_tokens
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
  GROUP BY feature
  ORDER BY usd DESC, feature
`;

/** ⚠️ Kun bucketi FAQAT `TASHKENT_DAY_SQL` orqali (Asia/Tashkent). */
export const AI_USAGE_SUMMARY_BY_DAY_SQL = `
  SELECT to_char(${TASHKENT_DAY_SQL}, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
  GROUP BY ${TASHKENT_DAY_SQL}
  ORDER BY ${TASHKENT_DAY_SQL}
`;

// ─── (Celz3rKJ) "Moliyaviy balans → AI xarajat" paneli ───────────────────

/** request_area kesimi (order / bot / other). */
export const AI_USAGE_DASHBOARD_BY_AREA_SQL = `
  SELECT request_area AS area,
         COUNT(*)::int AS calls,
         COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
  GROUP BY request_area
  ORDER BY usd DESC, request_area
`;

/** feature kesimi (order_extract_multi, order_district, ...). */
export const AI_USAGE_DASHBOARD_BY_FEATURE_SQL = `
  SELECT feature,
         request_area AS area,
         COUNT(*)::int AS calls,
         COALESCE(SUM(steps), 0)::int AS steps,
         COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
  GROUP BY feature, request_area
  ORDER BY usd DESC, feature, request_area
`;

/** model kesimi (PieChart). */
export const AI_USAGE_DASHBOARD_BY_MODEL_SQL = `
  SELECT model,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS uzs
  FROM ai_schema.ai_usage_log
  WHERE ${RANGE_WHERE}
  GROUP BY model
  ORDER BY usd DESC, model
`;

/**
 * AI orqali YARATILGAN buyurtmalar (ai-confirm → `ai_order_draft_item`, bitta
 * buyurtma = bitta qator) — Toshkent kuni bo'yicha. ⚠️ Kun bucketi SQL'da,
 * `AT TIME ZONE 'Asia/Tashkent'` (frontendda "epoch + 5 soat" qilinmaydi).
 */
export const AI_ORDERS_BY_DAY_SQL = `
  SELECT to_char(${TASHKENT_DAY_SQL_CREATED_AT}, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS orders
  FROM ai_schema.ai_order_draft_item
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  GROUP BY ${TASHKENT_DAY_SQL_CREATED_AT}
  ORDER BY ${TASHKENT_DAY_SQL_CREATED_AT}
`;

/**
 * AI buyurtmalar ro'yxati (eng yangisi birinchi) + har draft xarajati.
 * Bitta draft'dan bir nechta buyurtma chiqishi mumkin — xarajat DRAFT
 * darajasida (`draft_cost_*`) va draft'dagi buyurtmalar soni bilan beriladi.
 */
export const AI_ORDERS_LIST_SQL = `
  SELECT i.order_id,
         i.draft_id,
         i.market_id,
         i.confirmed_by,
         i.edited_fields,
         i.created_at,
         d.model,
         d.source_kind,
         COALESCE(c.usd, 0)::float8 AS draft_cost_usd,
         COALESCE(c.uzs, 0)::float8 AS draft_cost_uzs,
         COALESCE(n.orders, 0)::int AS draft_orders
  FROM ai_schema.ai_order_draft_item i
  LEFT JOIN ai_schema.ai_order_draft d ON d.id = i.draft_id
  LEFT JOIN LATERAL (
    SELECT SUM(l.cost_usd) AS usd, SUM(l.cost_uzs) AS uzs
    FROM ai_schema.ai_usage_log l
    WHERE l.draft_id = i.draft_id AND l.is_deleted = false
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS orders
    FROM ai_schema.ai_order_draft_item x
    WHERE x.draft_id = i.draft_id
  ) n ON true
  WHERE i.created_at >= $1::timestamptz AND i.created_at < $2::timestamptz
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT $3
`;

export const AI_ORDERS_COUNT_SQL = `
  SELECT COUNT(*)::int AS total
  FROM ai_schema.ai_order_draft_item
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
`;

/** Kunlik seriya bo'sh kunlar bilan to'ldiriladigan eng uzun davr (kun). */
export const AI_DASHBOARD_FILL_MAX_DAYS = 366;
/** `ai.usage.ai_orders` sahifa chegarasi. */
export const AI_ORDERS_DEFAULT_LIMIT = 100;
export const AI_ORDERS_MAX_LIMIT = 100;

/** `ai.usage.dashboard` javobi (Celz3rKJ; BeePost `ai-usage/dashboard` shakli). */
export interface AiUsageDashboard {
  from: string;
  to: string;
  /** Hozirgi kurs (AI_USD_UZS_RATE) — yangi qatorlar shu bilan yoziladi. */
  usdUzsRate: number;
  summary: {
    totalCostUsd: number;
    totalCostUzs: number;
    totalCalls: number;
    cacheSavedUsd: number;
    cacheSavedUzs: number;
    metaIncompleteCalls: number;
    linkedCalls: number;
    /** AI orqali yaratilgan buyurtmalar (ai_order_draft_item). */
    aiOrderCount: number;
    /** `request_area = 'order'` xarajati. */
    orderCostUsd: number;
    orderCostUzs: number;
    /** O'rtacha: order-AI xarajati / AI buyurtmalar soni. */
    avgCostPerAiOrderUsd: number;
    avgCostPerAiOrderUzs: number;
  };
  byArea: Array<{
    area: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costUzs: number;
  }>;
  byFeature: Array<{
    feature: string;
    area: string;
    calls: number;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costUzs: number;
  }>;
  byModel: Array<{
    model: string;
    calls: number;
    costUsd: number;
    costUzs: number;
  }>;
  /** Toshkent kuni bo'yicha; davr ≤ 366 kun bo'lsa bo'sh kunlar 0 bilan. */
  dailySeries: Array<{
    day: string;
    costUsd: number;
    costUzs: number;
    calls: number;
    aiOrders: number;
  }>;
}

type RawRow = Record<string, unknown>;

/** pg SUM/COUNT natijasi (satr bo'lishi mumkin) → son. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** pg matn ustuni → satr (boshqa tip bo'lsa bo'sh satr). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowsOf(result: unknown): RawRow[] {
  return Array.isArray(result) ? (result as RawRow[]) : [];
}

/** UPDATE natijasidan ta'sirlangan qatorlar soni (TypeORM: [rows, count]). */
function affectedOf(result: unknown): number {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return 0;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'non-error throw';
}

function readPositive(
  config: ConfigService,
  key: string,
  fallback: number,
  allowZero = false,
): number {
  const n = Number(config.get<unknown>(key));
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? n : fallback;
}

/**
 * AI XARAJAT JURNALI (`ClaudeUsageSink`) — har Anthropic javobi uchun
 * `ai_schema.ai_usage_log` qatori (lYVuADRE).
 *
 * ⚠️ `record()` FIRE-AND-FORGET va HECH QACHON throw qilmaydi: DB tushsa
 * AI javobi baribir foydalanuvchiga boradi, faqat WARN
 * `ai_usage_persist_failed` va `persistFailures()` hisoblagichi oshadi
 * (`ai.status` → `usage_persist_failures`). Global shift bu jurnalga
 * TAYANMAYDI — u `AiBudgetService` / `ai_spend_counter` da, sinxron.
 *
 * ⚠️ MAXFIYLIK: mijoz matni yozilmaydi — faqat uzunlik, sha256, rasm soni.
 */
@Injectable()
export class AiUsageService implements ClaudeUsageSink {
  private readonly logger = new Logger(AiUsageService.name);
  private readonly usdUzsRate: number;
  private readonly orderPriceUzs: number;
  private failures = 0;

  constructor(
    @InjectRepository(AiUsageLog)
    private readonly repo: Repository<AiUsageLog>,
    config: ConfigService,
  ) {
    this.usdUzsRate = readPositive(
      config,
      'AI_USD_UZS_RATE',
      DEFAULT_USD_UZS_RATE,
    );
    this.orderPriceUzs = readPositive(
      config,
      'AI_ORDER_PRICE_UZS',
      DEFAULT_ORDER_PRICE_UZS,
      true,
    );
  }

  /**
   * Bitta javob xarajatini fon rejimida yozadi. Token yig'indisi 0 bo'lsa
   * (masalan tarmoq xatosidan keyingi bo'sh usage) qator YOZILMAYDI.
   */
  record(r: ClaudeUsageRecord): void {
    try {
      const totalTokens =
        safeTokenCount(r.inputTokens) +
        safeTokenCount(r.outputTokens) +
        safeTokenCount(r.cacheCreationTokens) +
        safeTokenCount(r.cacheReadTokens);
      if (totalTokens <= 0) return;

      void this.persist(r).catch((err: unknown) =>
        this.onPersistFailed(r, err),
      );
    } catch (err) {
      // Xavfsizlik to'ri — sink hech qachon ClaudeService'ni buzmaydi.
      this.onPersistFailed(r, err);
    }
  }

  /** Yozilmay qolgan jurnal qatorlari soni (jarayon boshidan beri). */
  persistFailures(): number {
    return this.failures;
  }

  private onPersistFailed(r: ClaudeUsageRecord, err: unknown): void {
    this.failures += 1;
    this.logger.warn(
      `ai_usage_persist_failed feature=${r?.feature ?? 'unknown'}: ${describeError(err)}`,
    );
  }

  private async persist(r: ClaudeUsageRecord): Promise<void> {
    await this.repo.save(this.repo.create(this.buildRow(r)));
  }

  /** Jurnal qatori — xarajat shu yerda (yozish paytidagi kurs bilan) hisoblanadi. */
  private buildRow(r: ClaudeUsageRecord): Partial<AiUsageLog> {
    const costUsd = roundUsd(computeCostUsd(r));
    const rate = roundMoney2(this.usdUzsRate);
    const feature = String(r.feature ?? '');

    // bigint/uuid ustunlariga yaroqsiz qiymat butun INSERT'ni yiqitardi —
    // bunday qiymat null bo'ladi va qator meta_incomplete deb belgilanadi.
    const marketId =
      typeof r.marketId === 'string' && DIGITS_RE.test(r.marketId.trim())
        ? r.marketId.trim()
        : null;
    const userId =
      typeof r.userId === 'string' && DIGITS_RE.test(r.userId.trim())
        ? r.userId.trim()
        : null;
    const draftId =
      typeof r.draftId === 'string' && UUID_RE.test(r.draftId.trim())
        ? r.draftId.trim()
        : null;
    const traceRaw = typeof r.traceId === 'string' ? r.traceId.trim() : '';
    const traceId = traceRaw ? traceRaw.slice(0, 64) : null;

    return {
      feature: feature.slice(0, 40),
      request_area: String(r.requestArea || 'other').slice(0, 16),
      model: String(r.model ?? '').slice(0, 64),
      input_tokens: safeTokenCount(r.inputTokens),
      output_tokens: safeTokenCount(r.outputTokens),
      cache_creation_tokens: safeTokenCount(r.cacheCreationTokens),
      cache_read_tokens: safeTokenCount(r.cacheReadTokens),
      steps: Math.max(1, safeTokenCount(r.steps)),
      stop_reason:
        typeof r.stopReason === 'string' ? r.stopReason.slice(0, 32) : null,
      outcome: String(r.outcome ?? 'ok').slice(0, 16),
      cost_usd: costUsd,
      cache_saved_usd: roundUsd(computeCacheSavedUsd(r)),
      cost_uzs: roundMoney2(costUsd * rate),
      usd_uzs_rate: rate,
      applied_price_uzs: feature.startsWith('order_extract_')
        ? roundMoney2(this.orderPriceUzs)
        : null,
      market_id: marketId,
      user_id: userId,
      draft_id: draftId,
      trace_id: traceId,
      meta_incomplete:
        marketId === null ||
        userId === null ||
        traceId === null ||
        draftId === null,
      input_chars: Number.isFinite(r.inputChars)
        ? Math.max(0, Math.round(r.inputChars))
        : null,
      input_sha256:
        typeof r.inputSha256 === 'string' &&
        /^[0-9a-f]{64}$/i.test(r.inputSha256)
          ? r.inputSha256.toLowerCase()
          : null,
      image_count: safeTokenCount(r.imageCount),
    };
  }

  /**
   * ai-confirm'dan keyin draft qatorlariga yaratilgan order_id'larni
   * bog'laydi (`ai.usage.link_orders`). Yaroqsiz kirish → `{updated: 0}`,
   * SQL ketmaydi.
   */
  async linkOrders(
    draftId: string,
    orderIds: string[],
    marketId: string,
  ): Promise<{ updated: number }> {
    const draft = typeof draftId === 'string' ? draftId.trim() : '';
    const market = typeof marketId === 'string' ? marketId.trim() : '';
    const ids = Array.isArray(orderIds)
      ? [
          ...new Set(
            orderIds
              .map((id) => String(id ?? '').trim())
              .filter((id) => DIGITS_RE.test(id)),
          ),
        ]
      : [];
    if (!UUID_RE.test(draft) || !DIGITS_RE.test(market) || ids.length === 0) {
      return { updated: 0 };
    }
    const result: unknown = await this.repo.query(AI_USAGE_LINK_ORDERS_SQL, [
      draft,
      ids,
      market,
    ]);
    return { updated: affectedOf(result) };
  }

  /**
   * `ai.usage.summary` — davr (Toshkent sanalari, ikkala chet ham kiradi)
   * bo'yicha xarajat. Berilmasa oxirgi 30 kun. SUM'lar `::float8` va
   * `Number()` orqali — satr konkatenatsiyasi bo'lmaydi.
   */
  async summary(from?: string, to?: string): Promise<AiUsageSummary> {
    const { params } = this.resolveRange(from, to);

    const totalsResult: unknown = await this.repo.query(
      AI_USAGE_SUMMARY_TOTALS_SQL,
      params,
    );
    const featureResult: unknown = await this.repo.query(
      AI_USAGE_SUMMARY_BY_FEATURE_SQL,
      params,
    );
    const dayResult: unknown = await this.repo.query(
      AI_USAGE_SUMMARY_BY_DAY_SQL,
      params,
    );
    const totals = rowsOf(totalsResult)[0] ?? {};

    return {
      total_usd: roundUsd(num(totals.total_usd)),
      total_uzs: roundMoney2(num(totals.total_uzs)),
      calls: num(totals.calls),
      cache_saved_usd: roundUsd(num(totals.cache_saved_usd)),
      cache_saved_uzs: roundMoney2(num(totals.cache_saved_uzs)),
      meta_incomplete_calls: num(totals.meta_incomplete_calls),
      linked_calls: num(totals.linked_calls),
      by_feature: rowsOf(featureResult).map((row) => ({
        feature: text(row.feature),
        calls: num(row.calls),
        usd: roundUsd(num(row.usd)),
        input_tokens: num(row.input_tokens),
        output_tokens: num(row.output_tokens),
        cache_creation_tokens: num(row.cache_creation_tokens),
        cache_read_tokens: num(row.cache_read_tokens),
      })),
      by_day: rowsOf(dayResult).map((row) => ({
        day: text(row.day),
        calls: num(row.calls),
        usd: roundUsd(num(row.usd)),
        uzs: roundMoney2(num(row.uzs)),
      })),
    };
  }

  /**
   * Davr — Toshkent sanalari, ikkala chet ham kiradi; berilmasa oxirgi 30
   * kun. `params` = [fromDay 00:00 +05, (toDay+1) 00:00 +05) — sargable.
   */
  private resolveRange(
    from?: string,
    to?: string,
  ): { fromDay: string; toDay: string; params: [string, string] } {
    const toDay = isYmd(to) ? to : tashkentDay(new Date());
    const fromDay = isYmd(from)
      ? from
      : addDaysYmd(toDay, -(AI_USAGE_SUMMARY_DEFAULT_DAYS - 1));
    return {
      fromDay,
      toDay,
      params: [
        tashkentDayStartIso(fromDay),
        tashkentDayStartIso(addDaysYmd(toDay, 1)),
      ],
    };
  }

  /**
   * (Celz3rKJ) "Moliyaviy balans → AI xarajat" paneli — `ai.usage.dashboard`.
   *
   * Barcha summalar jurnal qatoridagi `cost_usd` / `cost_uzs` dan (so'm
   * qiymati YOZISH paytidagi kurs bilan qotirilgan — kurs keyin o'zgarsa eski
   * xarajat qayta hisoblanmaydi). USD→so'm konvertatsiyasi faqat bitta joyda:
   * `buildRow()` (`AI_USD_UZS_RATE`); `usdUzsRate` — hozirgi kurs, ma'lumot
   * uchun. Kun bucketi SQL'da `AT TIME ZONE 'Asia/Tashkent'`.
   */
  async dashboard(from?: string, to?: string): Promise<AiUsageDashboard> {
    const { fromDay, toDay, params } = this.resolveRange(from, to);
    if (fromDay > toDay) {
      throw new BadRequestException(
        'from sanasi to sanasidan keyin bo‘lishi mumkin emas',
      );
    }

    const [totalsResult, areaResult, featureResult, modelResult, dayResult] =
      await Promise.all([
        this.repo.query(AI_USAGE_SUMMARY_TOTALS_SQL, params),
        this.repo.query(AI_USAGE_DASHBOARD_BY_AREA_SQL, params),
        this.repo.query(AI_USAGE_DASHBOARD_BY_FEATURE_SQL, params),
        this.repo.query(AI_USAGE_DASHBOARD_BY_MODEL_SQL, params),
        this.repo.query(AI_USAGE_SUMMARY_BY_DAY_SQL, params),
      ]);
    const aiOrdersResult: unknown = await this.repo.query(
      AI_ORDERS_BY_DAY_SQL,
      params,
    );
    const totals = rowsOf(totalsResult)[0] ?? {};

    const byArea = rowsOf(areaResult).map((row) => ({
      area: text(row.area),
      calls: num(row.calls),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      costUsd: roundUsd(num(row.usd)),
      costUzs: roundMoney2(num(row.uzs)),
    }));
    const byFeature = rowsOf(featureResult).map((row) => ({
      feature: text(row.feature),
      area: text(row.area),
      calls: num(row.calls),
      steps: num(row.steps),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      costUsd: roundUsd(num(row.usd)),
      costUzs: roundMoney2(num(row.uzs)),
    }));
    const byModel = rowsOf(modelResult).map((row) => ({
      model: text(row.model),
      calls: num(row.calls),
      costUsd: roundUsd(num(row.usd)),
      costUzs: roundMoney2(num(row.uzs)),
    }));

    // Kunlik seriya: xarajat + chaqiruvlar + AI buyurtmalar bitta o'qda.
    const days = new Map<
      string,
      {
        day: string;
        costUsd: number;
        costUzs: number;
        calls: number;
        aiOrders: number;
      }
    >();
    const ensureDay = (day: string) => {
      let entry = days.get(day);
      if (!entry) {
        entry = { day, costUsd: 0, costUzs: 0, calls: 0, aiOrders: 0 };
        days.set(day, entry);
      }
      return entry;
    };
    const spanDays =
      Math.round(
        (Date.parse(`${toDay}T00:00:00Z`) -
          Date.parse(`${fromDay}T00:00:00Z`)) /
          86_400_000,
      ) + 1;
    if (spanDays <= AI_DASHBOARD_FILL_MAX_DAYS) {
      for (let day = fromDay; day <= toDay; day = addDaysYmd(day, 1)) {
        ensureDay(day);
      }
    }
    for (const row of rowsOf(dayResult)) {
      const entry = ensureDay(text(row.day));
      entry.costUsd = roundUsd(num(row.usd));
      entry.costUzs = roundMoney2(num(row.uzs));
      entry.calls = num(row.calls);
    }
    let aiOrderCount = 0;
    for (const row of rowsOf(aiOrdersResult)) {
      const orders = num(row.orders);
      ensureDay(text(row.day)).aiOrders = orders;
      aiOrderCount += orders;
    }
    const dailySeries = [...days.values()].sort((a, b) =>
      a.day.localeCompare(b.day),
    );

    const orderArea = byArea.find((a) => a.area === 'order');
    const orderCostUsd = orderArea?.costUsd ?? 0;
    const orderCostUzs = orderArea?.costUzs ?? 0;

    return {
      from: fromDay,
      to: toDay,
      usdUzsRate: roundMoney2(this.usdUzsRate),
      summary: {
        totalCostUsd: roundUsd(num(totals.total_usd)),
        totalCostUzs: roundMoney2(num(totals.total_uzs)),
        totalCalls: num(totals.calls),
        cacheSavedUsd: roundUsd(num(totals.cache_saved_usd)),
        cacheSavedUzs: roundMoney2(num(totals.cache_saved_uzs)),
        metaIncompleteCalls: num(totals.meta_incomplete_calls),
        linkedCalls: num(totals.linked_calls),
        aiOrderCount,
        orderCostUsd,
        orderCostUzs,
        avgCostPerAiOrderUsd:
          aiOrderCount > 0 ? roundUsd(orderCostUsd / aiOrderCount) : 0,
        avgCostPerAiOrderUzs:
          aiOrderCount > 0 ? roundMoney2(orderCostUzs / aiOrderCount) : 0,
      },
      byArea,
      byFeature,
      byModel,
      dailySeries,
    };
  }

  /**
   * (Celz3rKJ) AI orqali yaratilgan buyurtmalar ro'yxati — `ai.usage.ai_orders`
   * (eng yangisi birinchi, `limit` ≤ 100). Buyurtma raqami/holati/summasi
   * gateway'da order-service'dan qo'shiladi.
   */
  async aiOrders(
    from?: string,
    to?: string,
    limit?: unknown,
  ): Promise<{
    from: string;
    to: string;
    total: number;
    limit: number;
    items: Array<{
      orderId: string;
      draftId: string;
      marketId: string;
      confirmedBy: string | null;
      editedFields: string[] | null;
      createdAt: string | null;
      model: string | null;
      sourceKind: string | null;
      draftCostUsd: number;
      draftCostUzs: number;
      draftOrders: number;
    }>;
  }> {
    const { fromDay, toDay, params } = this.resolveRange(from, to);
    if (fromDay > toDay) {
      throw new BadRequestException(
        'from sanasi to sanasidan keyin bo‘lishi mumkin emas',
      );
    }
    const parsed = Math.floor(Number(limit));
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, AI_ORDERS_MAX_LIMIT)
        : AI_ORDERS_DEFAULT_LIMIT;

    const [listResult, countResult] = await Promise.all([
      this.repo.query(AI_ORDERS_LIST_SQL, [...params, safeLimit]),
      this.repo.query(AI_ORDERS_COUNT_SQL, params),
    ]);
    const idText = (value: unknown): string | null =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;

    return {
      from: fromDay,
      to: toDay,
      total: num(rowsOf(countResult)[0]?.total),
      limit: safeLimit,
      items: rowsOf(listResult).map((row) => ({
        orderId: idText(row.order_id) ?? '',
        draftId: text(row.draft_id),
        marketId: idText(row.market_id) ?? '',
        confirmedBy: idText(row.confirmed_by),
        editedFields: Array.isArray(row.edited_fields)
          ? (row.edited_fields as unknown[]).map((f) => String(f))
          : null,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : typeof row.created_at === 'string'
              ? row.created_at
              : null,
        model: typeof row.model === 'string' ? row.model : null,
        sourceKind:
          typeof row.source_kind === 'string' ? row.source_kind : null,
        draftCostUsd: roundUsd(num(row.draft_cost_usd)),
        draftCostUzs: roundMoney2(num(row.draft_cost_uzs)),
        draftOrders: num(row.draft_orders),
      })),
    };
  }
}
