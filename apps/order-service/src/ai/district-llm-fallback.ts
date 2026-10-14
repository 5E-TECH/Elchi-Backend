import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_DISTRICT_MAX_ITEMS,
  AI_DISTRICT_SHORTLIST_SIZE,
  AI_MIN_BUDGET_MS,
  bestSubstringSim,
  normGeo,
  rmqSend,
  simRatio,
  type AiDistrictPickRequest,
  type AiDistrictPickResponse,
  type AiDistrictPoolEntry,
  type AiRequester,
} from '@app/common';
import type {
  DistrictTextQuery,
  DistrictTextResolution,
} from './ai-preview.types';

/**
 * TUMAN LLM FALLBACK'I (5Z1ZvvzE) — deterministik rezolver
 * (`logistics.district.resolve_by_text`) hal qila olmagan holatda (imlo
 * xatosi, tuman manzil ichida, viloyat aytilmagan) arzon modeldan INDEKS.
 * Bu qatlam BO'LMASA ham tizim ishlaydi — operator qo'lda tanlaydi.
 *
 * Qulflar (BeePost `resolveDistrictWithLlm` :1339-1383 + Elchi):
 *  1. RISKY bo'lmasa (tuman aniq) — LLM UMUMAN chaqirilmaydi (TC1).
 *     Nomzodlar bor (operator tanlaydi) va ataylab to'xtatilgan holatlar
 *     (`cross_region_confusable`, `sato_mismatch`) ham LLM'ga BERILMAYDI —
 *     aks holda rezolverning R2/R3 qulfi ma'nosiz bo'lardi.
 *  2. VILOYAT QULFI: rezolver viloyatni aniqlagan bo'lsa (`region_id`) —
 *     FAQAT o'sha viloyatning TO'LIQ pooli (shortlist emas); LLM tanlovi
 *     boshqa viloyatga hech qachon o'tmaydi (TC2, TC3).
 *  3. Viloyat noaniq — butun bazadan top-`AI_DISTRICT_SHORTLIST_SIZE` (45,
 *     ≥40 — TC7), bo'sag'a filtrisiz (to'g'ri tuman past ball bilan tushib
 *     qolmasin).
 *  4. Pool `ORDER BY id` — bir xil kirish = bayt darajasida bir xil prompt (TC8).
 *  5. Model faqat INDEKS: `k<1 || k>pool.length` RAD (TC4), ID kod tomonda
 *     `pool[k-1]` (TC5); `0` — o'zgarishsiz (TC3).
 *  6. SOATO darvozasi QAT'IY: tanlangan tuman `sato_code` i viloyat
 *     `sato_code` i bilan boshlanmasa YOKI kod yo'q bo'lsa — RAD (TC6).
 *  7. AI o'chiq / limit / tarmoq / kesilgan — jimgina deterministik natija (TC11-12).
 */

export const DISTRICT_PICKER = Symbol('DISTRICT_PICKER');

export interface DistrictPicks {
  picks: { item_index: number; choice: number }[];
}

export interface DistrictPicker {
  /** null — AI ishlamadi; chaqiruvchi deterministik natijani qoldiradi. */
  pick(req: AiDistrictPickRequest): Promise<DistrictPicks | null>;
}

export class NoopDistrictPicker implements DistrictPicker {
  pick(): Promise<DistrictPicks | null> {
    return Promise.resolve(null);
  }
}

const PICK_MAX_TIMEOUT_MS = 12_000;
const PICK_DEADLINE_RESERVE_MS = 1_000;

/**
 * `ai.district.pick` RMQ adapteri. ⚠️ `retries: 0` MAJBURIY (har qayta
 * yuborish Anthropic'ni yana chaqiradi — ai-rpc-no-retry.guard.spec.ts).
 */
@Injectable()
export class RmqDistrictPicker implements DistrictPicker {
  private readonly logger = new Logger(RmqDistrictPicker.name);

  constructor(@Inject('AI') private readonly aiClient: ClientProxy) {}

