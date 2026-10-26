import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_DISTRICT_CATALOG_MAX,
  AI_DISTRICT_MAX_ITEMS,
  AI_DISTRICT_POOL_MAX,
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type AiDistrictCatalogEntry,
  type AiDistrictPickItem,
  type AiDistrictPickRequest,
  type AiDistrictPickResponse,
} from '@app/common';
import {
  DISTRICT_PICK_SYSTEM,
  buildDistrictCatalogSystem,
  buildDistrictCatalogUserText,
  buildDistrictPickUserText,
  type DistrictCatalogUserItem,
} from '../prompts/district-pick.prompt';
import { DISTRICT_PICK_SCHEMA } from '../prompts/district-pick.schema';
import {
  AI_LOW_EFFORT_MODELS,
  cacheMinTokensFor,
  supportsEffort,
} from '../usage/ai-pricing';

/**
 * Javob faqat `{picks:[{item_index, choice}]}`. BeePostda 64 edi — partiya
 * (≤10 item) uchun 256; kesilsa ClaudeService BIR marta 2× bilan qayta
 * urinadi, baribir kesilsa `{ok:false, reason:'truncated'}` (TC11).
 */
export const DISTRICT_PICK_MAX_TOKENS = 256;

/**
 * Sukut bo'yicha ADAPTIVE thinking'li modellar (thinking param berilmasa ham
 * fikrlaydi) — 256 max_tokens fikrlashga ketib javob kesilmasin (TC11):
 * `output_config.effort: 'low'`. Haiku 4.5 / Sonnet 4.6 da thinking sukut
 * o'chiq (Haiku 4.5 effort'ni qabul qilmaydi — 400), ular uchun BERILMAYDI.
 * Ro'yxat order-extract bilan umumiy (`AI_LOW_EFFORT_MODELS`).
 */
export const DISTRICT_LOW_EFFORT_MODELS: ReadonlySet<string> =
  AI_LOW_EFFORT_MODELS;

/**
 * Token bahosi (kesh chegarasi qarori uchun): belgi / 3. O'lchov (karta):
 * 181 tumanli ro'yxat 4997 belgi ≈ 1.6–1.9k token (~2.6–3.1 belgi/token).
 */
export const DISTRICT_CHARS_PER_TOKEN_ESTIMATE = 3;

/** Katalog rejimi rejasi: system (barqaror), user (o'zgaruvchan), tarjima. */
interface CatalogPlan {
  system: string;
  userText: string;
  /** item_index → (katalog raqami → pool `index`). */
  byItem: Map<number, Map<number, number>>;
}

type Pick = { item_index: number; choice: number };

/**
 * `ai.district.pick` (5Z1ZvvzE) — bitta preview — bitta chaqiruv, feature
 * `order_district`.
 *
 * KESH (5Z1ZvvzE #3-4): so'rovda `catalog` bo'lsa — barcha tumanlar ro'yxati
 * SYSTEM-promptga (ClaudeService uni `cache_control: ephemeral` bilan
 * yuboradi), user blokda faqat item_index / place_text / region_name /
 * `candidates`. Model katalog RAQAMINI qaytaradi, bu yerda pool `index` ga
 * o'giriladi (shu itemning candidates'ida yo'q raqam — RAD), ya'ni
 * order-service kontrakti (`choice` = pool indeksi) o'zgarmaydi.
 * Model: `AI_DISTRICT_MODEL` (sukut claude-sonnet-5, kesh chegarasi 1024).
 * Modelning minimal keshlanadigan prefiksi system'dan katta bo'lsa (Haiku
 * 4.5 = 4096), katalog yo'q yoki pool bilan mos emas — ESKI rejim (pool user
 * blokida, keshsiz, lekin kamroq token).
 *
 * ⚠️ Bu servis faqat javob SHAKLINI tozalaydi. Diapazon, viloyat qulfi va
 * SOATO darvozasi order-service'da (`district-llm-fallback.ts`) — ID faqat
 * o'sha yerda `pool[choice-1]` dan olinadi.
 */
