import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import {
  AI_AUDITED_FIELDS,
  type AiAuditedField,
  type AiDraftConfirmContext,
  type AiDraftLinkItem,
  type AiDraftPreviewSnapshot,
  type AiDraftTrace,
} from '@app/common';
import {
  AiOrderDraft,
  AiOrderDraftItem,
} from '../entities/ai-order-draft.entity';

/**
 * vncdmXOy #6 (HD5zOyBp #6): `source_text`, `raw_extraction`,
 * `resolved_preview` (ism/manzil bor) shuncha kundan keyin NULL bo'ladi;
 * `source_hash`, model, prompt versiyasi va `ai_order_draft_item`
 * (order_id, edited_fields) QOLADI.
 *
 * ⚠️ QAROR KERAK: aniq N ega tomonidan belgilanmagan — 30 kun (nizo/xato
 * tekshiruvi oynasi). Env kaliti ATAYLAB yo'q (ega: retention env kalitlari
 * qo'shilmaydi, ai-validation.spec qulflagan) — o'zgartirish kod orqali.
 */
export const AI_DRAFT_TEXT_RETENTION_DAYS = 30;
/** Retention tozalash davri — 6 soat (va servis ishga tushganda bir marta). */
export const AI_DRAFT_PURGE_INTERVAL_MS = 6 * 3_600_000;

/** Bitta draft'dagi maksimal snapshot (AI_MAX_ORDERS_PER_PARSE bilan bir xil). */
const MAX_PREVIEWS = 30;
const MAX_LINK_ITEMS = 30;
const MAX_SOURCE_CHARS = 8_000;
const DIGITS_RE = /^\d{1,19}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const AUDITED = new Set<string>(AI_AUDITED_FIELDS);

/** Retention UPDATE — `source_hash` ga TEGMAYDI (TC12). */
export const AI_DRAFT_PURGE_SQL = `
  UPDATE ai_schema.ai_order_draft
  SET source_text = NULL,
      raw_extraction = NULL,
      resolved_preview = NULL,
      text_purged_at = now(),
      updated_at = now()
  WHERE text_purged_at IS NULL
    AND created_at < now() - ($1::int * interval '1 day')
`;

/** draft_id bo'yicha REAL xarajat — `ai_usage_log` JOIN (vncdmXOy #4, TC10). */
export const AI_DRAFT_COST_SQL = `
  SELECT draft_id::text AS draft_id,
         COUNT(*)::int AS calls,
         COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
         COALESCE(SUM(cost_uzs), 0)::float8 AS cost_uzs
  FROM ai_schema.ai_usage_log
  WHERE draft_id = ANY($1::uuid[]) AND is_deleted = false
  GROUP BY draft_id
`;

/** draft ↔ buyurtma; RMQ qayta yetkazishida ikkinchi qator yozilmaydi. */
export const AI_DRAFT_LINK_ITEM_SQL = `
  INSERT INTO ai_schema.ai_order_draft_item
    (draft_id, item_index, order_id, market_id, confirmed_by, edited_fields)
  SELECT $1::uuid, $2::int, $3::bigint, $4::bigint, $5::bigint, $6::jsonb
  WHERE EXISTS (
    SELECT 1 FROM ai_schema.ai_order_draft d
    WHERE d.id = $1::uuid AND d.market_id = $4::bigint
  )
  ON CONFLICT (order_id) DO NOTHING
  RETURNING id
`;

export interface RecordExtractionInput {
  draftId: unknown;
  marketId: unknown;
  userId: unknown;
  traceId: unknown;
  /** Maskalangan matn (Claude'ga ketgani). */
  maskedText: string;
  /** Asl matn — FAQAT xesh uchun, saqlanmaydi. */
  originalText: string;
  /** Rasmlarning base64'i — FAQAT xesh uchun, saqlanmaydi. */
  imagesBase64: string[];
  model: string;
  promptVersion: string;
  outcome: string;
  /** LLM xom chiqishi (`[TEL_n]` tokenlari bilan) yoki null. */
  rawExtraction: unknown;
}

