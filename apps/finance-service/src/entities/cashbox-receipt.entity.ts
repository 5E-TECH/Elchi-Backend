import { Column, Entity, Index } from 'typeorm';
import {
  BaseEntity,
  numericTransformer,
  type CashboxReceiptAiStatus,
  type CashboxReceiptKind,
  type CashboxReceiptState,
} from '@app/common';

const nullableMoney = {
  type: 'numeric' as const,
  precision: 20,
  scale: 2,
  nullable: true,
  transformer: numericTransformer,
};

/**
 * T3 (QlLf33Ma) — kassa cheki (migratsiya 1716000000188). Yuklanganda
 * `draft`, operatsiya saqlanganda `linked` (`history_id` — chiqim yoki MAIN
 * INCOME, `counter_history_id` — kuryer / filial EXPENSE). PUL HARAKATI EMAS.
 *
 * `linked` chek va fayli avtomatik o'chirilmaydi; cron faqat eski `draft`
 * ni tozalaydi.
 */
@Entity({ name: 'cashbox_receipts' })
@Index('UQ_CASHBOX_RECEIPTS_HISTORY', ['history_id'], {
  unique: true,
  where: '"is_deleted" = false AND "history_id" IS NOT NULL',
})
@Index('IDX_CASHBOX_RECEIPTS_COUNTER_HISTORY', ['counter_history_id'])
@Index('IDX_CASHBOX_RECEIPTS_STATE_UPLOADED', ['state', 'uploaded_at'])
@Index('IDX_CASHBOX_RECEIPTS_SHA256', ['file_sha256'])
@Index('IDX_CASHBOX_RECEIPTS_AI_REFERENCE', ['ai_reference'])
export class CashboxReceipt extends BaseEntity {
  @Column({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @Column({ type: 'varchar', length: 24 })
  kind!: CashboxReceiptKind;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  state!: CashboxReceiptState;

  @Column({ type: 'bigint', nullable: true })
  history_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  counter_history_id!: string | null;

  /** Qo'lda chiqim — menejer filiali (yuklashda JWT'dan); filial → HQ — filial. */
  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  card_id!: string | null;

  @Column(nullableMoney)
  entered_amount!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  payment_method!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  linked_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  linked_by!: string | null;

  @Column({ type: 'varchar', length: 500 })
  file_key!: string;

  @Column({ type: 'char', length: 64 })
  file_sha256!: string;

  @Column({ type: 'varchar', length: 32 })
  mime!: string;

  @Column({ type: 'int' })
  size_bytes!: number;

  @Column({ type: 'bigint' })
  uploaded_by!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  uploaded_at!: Date;

  @Column({ type: 'boolean', default: false })
  photo_required_snap!: boolean;

  @Column({ type: 'boolean', default: false })
  ai_enabled_snap!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'disabled' })
  ai_status!: CashboxReceiptAiStatus;

  /** Har tahlil so'rovida yangi UUID — eski natija yozilmaydi. */
  @Column({ type: 'uuid', nullable: true })
  ai_request_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  ai_requested_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  ai_attempts!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ai_error_reason!: string | null;

  @Column(nullableMoney)
  ai_amount!: number | null;

  /** o'qilgan − kiritilgan. */
  @Column(nullableMoney)
  ai_difference!: number | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  ai_currency!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  ai_date!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  ai_recipient!: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  ai_recipient_last4!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  ai_payer!: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  ai_payer_last4!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  ai_bank!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  ai_reference!: string | null;

  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  ai_confidence!: number | null;

  /** `duplicate_photo`, `duplicate_reference`, `date_far`, `card_mismatch`. */
  @Column({ type: 'jsonb', nullable: true })
  ai_flags!: string[] | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  ai_model!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  ai_checked_at!: Date | null;
}