@Injectable()
export class DistrictPickService {
  private readonly logger = new Logger(DistrictPickService.name);
  /** Katalog system-prompti BIR marta quriladi (katalog o'zgarsa — qayta). */
  private catalogSystemMemo: { key: string; text: string } | null = null;
  /** "Kesh chegarasi sabab eski rejim" logi har model uchun BIR marta. */
  private readonly warnedBelowThreshold = new Set<string>();

  constructor(
    private readonly claude: ClaudeService,
    private readonly config: ConfigService,
  ) {}

  private districtModel(): string {
    const raw = this.config.get<unknown>('AI_DISTRICT_MODEL');
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || AI_MODEL_DEFAULTS.district;
  }

  async pick(
    req: AiDistrictPickRequest,
    deadlineAt?: number,
  ): Promise<AiDistrictPickResponse> {
    const items = (Array.isArray(req?.items) ? req.items : [])
      .filter(
        (it) =>
          Array.isArray(it?.pool) &&
          it.pool.length > 0 &&
          it.pool.length <= AI_DISTRICT_POOL_MAX &&
          typeof it.place_text === 'string' &&
          it.place_text.trim() !== '',
      )
      .slice(0, AI_DISTRICT_MAX_ITEMS);
    // Tanlanadigan narsa yo'q — pulli chaqiruvning ma'nosi yo'q.
    if (items.length === 0) return { ok: true, picks: [] };

    const model = this.districtModel();
    const plan = this.planCatalog(req?.catalog, items, model);

    const r = await this.claude.extractJson<{ picks: unknown }>({
      system: plan ? plan.system : DISTRICT_PICK_SYSTEM,
      userText: plan
        ? plan.userText
        : buildDistrictPickUserText({ ...req, items }),
      schema: DISTRICT_PICK_SCHEMA,
      model,
      maxTokens: DISTRICT_PICK_MAX_TOKENS,
      deadlineAt,
      ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
      meta: {
        feature: 'order_district',
        requestArea: 'order',
        marketId: req.market_id ?? null,
        userId: req.requester?.id ?? null,
        traceId: req.trace_id ?? null,
        draftId: req.draft_id ?? null,
      },
    });

    if (!r.ok) return { ok: false, reason: r.reason };
    const picks = sanitizePicks(r.data?.picks);
    return {
      ok: true,
      picks: plan ? translateCatalogPicks(picks, plan.byItem) : picks,
    };
  }

  /**
   * Katalog rejimi rejasi yoki `null` (eski rejim). Har qanday nomuvofiqlik
   * (katalog/pool mos emas, takror item_index, model kesh chegarasi) — `null`.
   */
  private planCatalog(
    rawCatalog: unknown,
    items: readonly AiDistrictPickItem[],
    model: string,
  ): CatalogPlan | null {
    const catalog = sanitizeCatalog(rawCatalog);
    if (!catalog) return null;

    const byItem = new Map<number, Map<number, number>>();
    const userItems: DistrictCatalogUserItem[] = [];
    for (const it of items) {
      if (!Number.isInteger(it.item_index) || byItem.has(it.item_index)) {
        return null;
      }
      const map = new Map<number, number>();
      const candidates: number[] = [];
      for (const p of it.pool) {
        const ci = p?.catalog_index;
        if (
          typeof ci !== 'number' ||
          !Number.isInteger(ci) ||
          ci < 1 ||
          ci > catalog.length ||
          map.has(ci) ||
          typeof p.index !== 'number' ||
          !Number.isInteger(p.index)
        ) {
          return null;
        }
        // Katalog va pool bir xil qatorni ko'rsatishi SHART (eskirgan katalog
        // boshqa tumanga tushib ketmasin).
        const entry = catalog[ci - 1];
        if (
          entry.district_name !== p.district_name ||
          entry.region_name !== p.region_name
        ) {
          return null;
        }
        map.set(ci, p.index);
        candidates.push(ci);
      }
      byItem.set(it.item_index, map);
      userItems.push({
        item_index: it.item_index,
        place_text: it.place_text,
        region_name: typeof it.region_name === 'string' ? it.region_name : null,
        candidates,
      });
    }

    const system = this.catalogSystem(catalog);
    const minTokens = cacheMinTokensFor(model);
    const estTokens = Math.ceil(
      system.length / DISTRICT_CHARS_PER_TOKEN_ESTIMATE,
    );
    if (minTokens !== null && estTokens < minTokens) {
      // Kesh baribir yozilmaydi — katta prompt uchun to'liq narx to'lanmasin.
      if (!this.warnedBelowThreshold.has(model)) {
        this.warnedBelowThreshold.add(model);
        this.logger.warn(
          `district_pick_cache_below_min model=${model} est_tokens=${estTokens} ` +
            `min_cache_tokens=${minTokens} — eski rejim (pool user blokida, keshsiz)`,
        );
      }
      return null;
    }

    return {
      system,
      userText: buildDistrictCatalogUserText(userItems),
      byItem,
    };
  }