type Row = Record<string, unknown>;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'non-error throw';
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function idOrNull(value: unknown): string | null {
  const s = str(value, 19);
  return s && DIGITS_RE.test(s) ? s : null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Asl matn + rasm xeshlari bo'yicha sha256 (vncdmXOy TC3): bir xil matn —
 * bir xil xesh, bitta belgi o'zgarsa boshqa. Rasmsiz holatda AYNAN
 * `sha256(matn)`.
 */
export function aiSourceHash(text: string, imagesBase64: string[]): string {
  const h = createHash('sha256').update(text, 'utf8');
  for (const img of imagesBase64) {
    h.update('\u0000', 'utf8');
    h.update(createHash('sha256').update(img, 'utf8').digest('hex'), 'utf8');
  }
  return h.digest('hex');
}

/** Gateway snapshot'ini runtime'da tekshiradi — oq ro'yxat bo'yicha qayta yig'iladi. */
export function sanitizeSnapshot(
  value: unknown,
): AiDraftPreviewSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Row;
  const index = Number(v.index);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PREVIEWS) {
    return null;
  }
  const sha = (x: unknown): string | null =>
    typeof x === 'string' && SHA_RE.test(x) ? x : null;
  const price = v.total_price === null ? NaN : Number(v.total_price);
  const items = Array.isArray(v.items) ? v.items.slice(0, 50) : [];
  return {
    index,
    customer_name: str(v.customer_name, 255),
    phone_masked: str(v.phone_masked, 32),
    phone_sha256: sha(v.phone_sha256),
    extra_masked: str(v.extra_masked, 32),
    extra_sha256: sha(v.extra_sha256),
    region_id: idOrNull(v.region_id),
    district_id: idOrNull(v.district_id),
    address: str(v.address, 500),
    total_price: Number.isFinite(price) ? price : null,
    where_deliver: str(v.where_deliver, 16),
    comment: str(v.comment, 1000),
    operator: str(v.operator, 100),
    is_replacement: v.is_replacement === true,
    items: items
      .filter((it): it is Row => !!it && typeof it === 'object')
      .map((it) => ({
        name: str(it.name, 255) ?? '',
        product_id: idOrNull(it.product_id),
        quantity: Math.max(0, Math.round(num(it.quantity))),
      })),
  };
}

function sanitizeEditedFields(value: unknown): AiAuditedField[] | null {
  if (!Array.isArray(value)) return null;
  const fields = value.filter(
    (f): f is AiAuditedField => typeof f === 'string' && AUDITED.has(f),
  );
  return AI_AUDITED_FIELDS.filter((f) => fields.includes(f));
}

function snapshotsOf(value: unknown): AiDraftPreviewSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((v) => sanitizeSnapshot(v))
    .filter((v): v is AiDraftPreviewSnapshot => v !== null);
}

/**
 * AI BUYURTMA AUDIT IZI (vncdmXOy) — `ai_order_draft` va
 * `ai_order_draft_item`.
 *
 * ⚠️ `recordExtraction` FIRE-AND-FORGET va HECH QACHON throw qilmaydi:
 * draft yozilmasa ham AI javobi foydalanuvchiga boradi (faqat WARN). Draft
 * ai-parse'da hech narsa YARATMAYDI — buyurtma faqat ai-confirm'da.
 */
