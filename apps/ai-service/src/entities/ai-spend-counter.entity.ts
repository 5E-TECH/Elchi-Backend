import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '@app/common';

/**
 * GLOBAL KUNLIK AVARIYA SHIFTI hisoblagichi (wFSMEIIy, PLAN §5.19).
 *
 * Bitta qator = bitta Toshkent kuni (`scope='global'`, `period_key`).
 * Har Anthropic javobidan keyin atomik
 * `INSERT ... ON CONFLICT (scope, period_key) DO UPDATE ... RETURNING`
 * bilan oshiriladi, AI chaqiruvidan OLDIN bitta PK lookup bilan o'qiladi.
 *
 * ⚠️ Hisoblagich XOTIRADA emas (restart/deploy nollamaydi) va Redis'da
 * emas (Elchida Redis yo'q) — Postgres'da.
 *
 * ⚠️ Market/foydalanuvchi kvotasi YO'Q (ega qarori 2026-09-19) — bu jadvalda
 * market_id/user_id ustuni ATAYLAB yo'q. Bu kvota emas, portlash radiusini
 * cheklaydigan to'xtatgich.
 */
@Entity({ name: 'ai_spend_counter', schema: 'ai_schema' })
export class AiSpendCounter {
  /** Hozircha faqat 'global'. */
  @PrimaryColumn({ type: 'varchar', length: 16, default: 'global' })
  scope!: string;

  /** Toshkent sanasi (YYYY-MM-DD). */
  @PrimaryColumn({ type: 'date' })
  period_key!: string;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  cost_usd!: number;

  @Column({
    type: 'numeric',
    precision: 16,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  cost_uzs!: number;

  /** Hisobga olingan Anthropic javoblari soni. */
  @Column({ type: 'int', default: 0 })
  calls!: number;

  /** SUPERADMIN'ning shu kun uchun "shiftni ko'tarish" qo'shimchasi (USD). */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  override_usd!: number;

  /** 80% ogohlantirish yuborilgan payt — kuniga BIR marta. */
  @Column({ type: 'timestamptz', nullable: true })
  warned_at!: Date | null;

  /** 100% (shift urilgan) bildirishnomasi yuborilgan payt — kuniga BIR marta. */
  @Column({ type: 'timestamptz', nullable: true })
  exceeded_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