  async pick(req: AiDistrictPickRequest): Promise<DistrictPicks | null> {
    const left = Number(req?.deadline_at) - Date.now();
    if (!Number.isFinite(left) || left < AI_MIN_BUDGET_MS) {
      this.logger.warn(
        `ai.district.pick o'tkazib yuborildi — muddat yetarli emas (${Number.isFinite(left) ? left : 'NaN'} ms)`,
      );
      return null;
    }
    try {
      const res = await rmqSend<AiDistrictPickResponse>(
        this.aiClient,
        { cmd: 'ai.district.pick' },
        req,
        {
          timeoutMs: Math.min(
            PICK_MAX_TIMEOUT_MS,
            req.deadline_at - Date.now() - PICK_DEADLINE_RESERVE_MS,
          ),
          retries: 0,
        },
      );
      if (res?.ok === true && Array.isArray(res.picks)) {
        return { picks: res.picks };
      }
      this.logger.warn(
        `ai.district.pick natijasiz: ${res?.ok === false ? String(res.reason) : "noto'g'ri javob"}`,
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `ai.district.pick xato: ${(err as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
  }
}

/** Logistics `district.find_all` qatorining kerakli qismi. */
export interface DistrictRow {
  id: string;
  name: string;
  sato_code: string | null;
  region_id: string;
  region_name: string;
  region_sato: string | null;
}

/** Rezolver ataylab to'xtatgan holatlar — LLM'ga BERILMAYDI. */
const HARD_STOP_REASONS = new Set(['cross_region_confusable', 'sato_mismatch']);

const txt = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

function compareId(a: string, b: string): number {
  // bigint ID'lar: avval uzunlik, keyin leksikografik — raqamli tartib.
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** LLM'ga berishga arziydimi (risky + nomzodsiz + ataylab to'xtatilmagan). */
export function isRiskyResolution(
  res: DistrictTextResolution | null | undefined,
  query: DistrictTextQuery | null | undefined,
): boolean {
  if (txt(res?.district_id)) return false;
  if (Array.isArray(res?.candidates) && res.candidates.length > 0) return false;
  if (res?.reason && HARD_STOP_REASONS.has(res.reason)) return false;
  return placeTextOf(query) !== '';
}

/** Modelga ketadigan joy matni: tuman → to'liq manzil → manzil. */
export function placeTextOf(
  query: DistrictTextQuery | null | undefined,
): string {
  const parts = [query?.district_name, query?.full_address, query?.address]
    .map(txt)
    .filter(Boolean);
  return [...new Set(parts)].join(' | ').slice(0, 300);
}

/** Matn va tuman nomi o'xshashligi (0..1) — shortlist balli. */
function placeScore(texts: string[], districtName: string): number {
  const name = normGeo(districtName);
  if (!name) return 0;
  const skeleton = name.replace(/\s+/g, '');
  let best = 0;
  for (const t of texts) {
    best = Math.max(best, simRatio(t, name));
    for (const token of t.split(/\s+/)) {
      best = Math.max(best, simRatio(token, name));
    }
    best = Math.max(best, bestSubstringSim(t.replace(/\s+/g, ''), skeleton));
    if (best === 1) return 1;
  }
  return best;
}

/**
 * Pool: viloyat qulflangan bo'lsa — o'sha viloyatning TO'LIQ ro'yxati;
 * aks holda shortlist. Har ikki holatda yakuniy tartib `ORDER BY id`.
 */
export function buildDistrictPool(
  res: DistrictTextResolution | null | undefined,
  query: DistrictTextQuery | null | undefined,
  rows: readonly DistrictRow[],
): { trustRegion: boolean; pool: DistrictRow[] } {
  const lockedRegion = txt(res?.region_id);
  if (lockedRegion) {
    return {
      trustRegion: true,
      pool: rows
        .filter((r) => r.region_id === lockedRegion)
        .sort((a, b) => compareId(a.id, b.id)),
    };
  }
  const texts = [query?.district_name, query?.full_address, query?.address]
    .map((v) => normGeo(txt(v)))
    .filter(Boolean);
  const scored = rows
    .map((row) => ({ row, score: placeScore(texts, row.name) }))
    .sort((a, b) => b.score - a.score || compareId(a.row.id, b.row.id))
    .slice(0, AI_DISTRICT_SHORTLIST_SIZE)
    .map((x) => x.row);
  return {
    trustRegion: false,
    pool: scored.sort((a, b) => compareId(a.id, b.id)),
  };
}

/** Modelga ko'rinadigan pool — 1-asosli indeks, faqat NOMLAR (ID yo'q). */
export function toPoolEntries(
  pool: readonly DistrictRow[],
): AiDistrictPoolEntry[] {
  return pool.map((row, i) => ({
    index: i + 1,
    region_name: row.region_name,
    district_name: row.name,
  }));
}

/**
 * Model tanlovini qo'llaydi. `null` — rad etildi yoki 0 (deterministik
 * natija o'zgarmaydi).
 */
export function applyDistrictChoice(
  res: DistrictTextResolution | null,
  pool: readonly DistrictRow[],
  trustRegion: boolean,
  choice: unknown,
): DistrictTextResolution | null {
  if (
    typeof choice !== 'number' ||
    !Number.isInteger(choice) ||
    choice < 1 ||
    choice > pool.length
  ) {
    return null;
  }
  const entry = pool[choice - 1];
  // Viloyat qulfi (pool shunday qurilgan, baribir qayta tekshiriladi).
  if (trustRegion && entry.region_id !== txt(res?.region_id)) return null;
  // SOATO darvozasi — kod yo'q bo'lsa ham RAD (fail-closed).
  if (
    !entry.sato_code ||
    !entry.region_sato ||
    !entry.sato_code.startsWith(entry.region_sato)
  ) {
    return null;
  }
  return {
    region_id: entry.region_id,
    district_id: entry.id,
    region_label: res?.region_label ?? entry.region_name,
    district_label: `${res?.region_label ?? entry.region_name}, ${entry.name}`,
    region_name: entry.region_name,
    district_name: entry.name,
    region_given: res?.region_given === true,
    candidates: [],
    llm_picked: true,
  };
}

/** bigint ID: satr yoki son (pg bigint satr bo'lib keladi). */
const idText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** `logistics.district.find_all` javobidan qatorlar (o'chirilganlar tashlanadi). */
export function districtRowsOf(reply: unknown): DistrictRow[] {
  const data = (reply as { data?: unknown } | null)?.data ?? reply;
  if (!Array.isArray(data)) return [];
  const rows: DistrictRow[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.isDeleted === true || raw.is_deleted === true) continue;
    const region = (raw.region ?? {}) as Record<string, unknown>;
    const id = idText(raw.id);
    const regionId = idText(raw.region_id ?? region.id);
    const name = txt(raw.name);
    if (!/^\d+$/.test(id) || !/^\d+$/.test(regionId) || !name) continue;
    rows.push({
      id,
      name,
      sato_code: txt(raw.sato_code) || null,
      region_id: regionId,
      region_name: txt(region.name),
      region_sato: txt(region.sato_code) || null,
    });
  }
  return rows.sort((a, b) => compareId(a.id, b.id));
}

const LOGISTICS_LIST_TIMEOUT_MS = 6_000;
/** Tuman ro'yxati keshi — 10 daqiqa (181 qator, kamdan-kam o'zgaradi). */
export const DISTRICT_LIST_CACHE_MS = 600_000;

export interface DistrictFallbackContext {
  market_id: string;
  requester: AiRequester;
  trace_id: string | null;
  draft_id: string | null;
  deadline_at: number;
}

@Injectable()
export class DistrictLlmFallbackService {
  private readonly logger = new Logger(DistrictLlmFallbackService.name);
  private cache: { at: number; rows: DistrictRow[] } | null = null;

  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Optional()
    @Inject(DISTRICT_PICKER)
    private readonly picker: DistrictPicker = new NoopDistrictPicker(),
  ) {}

  /**
   * Risky buyurtmalar uchun BITTA `ai.district.pick`. Har qanday xatoda
   * kirish (`resolutions`) o'zgarishsiz qaytadi — oqim yiqilmaydi.
   */
  async refine(
    queries: readonly DistrictTextQuery[],
    resolutions: readonly (DistrictTextResolution | null)[],
    ctx: DistrictFallbackContext,
  ): Promise<(DistrictTextResolution | null)[]> {
    const out = [...resolutions];
    try {
      const risky = queries
        .map((q, i) => i)
        .filter((i) => isRiskyResolution(resolutions[i], queries[i]))
        .slice(0, AI_DISTRICT_MAX_ITEMS);
      if (risky.length === 0) return out;

      const rows = await this.loadDistricts();
      if (rows.length === 0) return out;

      const pools = new Map<
        number,
        { trustRegion: boolean; pool: DistrictRow[] }
      >();
      for (const i of risky) {
        const built = buildDistrictPool(resolutions[i], queries[i], rows);
        if (built.pool.length > 0) pools.set(i, built);
      }
      if (pools.size === 0) return out;

      const result = await this.picker.pick({
        market_id: ctx.market_id,
        requester: ctx.requester,
        trace_id: ctx.trace_id,
        draft_id: ctx.draft_id,
        deadline_at: ctx.deadline_at,
        items: [...pools.entries()].map(([i, { pool }]) => ({
          item_index: i,
          place_text: placeTextOf(queries[i]),
          region_name: txt(queries[i]?.region_name) || null,
          pool: toPoolEntries(pool),
        })),
      });
      if (!result) return out;

      let applied = 0;
      for (const pick of result.picks) {
        const built = pools.get(pick.item_index);
        if (!built) continue;
        const next = applyDistrictChoice(
          resolutions[pick.item_index],
          built.pool,
          built.trustRegion,
          pick.choice,
        );
        if (next) {
          out[pick.item_index] = next;
          applied += 1;
        }
      }
      this.logger.log(
        `ai_district_fallback risky=${risky.length} applied=${applied}`,
      );
      return out;
    } catch (err) {
      this.logger.warn(
        `ai_district_fallback xato: ${(err as Error)?.message ?? 'unknown'}`,
      );
      return [...resolutions];
    }
  }

  private async loadDistricts(): Promise<DistrictRow[]> {
    if (this.cache && Date.now() - this.cache.at < DISTRICT_LIST_CACHE_MS) {
      return this.cache.rows;
    }
    const reply = await rmqSend<unknown>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_all' },
      {},
      {
        timeoutMs: LOGISTICS_LIST_TIMEOUT_MS,
        retries: 1,
        attachRequestId: false,
      },
    );
    const rows = districtRowsOf(reply);
    if (rows.length > 0) this.cache = { at: Date.now(), rows };
    return rows;
  }
}