@Injectable()
export class AiDraftService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiDraftService.name);
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(AiOrderDraft)
    private readonly drafts: Repository<AiOrderDraft>,
    @InjectRepository(AiOrderDraftItem)
    private readonly items: Repository<AiOrderDraftItem>,
  ) {}

  onModuleInit(): void {
    if (this.purgeTimer) return;
    void this.purgeExpiredText();
    this.purgeTimer = setInterval(() => {
      void this.purgeExpiredText();
    }, AI_DRAFT_PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  /**
   * ai.order.extract natijasi. Promise HECH QACHON reject bo'lmaydi (xato
   * faqat WARN). Chaqiruvchi uni kutadi (bir necha ms) — gateway'ning
   * `ai.draft.attach_preview` UPDATE'i qator yozilishidan OLDIN kelib qolmasin.
   */
  async recordExtraction(input: RecordExtractionInput): Promise<void> {
    try {
      const id = typeof input.draftId === 'string' ? input.draftId.trim() : '';
      const marketId = idOrNull(input.marketId);
      if (!UUID_RE.test(id) || !marketId) return;
      const images = Array.isArray(input.imagesBase64)
        ? input.imagesBase64
        : [];
      const row: Partial<AiOrderDraft> = {
        id,
        market_id: marketId,
        user_id: idOrNull(input.userId),
        trace_id: str(input.traceId, 64),
        source_kind: images.length > 0 ? 'image' : 'text',
        source_text:
          (input.maskedText ?? '').slice(0, MAX_SOURCE_CHARS) || null,
        source_hash: aiSourceHash(input.originalText ?? '', images),
        source_chars: (input.originalText ?? '').length,
        image_count: images.length,
        model: String(input.model ?? '').slice(0, 64),
        prompt_version: String(input.promptVersion ?? '').slice(0, 32),
        outcome: String(input.outcome ?? 'ok').slice(0, 16),
        raw_extraction: (input.rawExtraction ?? null) as object | null,
      };
      await this.drafts
        .createQueryBuilder()
        .insert()
        .into(AiOrderDraft)
        .values(row)
        .orIgnore()
        .execute();
    } catch (err) {
      this.logger.warn(`ai_draft_persist_failed: ${describeError(err)}`);
    }
  }

  /** `ai.draft.attach_preview` — AI taklifining snapshot'i (faqat o'z marketi). */
  async attachPreview(
    draftId: unknown,
    marketId: unknown,
    previews: unknown,
  ): Promise<{ updated: number }> {
    const id = typeof draftId === 'string' ? draftId.trim() : '';
    const market = idOrNull(marketId);
    const list = Array.isArray(previews)
      ? (snapshotsOf(previews.slice(0, MAX_PREVIEWS)) ?? [])
      : [];
    if (!UUID_RE.test(id) || !market) return { updated: 0 };
    const result = await this.drafts.update(
      { id, market_id: market },
      { resolved_preview: list, preview_count: list.length },
    );
    return { updated: result.affected ?? 0 };
  }

  /**
   * `ai.draft.confirm_context` — ai-confirm'dagi audit metadata uchun:
   * model, prompt versiyasi, snapshot va `ai_usage_log` JOIN xarajati.
   * Boshqa marketning draft'i QAYTMAYDI.
   */
  async confirmContext(
    marketId: unknown,
    draftIds: unknown,
  ): Promise<{ drafts: AiDraftConfirmContext[] }> {
    const market = idOrNull(marketId);
    const ids = Array.isArray(draftIds)
      ? [
          ...new Set(
            draftIds
              .filter((d): d is string => typeof d === 'string')
              .map((d) => d.trim())
              .filter((d) => UUID_RE.test(d)),
          ),
        ].slice(0, MAX_PREVIEWS)
      : [];
    if (!market || ids.length === 0) return { drafts: [] };

    const rows: Row[] = await this.drafts.query(
      `SELECT id::text AS id, model, prompt_version, preview_count, resolved_preview
       FROM ai_schema.ai_order_draft
       WHERE id = ANY($1::uuid[]) AND market_id = $2::bigint`,
      [ids, market],
    );
    if (!Array.isArray(rows) || rows.length === 0) return { drafts: [] };
    const costs = await this.costByDraft(rows.map((r) => String(r.id)));
    return {
      drafts: rows.map((r) => {
        const cost = costs.get(String(r.id));
        return {
          draft_id: String(r.id),
          model: str(r.model, 64) ?? '',
          prompt_version: str(r.prompt_version, 32) ?? '',
          preview_count: num(r.preview_count),
          cost_usd: round6(cost?.cost_usd ?? 0),
          cost_uzs: round2(cost?.cost_uzs ?? 0),
          previews: snapshotsOf(r.resolved_preview),
        };
      }),
    };
  }

  /**
   * Yaratilgan buyurtmalarni draft'ga bog'laydi (`ai.usage.link_orders`
   * `items`). Draft boshqa marketniki yoki yo'q bo'lsa — yozilmaydi.
   */
  async linkItems(
    draftId: unknown,
    marketId: unknown,
    items: unknown,
    confirmedBy?: unknown,
  ): Promise<{ linked: number }> {
    const id = typeof draftId === 'string' ? draftId.trim() : '';
    const market = idOrNull(marketId);
    if (!UUID_RE.test(id) || !market || !Array.isArray(items)) {
      return { linked: 0 };
    }
    let linked = 0;
    for (const raw of items.slice(0, MAX_LINK_ITEMS)) {
      const item = (raw ?? {}) as Partial<AiDraftLinkItem>;
      const orderId = idOrNull(item.order_id);
      if (!orderId) continue;
      const idx = Number(item.item_index);
      const edited = sanitizeEditedFields(item.edited_fields);
      const result: unknown = await this.items.query(AI_DRAFT_LINK_ITEM_SQL, [
        id,
        Number.isInteger(idx) && idx >= 0 ? idx : null,
        orderId,
        market,
        idOrNull(confirmedBy),
        edited === null ? null : JSON.stringify(edited),
      ]);
      // INSERT … RETURNING — TypeORM faqat qatorlarni qaytaradi.
      linked += Array.isArray(result) ? result.length : 0;
    }
    return { linked };
  }

  /** `ai.draft.trace_by_order` — buyurtma AI'dan yaratilmagan bo'lsa null. */
  async traceByOrder(orderId: unknown): Promise<AiDraftTrace | null> {
    const id = idOrNull(orderId);
    if (!id) return null;
    const item = await this.items.findOne({ where: { order_id: id } });
    if (!item) return null;
    const draft = await this.drafts.findOne({ where: { id: item.draft_id } });
    if (!draft) return null;
    const [costs, linkedOrders] = await Promise.all([
      this.costByDraft([draft.id]),
      this.items.count({ where: { draft_id: draft.id } }),
    ]);
    const cost = costs.get(draft.id);
    const draftCostUzs = round2(cost?.cost_uzs ?? 0);
    const previews = snapshotsOf(draft.resolved_preview);
    const suggestion =
      previews && item.item_index !== null
        ? (previews.find((p) => p.index === item.item_index) ?? null)
        : null;
    return {
      order_id: String(item.order_id),
      draft_id: draft.id,
      item_index: item.item_index,
      market_id: String(draft.market_id),
      user_id: draft.user_id === null ? null : String(draft.user_id),
      confirmed_by:
        item.confirmed_by === null ? null : String(item.confirmed_by),
      confirmed_at: new Date(item.created_at).toISOString(),
      created_at: new Date(draft.created_at).toISOString(),
      source_kind: draft.source_kind,
      source_text: draft.source_text,
      source_hash: draft.source_hash,
      source_purged: draft.text_purged_at !== null,
      image_count: draft.image_count,
      model: draft.model,
      prompt_version: draft.prompt_version,
      outcome: draft.outcome,
      ai_suggestion: suggestion,
      edited_fields: sanitizeEditedFields(item.edited_fields),
      cost: {
        draft_cost_usd: round6(cost?.cost_usd ?? 0),
        draft_cost_uzs: draftCostUzs,
        calls: cost?.calls ?? 0,
        linked_orders: linkedOrders,
        order_cost_uzs: round2(draftCostUzs / Math.max(1, linkedOrders)),
      },
    };
  }

  /** Retention — xato taymerni/servisni buzmaydi (faqat WARN). */
  async purgeExpiredText(): Promise<number> {
    try {
      const result: unknown = await this.drafts.query(AI_DRAFT_PURGE_SQL, [
        AI_DRAFT_TEXT_RETENTION_DAYS,
      ]);
      const n = affectedOf(result);
      if (n > 0) this.logger.log(`ai_draft_text_purged count=${n}`);
      return n;
    } catch (err) {
      this.logger.warn(`ai_draft_purge_failed: ${describeError(err)}`);
      return 0;
    }
  }

  private async costByDraft(
    ids: string[],
  ): Promise<
    Map<string, { calls: number; cost_usd: number; cost_uzs: number }>
  > {
    const out = new Map<
      string,
      { calls: number; cost_usd: number; cost_uzs: number }
    >();
    if (ids.length === 0) return out;
    const rows: unknown = await this.drafts.query(AI_DRAFT_COST_SQL, [ids]);
    for (const r of Array.isArray(rows) ? (rows as Row[]) : []) {
      out.set(String(r.draft_id), {
        calls: num(r.calls),
        cost_usd: num(r.cost_usd),
        cost_uzs: num(r.cost_uzs),
      });
    }
    return out;
  }
}

/** INSERT/UPDATE natijasidan ta'sirlangan qatorlar (TypeORM: [rows, count]). */
function affectedOf(result: unknown): number {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return 0;
}
