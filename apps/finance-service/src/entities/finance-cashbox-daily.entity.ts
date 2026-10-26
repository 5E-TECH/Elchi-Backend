import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * qzjTMWPb (migratsiya 176) — kassa × Toshkent kuni: kun boshi / oxiri
 * qoldig'i va kunlik kirim-chiqim. O'QISH MODELI (pul harakati emas).
 *
 * Faqat kun oxiri qoldig'i ≠ 0 yoki shu kuni harakati bo'lgan kassa uchun
 * qator bor — qator yo'q = qoldiq 0 va harakat yo'q. Shu bois istalgan
 * kassalar to'plamining kun oxiri qoldig'i = shu kun qatorlari yig'indisi.
 */
@Entity({ name: 'finance_cashbox_daily' })
@Index(
  'UQ_FINANCE_CASHBOX_DAILY_DATE_CASHBOX',
  ['snapshot_date', 'cashbox_id'],
  {
    unique: true,
  },
)
@Index('IDX_FINANCE_CASHBOX_DAILY_CASHBOX_DATE', [
  'cashbox_id',
  'snapshot_date',
])
@Index('IDX_FINANCE_CASHBOX_DAILY_TYPE_DATE', ['cashbox_type', 'snapshot_date'])
export class FinanceCashboxDaily extends BaseEntity {
  @Column({ type: 'date' })
  snapshot_date!: string;

  @Column({ type: 'bigint' })
  cashbox_id!: string;

  @Column({ type: 'varchar', length: 16 })
  cashbox_type!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  opening_balance!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  closing_balance!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  closing_cash!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  closing_card!: number | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  income!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  expense!: number;

  @Column({ type: 'integer', default: 0 })
  income_count!: number;

  @Column({ type: 'integer', default: 0 })
  expense_count!: number;
}
