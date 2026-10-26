import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { ShiftAccountAiStatus } from './shift-account-check.types';

export { ShiftAccountAiStatus };

const nullableMoney = {
  type: 'numeric' as const,
  precision: 20,
  scale: 2,
  nullable: true,
  transformer: numericTransformer,
};

/**
 * kiZgTybn — smena × karta qoldig'ini tasdiqlash qatori (UNIQUE shift+card).
 * Rasm yuklanganda QORALAMA, yopishda yakuniy. PUL HARAKATI EMAS.
 */
@Entity({ name: 'shift_account_checks' })
@Index('UQ_SHIFT_ACCOUNT_CHECK_SHIFT_CARD', ['shift_id', 'cashbox_card_id'], {
  unique: true,
})
export class ShiftAccountCheck extends BaseEntity {
  @Column({ type: 'bigint' })
  shift_id!: string;

  @Column({ type: 'bigint' })
  cashbox_card_id!: string;

  /** Tizim qoldig'i SNAPSHOT'i (rasm yuklanganda, yopishda qayta yoziladi). */
  @Column(nullableMoney)
  expected_balance!: number | null;

  @Column(nullableMoney)
  entered_balance!: number | null;

  /** entered − expected. */
  @Column(nullableMoney)
  difference!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  photo_file_key!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  photo_uploaded_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  photo_uploaded_by!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'not_required' })
  ai_status!: ShiftAccountAiStatus;

  /** Har rasm yuklashda yangi UUID — eski rasmning kechikkan natijasi yozilmaydi. */
  @Column({ type: 'uuid', nullable: true })
  ai_request_id!: string | null;

  @Column(nullableMoney)
  ai_read_balance!: number | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  ai_last4_detected!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  ai_date_detected!: string | null;

  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  ai_confidence!: number | null;

  /** Kassir kiritgan qiymat rasmdagisi bilan bir xilmi (|farq| ≤ 1 so'm). */
  @Column({ type: 'boolean', nullable: true })
  ai_entered_ok!: boolean | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  ai_model!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  ai_checked_at!: Date | null;

  /** Faqat {balance, last4, date, confidence, reason} — PII YO'Q. */
  @Column({ type: 'jsonb', nullable: true })
  ai_raw!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'boolean', default: false })
  photo_required_snap!: boolean;

  @Column({ type: 'boolean', default: false })
  ai_enabled_snap!: boolean;

  /** Smena yopilganda (yakuniy tasdiq) — qoralamada NULL. */
  @Column({ type: 'timestamptz', nullable: true })
  confirmed_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  confirmed_by!: string | null;
}
