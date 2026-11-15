import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AI_MAX_CANDIDATES,
  AI_PRICE_CONFIRM_THRESHOLD,
  IdempotencyService,
  isJunkRawOrder,
  normalizeUzPhone,
  normalizeProduct,
  priceDerivableFromMentions,
  priceMismatchesMentions,
  quantityLooksLikeMoney,
  uniqueMentionValues,
  type MoneyMention,
  type MoneyMentionKind,
  sanitizeExtractWarnings,
  rmqSend,
  type AiRequester,
  type RawOrderExtraction,
} from '@app/common';
import { DistrictLlmFallbackService } from './district-llm-fallback';
import { ProductResolverService } from './product-resolver.service';
import type { ResolvedAiItem } from './product-resolver.service';
import type {
  AiCheck,
  AiDistrictCandidate,
  AiDistrictMatch,
  AiIssue,
  AiOrderPreview,
  AiPreviewItem,
  AiResolvePreviewRequest,
  AiResolvePreviewResponse,
  DistrictTextQuery,
  DistrictTextResolution,
  RawExtraction,
} from './ai-preview.types';

/**
 * `order.ai_resolve_preview` (fPre2MRr): ai-service chiqargan XOM JSON'ni
 * Elchi ID'lariga DETERMINISTIK aylantirib, operator tasdiqlaydigan YASSI
 * preview quradi. Bu yerda Anthropic chaqiruvi YO'Q — faqat noaniq mahsulot
 * bo'lsa port orqali ko'pi bilan bitta `ai.product.disambiguate`.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `rawToDraft` :573-614,
 * `parseOrders` :618-668, `computeIssues`/`toPreview` :720-803.
 *
 * ⚠️ BATCHING: partiyaga CATALOG 1 marta, LOGISTICS 1 marta (≤50 buyurtma),
 * IDENTITY 1 marta — hammasi PARALLEL. Buyurtmalar sikli ichida RPC YO'Q.
 *
 * ⚠️ `OrderLookupService` ATAYLAB inject qilinmaydi: uning
 * `resolveDistrictId` zaxirasi (`getDefaultDistrictId`) jadvaldagi BIRINCHI
 * tumanni `ORDER BY`siz oladi — mos kelmagan buyurtma jimgina boshqa
 * viloyatga ketardi. Tuman faqat `logistics.district.resolve_by_text` dan.
 *
 * ⚠️ MAXFIYLIK: preview (ism, telefon, manzil) faqat `runIdempotent` keshida
 * (`order_schema.idempotency_keys`) yashaydi va 1 soatdan keyin tozalanadi
 * (`prunePattern`): servis ishga tushganda, har 10 daqiqada taymer bilan va
 * `resolve` dan keyin (10 daqiqada ko'pi bilan bir marta). Log'ga
 * ism/telefon/manzil YOZILMAYDI — faqat sonlar.
 */

/** `idempotency_keys` dagi preview qatorlari shu pattern bilan saqlanadi. */
export const AI_PREVIEW_PATTERN = 'order.ai_resolve_preview';
/** Preview PII qatorlarining saqlanish muddati (ms) — 1 soat. */
export const AI_PREVIEW_RETENTION_MS = 3_600_000;
/**
 * Tozalash oralig'i (ms) — 10 daqiqa: fon taymeri davri va `resolve`
 * throttle'i.
 */
export const AI_PREVIEW_PRUNE_INTERVAL_MS = 600_000;

const LOGISTICS_RPC_TIMEOUT_MS = 6_000;
const IDENTITY_RPC_TIMEOUT_MS = 3_000;
/** `logistics.district.resolve_by_text` bitta so'rovdagi maksimal element (C7). */
const DISTRICT_BATCH_MAX = 50;
/**
 * Almashtirish buyurtmasi belgisi (izohda). Eski buyurtmani gateway
 * telefon bo'yicha bog'laydi (`replaced_order_id`, narx kamchiliklari ham
 * o'sha yerda) — bu yerda market buyurtmalari o'qilmaydi.
 */
const REPLACEMENT_MARK = '[ALMASHTIRISH]';

type WhereDeliver = 'center' | 'address';

