import { Column, Entity, Index } from 'typeorm';
import {
  BaseEntity,
  FinancialSource_type,
  numericTransformer,
} from '@app/common';

/**
 * Append-only ledger of the company's overall financial position.
 *
 * Distinct from cashbox_history (which tracks movements of one cashbox): this
 * is the company-wide P&L ledger. Each row is one financially-significant
 * event — an order's profit, a manual income/expense, a salary payout, a
 * correction — with the running balance snapshotted before and after.
 *
 * Self-consistent: balance_after = previous row's balance_after + amount.
 * `amount` is signed (+income / -expense). Reading the latest row's
 * balance_after gives the current financial position in O(1) without
 * re-summing every cashbox.
 */
@Entity({ name: 'financial_balance_history' })
@Index('IDX_FBH_CREATED_AT', ['createdAt'])
@Index('IDX_FBH_SOURCE_TYPE', ['source_type'])
@Index('IDX_FBH_ORDER', ['order_id'])
export class FinancialBalanceHistory extends BaseEntity {
  // numeric(20,2) — exact fixed-point so the running P&L ledger
  // (balance_after = balance_before + amount) never drifts. API stays `number`.
  /** Signed impact on the financial balance (+income, -expense). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  amount!: number;

  /** Running balance immediately before this entry. */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  balance_before!: number;

  /** Running balance immediately after this entry (= balance_before + amount). */
  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  balance_after!: number;

  /**
   * Urinish tokeni — daftar idempotentligining ikkinchi o'lchovi (audit M4).
   *
   * Yagona indeks `(source_type, order_id, dedup_key)`. Takroriy yetkazish ayni
   * token bilan keladi va bir marta yoziladi; sotuv → rollback → qayta sotuv
   * zanjirida esa har urinish o'z tokeni bilan keladi, ya'ni yangi foyda
   * yozuvi jimgina o'tkazib yuborilmaydi. Bo'sh qiymat — eski xatti-harakat
   * (buyurtma boshiga bitta yozuv).
   */
  @Column({ type: 'varchar', default: '' })
  dedup_key!: string;

  @Column({ type: 'enum', enum: FinancialSource_type })
  source_type!: FinancialSource_type;

  /** Linked order, when the entry originates from an order (SELL_PROFIT, CORRECTION). */
  @Column({ type: 'bigint', nullable: true })
  order_id!: string | null;

  /** Linked user (market / courier / employee), when relevant. */
  @Column({ type: 'bigint', nullable: true })
  related_user_id!: string | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  /** Actor who triggered the entry; null for system-generated entries. */
  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;
}
