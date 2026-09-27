import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * AI XARAJAT JURNALI — HAR Anthropic JAVOBI uchun bitta qator (truncation
 * retry'si ham alohida qator, `steps` = urinish raqami). lYVuADRE.
 *
 * Maqsad: "bu AI buyurtma BIZGA necha so'mga tushdi va KIMGA yozilishi
 * kerak" savoliga jurnalning O'ZIDAN javob chiqsin.
 *
 * ⚠️ BeePostda 62/62 qatorda order_id/user_id NULL qolgan — meta ixtiyoriy
 * edi. Elchida `ClaudeUsageMeta` ning hamma kalitlari REQUIRED; biror
 * qiymat bo'sh kelsa ham qator yoziladi, lekin `meta_incomplete=true`.
 *
 * ⚠️ MAXFIYLIK: mijoz matnining O'ZI yozilmaydi — faqat `input_chars`,
 * `input_sha256` (maskalangan matnning xeshi) va `image_count`. Rasm
 * HECH QAYERDA saqlanmaydi.
 *
 * ⚠️ numeric ustunlar pg'dan SATR bo'lib keladi — HAMMASIDA
 * `numericTransformer` (aks holda SUM satr konkatenatsiyasiga aylanadi).
 * Kurs (`usd_uzs_rate`) qatorda saqlanadi — keyin o'zgarsa eski yozuvlar
 * qayta hisoblanmaydi (audit).
 *
 * Yozish FIRE-AND-FORGET (`AiUsageService.record`) — global shift bu
 * jadvalga TAYANMAYDI (u `ai_spend_counter` da, sinxron).
 */
@Entity({ name: 'ai_usage_log', schema: 'ai_schema' })
@Index('IDX_AIUSAGE_MARKET_CREATED', ['market_id', 'createdAt'])
@Index('IDX_AIUSAGE_FEATURE_CREATED', ['feature', 'createdAt'])
@Index('IDX_AIUSAGE_AREA_CREATED', ['request_area', 'createdAt'])
@Index('IDX_AIUSAGE_DRAFT', ['draft_id'], { where: '"draft_id" IS NOT NULL' })
export class AiUsageLog extends BaseEntity {
  /** Aniq AI amali (`AiFeature`), masalan `order_extract_multi`. */
  @Column({ type: 'varchar', length: 40 })
  feature!: string;

  /** Qo'pol guruh (`AiRequestArea`): order | bot | other. */
  @Column({ type: 'varchar', length: 16, default: 'other' })
  request_area!: string;

  /** So'ralgan model id (masalan `claude-sonnet-5`). */
  @Column({ type: 'varchar', length: 64 })
  model!: string;

  // ─── Tokenlar — Anthropic `usage` qiymatlariga AYNAN teng ───
  @Column({ type: 'int', default: 0 })
  input_tokens!: number;

  @Column({ type: 'int', default: 0 })
  output_tokens!: number;

  @Column({ type: 'int', default: 0 })
  cache_creation_tokens!: number;

  @Column({ type: 'int', default: 0 })
  cache_read_tokens!: number;

  /** Urinish raqami (1 yoki 2 — truncation retry). */
  @Column({ type: 'int', default: 1 })
  steps!: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  stop_reason!: string | null;

  /** ok | refused | truncated | invalid_json. */
  @Column({ type: 'varchar', length: 16, default: 'ok' })
  outcome!: string;

  // ─── Pul ───
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  cost_usd!: number;

  /** Prompt caching tejagan summa: cache_read × in × 0.9 / 1M. */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  cache_saved_usd!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  cost_uzs!: number;

  /** Yozuv paytidagi kurs (AI_USD_UZS_RATE). */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  usd_uzs_rate!: number;

  /**
   * Market uchun AMAL QILGAN narx (AI_ORDER_PRICE_UZS) — faqat
   * `order_extract_*` uchun; boshqa amallarda null.
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  applied_price_uzs!: number | null;

  // ─── Bog'lash (MAJBURIY meta) ───
  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  user_id!: string | null;

  /** ai-parse javobidagi draft_id — ai-confirm'dan keyin order_ids bog'lanadi. */
  @Column({ type: 'uuid', nullable: true })
  draft_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  /** `ai.usage.link_orders` to'ldiradi (ai-confirm natijasi). */
  @Column({ type: 'bigint', array: true, default: () => "'{}'" })
  order_ids!: string[];

  /** marketId/userId/traceId/draftId dan biri bo'sh bo'lsa true. */
  @Column({ type: 'boolean', default: false })
  meta_incomplete!: boolean;

  // ─── Kirish metama'lumoti (xom matn YO'Q) ───
  @Column({ type: 'int', nullable: true })
  input_chars!: number | null;

  @Column({ type: 'char', length: 64, nullable: true })
  input_sha256!: string | null;

  @Column({ type: 'int', default: 0 })
  image_count!: number;
}
