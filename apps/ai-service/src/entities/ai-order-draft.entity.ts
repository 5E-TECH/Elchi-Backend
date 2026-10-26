import { numericTransformer } from '@app/common';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * AI BUYURTMA AUDIT IZI — bitta ai-parse = bitta qator (vncdmXOy).
 *
 * Savollarga javob: "qaysi xom matndan chiqdi, qaysi model ishladi, AI nimani
 * taklif qildi". "Operator nimani o'zgartirdi, kim tasdiqladi, qaysi buyurtma
 * bo'ldi" — `ai_order_draft_item` da. Nizo tekshiruvida ASOSIY manba shu
 * jadval: `activity_logs` yozuvi fire-and-forget, u faqat ustiga qo'shimcha.
 *
 * ⚠️ MAXFIYLIK (HD5zOyBp):
 * - `source_text` — Claude'ga AYNAN ketgan MASKALANGAN matn (telefonlar
 *   `[TEL_n]`), ya'ni bazada to'liq telefon raqami YO'Q. Ism/manzil bor →
 *   retention (`AI_DRAFT_TEXT_RETENTION_DAYS`) tugagach NULL bo'ladi.
 * - `source_hash` — ASL (maskalanmagan) matn + rasm xeshlarining sha256'i:
 *   matn o'chirilgandan keyin ham ayni xabarni (dublikatni) aniqlash uchun.
 * - `raw_extraction` — LLM xom chiqishi, telefonlar `[TEL_n]` tokenida.
 * - `resolved_preview` — gateway yuborgan kompakt snapshot: telefon faqat
 *   maskalangan ko'rinish + sha256 (edited_fields solishtiruvi uchun).
 * - RASM SAQLANMAYDI — faqat `image_count`.
 *
 * `id` = ai-parse javobidagi `draft_id` (gateway `randomUUID()`), BaseEntity
 * (bigint id) ishlatilmaydi.
 */
@Entity({ name: 'ai_order_draft', schema: 'ai_schema' })
@Index('IDX_AIDRAFT_MARKET_CREATED', ['market_id', 'created_at'])
@Index('IDX_AIDRAFT_SOURCE_HASH', ['source_hash'])
@Index('IDX_AIDRAFT_RETENTION', ['created_at'], {
  where: '"text_purged_at" IS NULL',
})
export class AiOrderDraft {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint', nullable: true })
  user_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  /** 'text' | 'image' (kamida bitta rasm bo'lsa 'image'). */
  @Column({ type: 'varchar', length: 16 })
  source_kind!: string;

  /** Maskalangan matn; retention tugagach NULL. */
  @Column({ type: 'text', nullable: true })
  source_text!: string | null;

  @Column({ type: 'char', length: 64 })
  source_hash!: string;

  @Column({ type: 'int', default: 0 })
  source_chars!: number;

  @Column({ type: 'int', default: 0 })
  image_count!: number;

  @Column({ type: 'varchar', length: 64 })
  model!: string;

  @Column({ type: 'varchar', length: 32 })
  prompt_version!: string;

  /** ok | refused | truncated | network | ai_error | cap_exceeded | disabled. */
  @Column({ type: 'varchar', length: 16, default: 'ok' })
  outcome!: string;

  /** LLM xom chiqishi (`{orders:[...]}`), retention tugagach NULL. */
  @Column({ type: 'jsonb', nullable: true })
  raw_extraction!: object | null;

  /** Gateway snapshot'i (AiDraftPreviewSnapshot[]), retention tugagach NULL. */
  @Column({ type: 'jsonb', nullable: true })
  resolved_preview!: object | null;

  @Column({ type: 'int', default: 0 })
  preview_count!: number;

  /**
   * WHMAIqyo #5: ai-parse bosqichlari (ms, gateway o'lchagan): extract =
   * `ai.order.extract` RPC, preview = `order.ai_resolve_preview`, total =
   * butun handler. Ustundan oldingi qatorlarda NULL.
   */
  @Column({ type: 'int', nullable: true })
  extract_ms!: number | null;

  @Column({ type: 'int', nullable: true })
  preview_ms!: number | null;

  @Column({ type: 'int', nullable: true })
  total_ms!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  text_purged_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

/**
 * Draft'dan yaratilgan HAR buyurtma uchun bitta qator — `ai_order_draft` ↔
 * `order` bog'lanishi (vncdmXOy "yangi xavf": activity_log fire-and-forget,
 * draft'da order_id yo'q edi). `order_id` UNIQUE — RMQ qayta yetkazishi
 * ikkinchi qator yozmaydi.
 */
@Entity({ name: 'ai_order_draft_item', schema: 'ai_schema' })
@Index('UQ_AIDRAFT_ITEM_ORDER', ['order_id'], { unique: true })
@Index('IDX_AIDRAFT_ITEM_DRAFT', ['draft_id', 'item_index'])
@Index('IDX_AIDRAFT_ITEM_CREATED', ['created_at'])
export class AiOrderDraftItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'uuid' })
  draft_id!: string;

  /** Preview'dagi `index` (ai-confirm `ai_item_index`); noma'lum bo'lsa null. */
  @Column({ type: 'int', nullable: true })
  item_index!: number | null;

  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  market_id!: string;

  /** Tasdiqlagan foydalanuvchi (JWT sub). */
  @Column({ type: 'bigint', nullable: true })
  confirmed_by!: string | null;

  /**
   * Server tomonda hisoblangan o'zgargan maydonlar (`['district_id', ...]`);
   * preview topilmasa null (solishtirib bo'lmadi).
   */
  @Column({ type: 'jsonb', nullable: true })
  edited_fields!: string[] | null;

  /**
   * J3hEDtFN #4 — operator tuzatishlari: `{ [maydon]: {ai, final} }` (faqat
   * o'zgarganlar; telefon maskalangan). Eval to'plami manbai. Ism/manzil bor
   * → `AI_DRAFT_TEXT_RETENTION_DAYS` tugagach NULL.
   */
  @Column({ type: 'jsonb', nullable: true })
  field_corrections!: Record<string, unknown> | null;

  /**
   * NFiXfmq6 — shu buyurtma uchun AMAL QILGAN narx (so'm): market
   * `ai_price_per_order` yoki global `AI_PRICE_PER_ORDER`, ai-confirm paytida
   * MUZLATILGAN (narx keyin o'zgarsa qayta hisoblanmaydi). 0 — bepul; NULL —
   * ustundan oldingi buyurtma (narx noma'lum). `order_id` UNIQUE — bitta
   * buyurtma ikki marta qayd qilinmaydi (Cp2v3ZJ7).
   */
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  applied_price_uzs!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
