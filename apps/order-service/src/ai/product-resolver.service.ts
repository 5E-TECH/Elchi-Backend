import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_MAX_CANDIDATES,
  PRODUCT_AUTO_MARGIN,
  PRODUCT_AUTO_MIN,
  PRODUCT_CANDIDATE_MIN,
  PRODUCT_EXACT_SCORE,
  PRODUCT_SUBSTRING_SCORE,
  normalizeProduct,
  rmqSend,
  tokenFuzzy,
  type AiRequester,
} from '@app/common';
import { PRODUCT_DISAMBIGUATOR } from './product-disambiguator';
import type {
  ProductDisambiguationPicks,
  ProductDisambiguator,
} from './product-disambiguator';
import type { AiProductCandidate } from './ai-preview.types';

/**
 * AI ajratgan mahsulot nomlarini tanlangan MARKET katalogiga moslash (luv25zlI).
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `resolveItems`
 * :1754-1791, `rankProducts` :1794-1830, avto-tanlash :1774-1779,
 * `disambiguateItemsWithLlm` :1462-1502. Elchi farqlari:
 *   - katalog RMQ `catalog.product.find_all` orqali partiyaga BIR MARTA
 *     yuklanadi (N+1 yo'q), boshqa market qatorlari tashlanadi;
 *   - LLM'ga butun katalog (1-asosli indeks) yuboriladi, `product_id` KODDA
 *     `catalog[choice-1]` dan — diapazon, kutilayotgan item, egalik va raqam
 *     tekshiruvidan keyin olinadi;
 *   - partiyaga ko'pi bilan BITTA LLM chaqiruvi (port orqali, ai-service'da).
 *
 * ⚠️ AI o'zi qaror qilmaydi: hal bo'lmagan item `unresolved: true` bilan
 * qaytadi. `product_name` HECH QACHON avtomatik yozilmaydi — uni faqat
 * operator ataylab "katalogda yo'q" deb belgilaganda frontend yuboradi.
 */

/** Katalogdagi bitta mahsulot (`user_id` = market). */
export interface CatalogProduct {
  id: string;
  name: string;
  user_id: string;
}

export interface RankedProduct {
  product: CatalogProduct;
  score: number;
}

/** Xom item (ai-service chiqishi) — runtime'da qayta tekshiriladi. */
export interface AiItemInput {
  name?: unknown;
  quantity?: unknown;
}

/**
 * Rezolyutsiya natijasi. Preview uni `items[].name` ga o'giradi.
 * ⚠️ `product_name` kaliti ATAYLAB yo'q.
 */
export interface ResolvedAiItem {
  ai_name: string;
  quantity: number;
  product_id: string | null;
  resolved_name: string | null;
  /** Ko'pi bilan `AI_MAX_CANDIDATES` ta; hal bo'lgan itemda bo'sh. */
  candidates: AiProductCandidate[];
  unresolved: boolean;
}

/** LLM fallback uchun kontekst (ai-service meta + muddat). */
export interface ProductResolveContext {
  requester: AiRequester;
  trace_id: string | null;
  draft_id: string | null;
  /** Umumiy muddat (epoch ms). */
  deadline_at: number;
}

/** `catalog.product.find_all` javobi — `successRes` EMAS, to'g'ridan `{data,total,page,limit}`. */
interface CatalogFindAllReply {
  data?: Array<{ id?: unknown; name?: unknown; user_id?: unknown }> | null;
  total?: number;
  page?: number;
  limit?: number;
}

/**
 * ⚠️ `limit` BERILISHI SHART: catalog-service'da sukut `limit = 10` — berilmasa
 * katalogning faqat 10 tasi keladi va moslash jimgina noto'g'ri bo'ladi.
 */
export const CATALOG_LOAD_LIMIT = 500;
const CATALOG_RPC_TIMEOUT_MS = 6_000;

/** Katalogda shundan KAM mahsulot bo'lsa LLM chaqirilmaydi (1-2 ta — operator o'zi tanlaydi). */
const LLM_MIN_CATALOG_SIZE = 3;

/**
 * Suzuvchi nuqta xatosi: 0.85 - 0.65 = 0.19999999999999996 < 0.2 bo'lib,
 * aniq chegaradagi farq avto-tanlashdan jimgina tushib qolmasin.
 */