  /** Bir xil katalog — bayt darajasida bir xil system (memo, BIR marta). */
  private catalogSystem(catalog: readonly AiDistrictCatalogEntry[]): string {
    const key = JSON.stringify(catalog);
    if (this.catalogSystemMemo?.key === key) return this.catalogSystemMemo.text;
    const text = buildDistrictCatalogSystem(catalog);
    this.catalogSystemMemo = { key, text };
    this.logger.log(
      `district_pick_catalog_system qurildi entries=${catalog.length} chars=${text.length} ` +
        `est_tokens=${Math.ceil(text.length / DISTRICT_CHARS_PER_TOKEN_ESTIMATE)}`,
    );
    return text;
  }
}

/**
 * Katalog: massiv, 1..AI_DISTRICT_CATALOG_MAX, har qatorda satr nomlar
 * (tuman bo'sh emas). Aks holda `null` — eski rejim.
 */
function sanitizeCatalog(value: unknown): AiDistrictCatalogEntry[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > AI_DISTRICT_CATALOG_MAX
  ) {
    return null;
  }
  const out: AiDistrictCatalogEntry[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== 'object') return null;
    const { region_name, district_name } = raw as Record<string, unknown>;
    if (
      typeof region_name !== 'string' ||
      typeof district_name !== 'string' ||
      district_name.trim() === ''
    ) {
      return null;
    }
    out.push({ region_name, district_name });
  }
  return out;
}

/**
 * Katalog raqami → pool `index`. `0` ("ishonchim komil emas") o'zgarishsiz;
 * shu itemning candidates'ida yo'q raqam (boshqa viloyat ham) — RAD
 * (tashlanadi, natija o'zgarmaydi).
 */
function translateCatalogPicks(
  picks: readonly Pick[],
  byItem: ReadonlyMap<number, ReadonlyMap<number, number>>,
): Pick[] {
  const out: Pick[] = [];
  for (const p of picks) {
    const map = byItem.get(p.item_index);
    if (!map) continue;
    if (p.choice === 0) {
      out.push({ item_index: p.item_index, choice: 0 });
      continue;
    }
    const local = map.get(p.choice);
    if (local !== undefined) {
      out.push({ item_index: p.item_index, choice: local });
    }
  }
  return out;
}

/** Faqat butun sonli `{item_index, choice}`; begona kalitlar tashlanadi. */
function sanitizePicks(value: unknown): Pick[] {
  if (!Array.isArray(value)) return [];
  const picks: Pick[] = [];
  for (const p of value) {
    if (p === null || typeof p !== 'object') continue;
    const { item_index, choice } = p as Record<string, unknown>;
    if (
      typeof item_index === 'number' &&
      Number.isInteger(item_index) &&
      typeof choice === 'number' &&
      Number.isInteger(choice)
    ) {
      picks.push({ item_index, choice });
    }
  }
  return picks;
}