/**
 * P1-7: `price_check` (kind 'too_high') — bundan katta buyurtma summasi
 * (so'm) gallyutsinatsiya bo'lishi mumkin (1.5e11 ham "Tayyor" edi). Summa
 * matndagi eslatmalardan kelib chiqsa ("mashina 120 mln") — ko'tarilmaydi.
 */
export const AI_PRICE_HIGH_LIMIT = 100_000_000;
/** P1-7: `qty_check` — bundan katta miqdor shubhali. */
export const AI_QTY_CHECK_LIMIT = 10;
/** Past ishonchli tuman usullari (`district_low_confidence`). */
const LOW_CONFIDENCE_METHODS = new Set(['partial', 'address', 'fuzzy', 'llm']);

interface IdentityUserReply {
  data?: {
    default_tariff?: unknown;
    phone_number?: unknown;
    extra_number?: unknown;
    default_operator_phone?: unknown;
    problem_phone?: unknown;
  } | null;
}

interface MarketInfo {
  tariff: WhereDeliver | null;
  /** Market va uning operator/muammo raqamlari (normallashgan). */
  phones: ReadonlySet<string>;
}

interface DistrictResolveReply {
  data?: DistrictTextResolution[] | null;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const textOrNull = (value: unknown): string | null => text(value) || null;

const optText = (value: unknown): string | undefined =>
  text(value) || undefined;

const isWhereDeliver = (value: unknown): value is WhereDeliver =>
  value === 'center' || value === 'address';

const normalizeId = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Telefon xom matni (AI ba'zan son sifatida qaytaradi). */
const phoneText = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : text(value);

const MONEY_MENTION_KINDS: ReadonlySet<unknown> = new Set<MoneyMentionKind>([
  'unit',
  'total',
  'delivery',
  'prepaid',
]);

/** ai-service qo'ygan `money_mentions` — RMQ chegarasi, qayta tekshiriladi. */
function moneyMentionsOf(value: unknown): MoneyMention[] {
  if (!Array.isArray(value)) return [];
  const out: MoneyMention[] = [];
  for (const m of value.slice(0, 20)) {
    const v = Number((m as { value?: unknown })?.value);
    const k = (m as { kind?: unknown })?.kind;
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push({
      value: Math.round(v),
      kind: MONEY_MENTION_KINDS.has(k) ? (k as MoneyMentionKind) : null,
      ...((m as { ambiguous?: unknown })?.ambiguous === true
        ? { ambiguous: true as const }
        : {}),
      ...((m as { included?: unknown })?.included === true
        ? { included: true as const }
        : {}),
      ...((m as { count_stated?: unknown })?.count_stated === true
        ? { count_stated: true as const }
        : {}),
    });
  }
  return out;
}

@Injectable()
export class AiPreviewService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiPreviewService.name);
  private lastPruneAt = 0;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly productResolver: ProductResolverService,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly idempotencyService: IdempotencyService,
    // 5Z1ZvvzE: tuman LLM fallback'i. Ixtiyoriy — berilmasa (spec) faqat
    // deterministik rezolver.
    @Optional()
    private readonly districtFallback?: DistrictLlmFallbackService,
  ) {}

  /**
   * HD5zOyBp #10: preview PII qatorlarini fonda tozalash.
   *
   * ⚠️ NEGA TAYMER. Tozalash faqat `resolve` dan chaqirilsa, AI trafigi
   * to'xtaganda (AI_ORDER_ENABLED o'chiq, kunlik limit tugagan yoki funksiya
   * ishlatilmayapti) 1 soatdan eski preview qatorlari (ism/telefon/manzil)
   * bazada MUDDATSIZ qolib ketardi. Shu bois servis ishga tushganda bir marta
   * va keyin har 10 daqiqada tozalanadi. Taymer `unref()` — jarayonni tirik
   * ushlab turmaydi. Bir nechta replika bo'lsa har biri o'zi o'chiradi —
   * `DELETE ... WHERE pattern AND created_at < cutoff` idempotent.
   */
  onModuleInit(): void {
    if (this.pruneTimer) return;
    this.prune();
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, AI_PREVIEW_PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  async resolve(
    req: AiResolvePreviewRequest,
  ): Promise<AiResolvePreviewResponse> {
    try {
      return await this.build(req);
    } finally {
      this.maybePrune();
    }
  }

  private async build(
    req: AiResolvePreviewRequest,
  ): Promise<AiResolvePreviewResponse> {
    const rawList: unknown[] = Array.isArray(req?.raw_orders)
      ? req.raw_orders
      : [];
    const orders = rawList.filter(
      (o): o is RawExtraction =>
        typeof o === 'object' &&
        o !== null &&
        !Array.isArray(o) &&
        // isJunkRawOrder runtime'da yo'q/null maydonlarga chidamli.
        !isJunkRawOrder(o as RawOrderExtraction),
    );
    // Bo'sh partiya — RPC'siz bo'sh javob (fPre2MRr #11).
    if (!orders.length) return { previews: [] };

    const marketId = normalizeId(req.market_id);

    // ⚠️ Hamma o'qish PARALLEL va partiyaga BIR MARTADAN.
    const [catalog, districts, market] = await Promise.all([
      this.productResolver.loadCatalog(marketId),
      this.resolveDistricts(orders),
      this.loadMarket(marketId),
    ]);
    const defaultTariff = market.tariff;

    const aiCtx = {
      requester: this.requesterOf(req.requester),
      trace_id: textOrNull(req.trace_id),
      draft_id: textOrNull(req.draft_id),
      deadline_at: Number(req.deadline_at),
    };
    // Mahsulot disambiguation va tuman LLM fallback'i PARALLEL (umumiy
    // muddat ichida). Fallback faqat risky buyurtmalar uchun chaqiriladi.
    const [items, resolvedDistricts] = await Promise.all([
      this.productResolver.resolveOrders(marketId, orders, aiCtx, catalog),
      this.districtFallback
        ? this.districtFallback.refine(
            orders.map((o) => this.districtQuery(o)),
            districts,
            { market_id: marketId, ...aiCtx },
          )
        : Promise.resolve(districts),
    ]);

    const previews = orders.map((raw, index) =>
      this.toPreview(
        index,
        raw,
        resolvedDistricts[index] ?? null,
        items[index] ?? [],
        defaultTariff,
        market.phones,
      ),
    );
    // P1-7: bir parse'da bir telefon bir nechta buyurtmada.
    const byPhone = new Map<string, number[]>();
    previews.forEach((p, i) => {
      const n = normalizeUzPhone(p.phone_number);
      if (n) byPhone.set(n, [...(byPhone.get(n) ?? []), i]);
    });
    for (const idxs of byPhone.values()) {
      if (idxs.length < 2) continue;
      for (const i of idxs) {
        const other = idxs.find((j) => j !== i)!;
        previews[i].checks.push({
          code: 'same_phone_multi',
          other_index: previews[other].index,
        });
      }
    }
    return { previews };
  }

  /**
   * Tumanlarni BITTA batch RPC bilan aniqlaydi (≤50 tadan bo'lak). Xato yoki
   * noto'g'ri javobda — hamma tuman aniqlanmagan (null), oqim yiqilmaydi.
   */
  private async resolveDistricts(
    orders: readonly RawExtraction[],
  ): Promise<(DistrictTextResolution | null)[]> {
    const queries: DistrictTextQuery[] = orders.map((o) =>
      this.districtQuery(o),
    );
    const chunks: DistrictTextQuery[][] = [];
    for (let i = 0; i < queries.length; i += DISTRICT_BATCH_MAX) {
      chunks.push(queries.slice(i, i + DISTRICT_BATCH_MAX));
    }

    try {
      const replies = await Promise.all(
        chunks.map((chunk) =>
          rmqSend<DistrictResolveReply>(
            this.logisticsClient,
            { cmd: 'logistics.district.resolve_by_text' },
            { items: chunk },
            {
              timeoutMs: LOGISTICS_RPC_TIMEOUT_MS,
              retries: 1,
              attachRequestId: false,
            },
          ),
        ),
      );
      return replies.flatMap((reply, c) => {
        const rows = Array.isArray(reply?.data) ? reply.data : [];
        return chunks[c].map((_, i) => {
          const row = rows[i];
          return row && typeof row === 'object' ? row : null;
        });
      });
    } catch (err) {
      this.logger.warn(
        `AI preview: tumanlar aniqlanmadi (${orders.length} ta buyurtma): ${(err as Error)?.message ?? 'unknown'}`,
      );
      return orders.map(() => null);
    }
  }

  private districtQuery(o: RawExtraction): DistrictTextQuery {
    return {
      region_name: optText(o.region_name),
      district_name: optText(o.district_name),
      address: optText(o.address),
      full_address: optText(o.full_address),
      ...(o.region_inferred === true ? { region_inferred: true } : {}),
    };
  }

  /**
   * Marketning `default_tariff` i (xato/yo'q bo'lsa null — where_deliver
   * 'center') va raqamlari (P1-7 `phone_is_market`).
   */
  private async loadMarket(marketId: string): Promise<MarketInfo> {
    if (!marketId) return { tariff: null, phones: new Set() };
    const reply = await rmqSend<IdentityUserReply>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: marketId },
      {
        timeoutMs: IDENTITY_RPC_TIMEOUT_MS,
        retries: 0,
        attachRequestId: false,
      },
    ).catch(() => null);
    const data = reply?.data;
    const tariff = data?.default_tariff;
    const phones = new Set<string>();
    for (const v of [
      data?.phone_number,
      data?.extra_number,
      data?.default_operator_phone,
      data?.problem_phone,
    ]) {
      const n = normalizeUzPhone(phoneText(v));
      if (n) phones.add(n);
    }
    return { tariff: isWhereDeliver(tariff) ? tariff : null, phones };
  }

  private requesterOf(value: unknown): AiRequester {
    const r = (value ?? {}) as { id?: unknown; roles?: unknown };
    return {
      id: normalizeId(r.id),
      roles: Array.isArray(r.roles)
        ? r.roles.filter((x): x is string => typeof x === 'string')
        : [],
    };
  }

  /**
   * BeePost `rawToDraft` + `toPreview` porti. Chiqish obyekti KALITLAR
   * RO'YXATI (whitelist) bo'yicha yig'iladi — xom obyekt HECH QACHON
   * yoyilmaydi (`...raw`), shu sabab `operator_id`, `product_name`,
   * `parent_order_id`, `allow_free_text` yoki ball javobga tushmaydi.
   */
  private toPreview(
    index: number,
    raw: RawExtraction,
    district: DistrictTextResolution | null,
    resolvedItems: readonly ResolvedAiItem[],
    defaultTariff: WhereDeliver | null,
    marketPhones: ReadonlySet<string> = new Set(),
  ): AiOrderPreview {
    // ─── Telefon ───
    // Normallashmasa — xom matn (trim) + phone_invalid: operator nima
    // yozilganini ko'rib o'zi tuzatadi. Raqam HECH QACHON to'ldirilmaydi.
    const rawPhone = phoneText(raw.phone_number);
    const normalizedPhone = normalizeUzPhone(rawPhone);
    let phone = rawPhone ? (normalizedPhone ?? rawPhone) : '';
    let phoneValid = normalizedPhone !== null;
    let extra = normalizeUzPhone(phoneText(raw.extra_number));
    // Asosiy bo'sh bo'lsa ikkinchi raqam asosiyga o'tadi — yagona raqam
    // extra_number'ga tushib qolsa buyurtma bloklanmasin (BeePost :581-594).
    if (phone === '' && extra) {
      phone = extra;
      phoneValid = true;
      extra = null;
    }

    // ─── Narx ───
    // > 0 → yaxlitlanadi; 0 → 0 (tasdiq kerak); null/manfiy/son emas → null.
    const priceNum =
      raw.total_price === null || raw.total_price === undefined
        ? NaN
        : Number(raw.total_price);
    const totalPrice: number | null =
      Number.isFinite(priceNum) && priceNum > 0
        ? Math.round(priceNum)
        : priceNum === 0
          ? 0
          : null;

    // ─── Yetkazish turi ───
    // AI qiymati (center|address), aks holda market default_tariff, aks holda center.
    const whereDeliver: WhereDeliver = isWhereDeliver(raw.where_deliver)
      ? raw.where_deliver
      : (defaultTariff ?? 'center');

    // ─── Izoh / almashtirish ───
    const isReplacement = raw.is_replacement === true;
    const baseComment = textOrNull(raw.comment);
    const comment = isReplacement
      ? `${REPLACEMENT_MARK} ${baseComment ?? ''}`.trim()
      : baseComment;

    // ─── Operator ───
    // Faqat matn; `operator_id` requesterdan gateway'da qo'yiladi. Matndagi
    // "#sevinch" ni bog'lash operator_earnings hisobini buzardi.
    const operator = text(raw.operator).replace(/^#+/, '').trim() || null;

    // ─── Tuman / viloyat ───
    const districtCandidates: AiDistrictCandidate[] = Array.isArray(
      district?.candidates,
    )
      ? district.candidates
          .map((c) => ({
            id: normalizeId(c?.id),
            label: text(c?.label),
            region_name: text(c?.region_name),
          }))
          .filter((c) => c.id !== '')
          .slice(0, AI_MAX_CANDIDATES)
      : [];
    // ⚠️ INVARIANT: nomzodlar bo'lsa tuman JIMGINA tanlanmaydi.
    const districtId =
      districtCandidates.length > 0
        ? null
        : normalizeId(district?.district_id) || null;
    const districtName = districtId
      ? textOrNull(district?.district_name)
      : null;
    const regionId = normalizeId(district?.region_id) || null;
    const regionName = textOrNull(district?.region_name);

    // ─── Mahsulotlar ───
    const items: AiPreviewItem[] = resolvedItems.map((it) => ({
      name: it.ai_name,
      quantity: it.quantity,
      product_id: it.product_id,
      resolved_name: it.resolved_name,
      candidates: it.candidates.map((c) => ({ id: c.id, name: c.name })),
      unresolved: it.unresolved,
    }));

    // ─── P1-7: tuman usuli, yumshoq tekshiruvlar ───
    const aiDistrictText = textOrNull(raw.district_name)?.slice(0, 80) ?? null;
    let districtMatch: AiDistrictMatch | null = null;
    if (districtId) {
      if (district?.llm_picked === true) {
        districtMatch = { method: 'llm', ai_text: aiDistrictText, score: null };
      } else if (district?.match) {
        const score = Number(district.match.score);
        districtMatch = {
          method: district.match.method,
          ai_text: aiDistrictText,
          score:
            district.match.score !== null && Number.isFinite(score)
              ? Math.min(1, Math.max(0, score))
              : null,
        };
      }
    }
    const checks: AiCheck[] = [];
    if (
      districtMatch &&
      (LOW_CONFIDENCE_METHODS.has(districtMatch.method) ||
        district?.match?.region_switched === true)
    ) {
      checks.push({ code: 'district_low_confidence' });
    }
    // A1(a): narx matndagi eslatmalar bilan (mahsulot + dostavka, dona narxi
    // × shu mahsulot miqdori; oldindan to'lov ayirilmaydi). Qoidalar —
    // `libs/common/src/ai-text/money-mentions.ts`. UI'ga takrorsiz qiymatlar.
    const mentions = moneyMentionsOf(raw.money_mentions);
    const quantities = items.map((it) => it.quantity || 0);
    const mentionValues = uniqueMentionValues(mentions);
    if (
      totalPrice !== null &&
      totalPrice > AI_PRICE_HIGH_LIMIT &&
      // Matnda aytilgan katta summa ("mashina 120 mln") — too_high emas.
      !priceDerivableFromMentions(totalPrice, mentions, quantities)
    ) {
      checks.push({
        code: 'price_check',
        kind: 'too_high',
        mentions: mentionValues,
      });
    } else if (priceMismatchesMentions(totalPrice, mentions, quantities)) {
      checks.push({
        code: 'price_check',
        kind: 'mismatch',
        mentions: mentionValues,
      });
    }
    // Miqdor > 10 yoki narxning ming/mln qismi ("150 ming" → quantity 150;
    // dona narxi va matnda aniq aytilgan miqdor — e'tiborsiz).
    items.forEach((it, i) => {
      if (
        it.quantity > AI_QTY_CHECK_LIMIT ||
        quantityLooksLikeMoney(it.quantity, mentions)
      ) {
        checks.push({ code: 'qty_check', item_index: i });
      }
    });
    const itemKeys = new Map<string, number[]>();
    items.forEach((it, i) => {
      const key = it.product_id
        ? `p:${it.product_id}`
        : `n:${normalizeProduct(it.name)}`;
      itemKeys.set(key, [...(itemKeys.get(key) ?? []), i]);
    });
    for (const idxs of itemKeys.values()) {
      if (idxs.length > 1) {
        checks.push({ code: 'duplicate_items', item_indexes: idxs });
      }
    }
    if (phoneValid && marketPhones.has(phone)) {
      checks.push({ code: 'phone_is_market' });
    }

    const customerName = text(raw.customer_name);
    const issues = this.computeIssues({
      customerName,
      phoneValid,
      regionId,
      districtId,
      totalPrice,
      items,
    });

    return {
      index,
      ready: issues.length === 0,
      issues,
      customer_name: customerName,
      phone_number: phone,
      extra_number: extra,
      region_id: regionId,
      region_name: regionName,
      region_given: district?.region_given === true,
      district_id: districtId,
      district_name: districtName,
      district_candidates: districtCandidates,
      address: textOrNull(raw.address),
      items,
      total_price: totalPrice,
      price_confirmed: false,
      where_deliver: whereDeliver,
      comment,
      is_replacement: isReplacement,
      operator,
      // 5Z1ZvvzE: tumanni LLM fallback'i tanladi (faqat shu holatda kalit bor).
      ...(districtId && district?.llm_picked === true
        ? { district_source: 'ai' as const }
        : {}),
      // J3hEDtFN: AI noaniq deb belgilagan maydonlar — faqat enum (oq ro'yxat).
      warnings: sanitizeExtractWarnings(raw.warnings),
      district_match: districtMatch,
      region_inferred: raw.region_inferred === true,
      checks,
    };
  }

  /**
   * Kamchilik KALITLARI — frontend `evalPreview` bilan bir xil qoida va
   * tartib. ⚠️ UI uchun yagona manba frontend; bu yerdagi `ready`/`issues`
   * maslahat xarakterida (chegara `AI_PRICE_CONFIRM_THRESHOLD` bir xil).
   */
  private computeIssues(p: {
    customerName: string;
    phoneValid: boolean;
    regionId: string | null;
    districtId: string | null;
    totalPrice: number | null;
    items: readonly AiPreviewItem[];
  }): AiIssue[] {
    const issues: AiIssue[] = [];
    if (!p.customerName) issues.push('name_missing');
    if (!p.phoneValid) issues.push('phone_invalid');
    if (!p.regionId) issues.push('region_missing');
    if (!p.districtId) issues.push('district_missing');
    if (p.totalPrice === null) issues.push('price_missing');
    // price_confirmed backendda doim false — kichik/0 narx operator tasdig'isiz o'tmaydi.
    else if (p.totalPrice < AI_PRICE_CONFIRM_THRESHOLD)
      issues.push('price_confirm');
    if (p.items.length === 0) issues.push('items_missing');
    else if (!p.items.every((it) => it.product_id !== null))
      issues.push('item_unresolved');
    return issues;
  }

  /**
   * `resolve` dan keyingi tozalash — oxirgi tozalashdan (taymer yoki boshqa
   * `resolve`) 10 daqiqa o'tmagan bo'lsa o'tkazib yuboriladi.
   */
  private maybePrune(): void {
    if (Date.now() - this.lastPruneAt < AI_PREVIEW_PRUNE_INTERVAL_MS) return;
    this.prune();
  }

  /**
   * Preview PII qatorlarini (1 soatdan eski) tozalash — fire-and-forget.
   * Xato javobga ham, taymerga ham ta'sir qilmaydi, faqat WARN.
   * ⚠️ Taymer bu metodni throttle'siz chaqiradi: Node taymeri `Date.now()` ga
   * nisbatan 1 ms erta otilishi mumkin — throttle orqali o'tsa tik jimgina
   * o'tkazib yuborilib, tozalash 20 daqiqaga cho'zilardi.
   */
  private prune(): void {
    this.lastPruneAt = Date.now();
    const warn = (err: unknown) =>
      this.logger.warn(
        `AI preview kesh tozalash xato: ${(err as Error)?.message ?? 'unknown'}`,
      );
    try {
      void this.idempotencyService
        .prunePattern(AI_PREVIEW_PATTERN, AI_PREVIEW_RETENTION_MS)
        .catch(warn);
    } catch (err) {
      // Sinxron xato ham preview javobini yoki servis ishga tushishini
      // buzmasin.
      warn(err);
    }
  }
}