const SCORE_EPSILON = 1e-9;

/**
 * Nomni katalogdagi mahsulotlar bilan baholaydi (BeePost :1794-1830):
 * aniq tenglik → `PRODUCT_EXACT_SCORE`, biri ikkinchisining ichida →
 * `PRODUCT_SUBSTRING_SCORE`, aks holda max(jaccard, tokenFuzzy).
 * `PRODUCT_CANDIDATE_MIN` dan pastlari tashlanadi; kamayish tartibida.
 */
export function rankProducts(
  query: string,
  catalog: readonly CatalogProduct[],
): RankedProduct[] {
  const q = normalizeProduct(query);
  if (!q) return [];
  const qTokens = q.split(' ').filter(Boolean);
  const qTokenSet = new Set(qTokens);

  return catalog
    .map((product): RankedProduct => {
      const p = normalizeProduct(product.name);
      let score = 0;
      // Bo'sh skeletli nom ("dona") har qanday satrning "ichida" bo'lib qolardi.
      if (!p) score = 0;
      else if (p === q) score = PRODUCT_EXACT_SCORE;
      // Substring (0.8) < avto-chegara (0.85): nomzod sifatida ko'rinadi, lekin
      // qo'shimcha so'z boshqa SKU bo'lishi mumkin — avto-tanlanmaydi.
      else if (p.includes(q) || q.includes(p)) score = PRODUCT_SUBSTRING_SCORE;
      else {
        const pTokens = p.split(' ').filter(Boolean);
        const pTokenSet = new Set(pTokens);
        const inter = [...qTokenSet].filter((t) => pTokenSet.has(t)).length;
        const union = new Set([...qTokenSet, ...pTokenSet]).size || 1;
        score = Math.max(inter / union, tokenFuzzy(qTokens, pTokens));
      }
      return { product, score };
    })
    .filter((r) => r.score >= PRODUCT_CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score);
}

/**
 * Avto-tanlash qoidasi (BeePost :1774-1779): faqat ANIQ tenglik (1.0, ikkinchisi
 * 1 emas) YOKI aniq ustunlik (>= `PRODUCT_AUTO_MIN` va ikkinchidan kamida
 * `PRODUCT_AUTO_MARGIN` oldinda). Substring (0.8) HECH QACHON avto-tanlanmaydi.
 */
export function shouldAutoPick(ranked: readonly { score: number }[]): boolean {
  if (!ranked.length) return false;
  const score = ranked[0].score;
  const next = ranked.length > 1 ? ranked[1].score : 0;
  return (
    (score === PRODUCT_EXACT_SCORE && next < PRODUCT_EXACT_SCORE) ||
    (score >= PRODUCT_AUTO_MIN &&
      score - next >= PRODUCT_AUTO_MARGIN - SCORE_EPSILON)
  );
}

/** Nomdagi raqamli bo'laklar (o'lcham/model: "700 gr" → ['700']), tartiblangan. */
export function digitTokens(name: string): string[] {
  const digits: string[] = normalizeProduct(name).match(/\d+/g) ?? [];
  return digits.map((d) => d.replace(/^0+(?=\d)/, '')).sort();
}

/**
 * ⚠️ RAQAM QAT'IYLIGI: "quloqchin 700 gr" hech qachon "quloqchin 500 gr" ga
 * tushmasin — raqamli bo'laklar to'plami AYNAN teng bo'lishi shart. Boshqa
 * o'lcham/model — boshqa SKU va boshqa narx.
 */
export function sameDigitTokens(a: string, b: string): boolean {
  const da = digitTokens(a);
  const db = digitTokens(b);
  return da.length === db.length && da.every((d, i) => d === db[i]);
}

const normalizeId = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Mahsulot shu marketniki (bigint `user_id` satr yoki son bo'lib kelishi mumkin). */
const isOwnedBy = (product: CatalogProduct, marketId: string): boolean =>
  marketId !== '' && normalizeId(product?.user_id) === marketId;

@Injectable()
export class ProductResolverService {
  private readonly logger = new Logger(ProductResolverService.name);

  constructor(
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject(PRODUCT_DISAMBIGUATOR)
    private readonly disambiguator: ProductDisambiguator,
  ) {}

  /**
   * Market katalogini BIR MARTA yuklaydi. Bo'sh `marketId` — RPC'siz `[]`.
   * Xato bo'lsa `[]` + WARN: oqim yiqilmaydi, hamma item `unresolved` bo'ladi.
   *
   * ⚠️ `catalog.product.find_all` javobidagi qatorlar market bo'yicha QAYTA
   * tekshiriladi — boshqa marketning mahsuloti buyurtmaga tushib qolsa
   * lifecycle'ning `product:${id}` guruhlashi buziladi.
   */
  async loadCatalog(marketId: string): Promise<CatalogProduct[]> {
    const market = normalizeId(marketId);
    if (!market) return [];

    let reply: CatalogFindAllReply | null;
    try {
      reply = await rmqSend<CatalogFindAllReply>(
        this.catalogClient,
        { cmd: 'catalog.product.find_all' },
        { query: { user_id: market, limit: CATALOG_LOAD_LIMIT } },
        {
          timeoutMs: CATALOG_RPC_TIMEOUT_MS,
          retries: 1,
          attachRequestId: false,
        },
      );
    } catch (err) {
      this.logger.warn(
        `AI katalog yuklanmadi (market ${market}): ${(err as Error)?.message ?? 'unknown'} — itemlar unresolved qoladi`,
      );
      return [];
    }

    const rows = Array.isArray(reply?.data) ? reply.data : [];
    const total = Number(reply?.total);
    if (Number.isFinite(total) && total > rows.length) {
      this.logger.warn(
        `AI katalog to'liq emas (market ${market}): ${rows.length}/${total} — limit ${CATALOG_LOAD_LIMIT}`,
      );
    }

    const catalog: CatalogProduct[] = [];
    let foreign = 0;
    for (const row of rows) {
      const id = normalizeId(row?.id);
      const name = typeof row?.name === 'string' ? row.name : '';
      if (!id || !name.trim()) continue;
      const product: CatalogProduct = {
        id,
        name,
        user_id: normalizeId(row?.user_id),
      };
      if (!isOwnedBy(product, market)) {
        foreign++;
        continue;
      }
      catalog.push(product);
    }
    if (foreign > 0) {
      this.logger.warn(
        `AI katalog: boshqa marketning ${foreign} ta mahsuloti tashlandi (market ${market})`,
      );
    }
    return catalog;
  }

  rankProducts(
    query: string,
    catalog: readonly CatalogProduct[],
  ): RankedProduct[] {
    return rankProducts(query, catalog);
  }

  /**
   * Bitta buyurtmaning itemlari — faqat deterministik (LLM'siz). Bo'sh nomli
   * item tashlanadi; son ko'rsatilmasa 1.
   */
  resolveItems(
    items: readonly AiItemInput[] | null | undefined,
    catalog: readonly CatalogProduct[],
    marketId: string,
  ): ResolvedAiItem[] {
    const market = normalizeId(marketId);
    const owned = catalog.filter((p) => isOwnedBy(p, market));
    const list: readonly AiItemInput[] = Array.isArray(items) ? items : [];
    const out: ResolvedAiItem[] = [];

    for (const raw of list) {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      if (!name) continue;
      const quantity = Math.max(1, Math.floor(Number(raw?.quantity) || 1));
      const ranked = rankProducts(name, owned);

      // Avto-tanlashda ham raqam qat'iyligi: fuzzy ball yuqori bo'lsa ham
      // o'lchami boshqa mahsulot jimgina tanlanmasin.
      if (
        shouldAutoPick(ranked) &&
        sameDigitTokens(name, ranked[0].product.name)
      ) {
        out.push({
          ai_name: name,
          quantity,
          product_id: ranked[0].product.id,
          resolved_name: ranked[0].product.name,
          candidates: [],
          unresolved: false,
        });
      } else {
        out.push({
          ai_name: name,
          quantity,
          product_id: null,
          resolved_name: null,
          candidates: ranked
            .slice(0, AI_MAX_CANDIDATES)
            .map((r) => ({ id: r.product.id, name: r.product.name })),
          unresolved: true,
        });
      }
    }
    return out;
  }

  /**
   * Butun partiya: katalog BIR MARTA (yoki `preloadedCatalog`), so'ng
   * ko'pi bilan BITTA LLM chaqiruvi — faqat noaniq (nomzodli, hal bo'lmagan)
   * item bo'lsa va katalogda 2 tadan ko'p mahsulot bo'lsa.
   *
   * Natija `orders` tartibida: har buyurtma uchun `ResolvedAiItem[]`.
   */
  async resolveOrders(
    marketId: string,
    orders: readonly ({ items?: readonly AiItemInput[] | null } | null)[],
    ctx: ProductResolveContext,
    preloadedCatalog?: readonly CatalogProduct[],
  ): Promise<ResolvedAiItem[][]> {
    const market = normalizeId(marketId);
    const catalog = preloadedCatalog ?? (await this.loadCatalog(market));
    const resolved = orders.map((o) =>
      this.resolveItems(o?.items, catalog, market),
    );

    const pending = resolved
      .flat()
      .filter((it) => it.unresolved && it.candidates.length > 0);
    // Indeks — `catalog` massividagi o'rni (1-asosli); LLM faqat shu market
    // mahsulotlarini ko'radi.
    const offered = catalog
      .map((product, i) => ({ index: i + 1, product }))
      .filter((x) => isOwnedBy(x.product, market));
    if (!pending.length || offered.length < LLM_MIN_CATALOG_SIZE) {
      return resolved;
    }

    let answer: ProductDisambiguationPicks | null = null;
    try {
      answer = await this.disambiguator.pick({
        market_id: market,
        requester: ctx.requester,
        trace_id: ctx.trace_id,
        draft_id: ctx.draft_id,
        deadline_at: ctx.deadline_at,
        items: pending.map((it, itemIndex) => ({
          item_index: itemIndex,
          name: it.ai_name,
          quantity: it.quantity,
        })),
        catalog: offered.map((x) => ({
          index: x.index,
          name: x.product.name,
        })),
      });
    } catch (err) {
      // Port shartnomasi "xato tashlamaydi", lekin himoya: LLM yiqilsa ham
      // itemlar shunchaki operatorga qoladi.
      this.logger.warn(
        `AI mahsulot aniqlashtirish xato: ${(err as Error)?.message ?? 'unknown'}`,
      );
      answer = null;
    }

    if (answer && Array.isArray(answer.picks)) {
      this.applyPicks(answer.picks, pending, catalog, market);
    }
    return resolved;
  }

  /**
   * LLM tanlovlarini qabul qiladi — faqat HAMMA shart bajarilsa:
   * butun son; 1 <= choice <= katalog uzunligi; `item_index` hali hal
   * bo'lmagan item; mahsulot shu marketniki; raqamli bo'laklar teng.
   * `choice = 0` — "mos yo'q", item operatorga qoladi.
   */
  private applyPicks(
    picks: readonly unknown[],
    pending: readonly ResolvedAiItem[],
    catalog: readonly CatalogProduct[],
    marketId: string,
  ): void {
    let rejected = 0;
    for (const raw of picks) {
      const pick = raw as { item_index?: unknown; choice?: unknown } | null;
      const itemIndex = pick?.item_index;
      const choice = pick?.choice;
      if (!Number.isInteger(itemIndex) || !Number.isInteger(choice)) {
        rejected++;
        continue;
      }
      const item = pending[itemIndex as number];
      if (!item || !item.unresolved || item.product_id !== null) {
        rejected++;
        continue;
      }
      if (choice === 0) continue;
      const k = choice as number;
      if (k < 1 || k > catalog.length) {
        rejected++;
        continue;
      }
      const product = catalog[k - 1];
      if (
        !isOwnedBy(product, marketId) ||
        !sameDigitTokens(item.ai_name, product.name)
      ) {
        rejected++;
        continue;
      }
      item.product_id = product.id;
      item.resolved_name = product.name;
      item.candidates = [];
      item.unresolved = false;
    }
    if (rejected > 0) {
      this.logger.warn(
        `AI mahsulot aniqlashtirish: ${rejected} ta tanlov rad etildi (market ${marketId})`,
      );
    }
  }
}
