import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

export const PAYMENT_CORRECTION_ACTIONS = ['reverse', 'edit'] as const;
export type PaymentCorrectionAction =
  (typeof PAYMENT_CORRECTION_ACTIONS)[number];

export const PAYMENT_CORRECTION_KINDS = [
  'courier_payment',
  'market_payment',
] as const;
export type PaymentCorrectionKind = (typeof PAYMENT_CORRECTION_KINDS)[number];

/**
 * T6 (migratsiya 186) — to'lovni qaytarish / summasini tuzatish jurnali.
 *
 * Hech narsa o'chirilmaydi: asl oyoqlar (`original_transfer_id`) o'z
 * holicha qoladi, teskari qatorlar `reversal_transfer_id` ostida, tahrirda
 * yangi summali to'lov `replacement_transfer_id` ostida. `root_transfer_id` /
 * `root_created_at` — tahrir zanjirining BIRINCHI to'lovi (muddat shundan
 * hisoblanadi). `original_transfer_id` UNIQUE — bitta to'lov bir marta
 * tuzatiladi; `idempotency_key` UNIQUE — o'sha so'rov pulni bir marta
 * ko'chiradi.
 */
@Entity({ name: 'payment_corrections' })
@Index('UQ_PAYMENT_CORRECTIONS_ORIGINAL', ['original_transfer_id'], {
  unique: true,
})
@Index('UQ_PAYMENT_CORRECTIONS_IDEMPOTENCY', ['idempotency_key'], {
  unique: true,
})
@Index('IDX_PAYMENT_CORRECTIONS_REVERSAL', ['reversal_transfer_id'])
@Index('IDX_PAYMENT_CORRECTIONS_REPLACEMENT', ['replacement_transfer_id'], {
  where: 'replacement_transfer_id IS NOT NULL',
})
export class PaymentCorrection extends BaseEntity {
  @Column({ type: 'varchar', length: 16 })
  action!: PaymentCorrectionAction;

  @Column({ type: 'varchar', length: 32 })
  payment_kind!: PaymentCorrectionKind;

  @Column({ type: 'uuid' })
  original_transfer_id!: string;

  @Column({ type: 'uuid' })
  root_transfer_id!: string;

  @Column({ type: 'uuid' })
  reversal_transfer_id!: string;

  @Column({ type: 'uuid', nullable: true })
  replacement_transfer_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    transformer: numericTransformer,
  })
  original_amount!: number;

  @Column({
    type: 'numeric',
    precision: 20,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  new_amount!: number | null;

  @Column({ type: 'varchar', length: 32 })
  payment_method!: string;

  /** Kuryer (kuryer to'lovi) yoki market (marketga to'lov) user id si. */
  @Column({ type: 'bigint' })
  counterparty_user_id!: string;

  /** Pul qabul qilgan / bergan MAIN yoki BRANCH kassa. */
  @Column({ type: 'bigint' })
  receiver_cashbox_id!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'bigint' })
  created_by!: string;

  @Column({ type: 'varchar', length: 255 })
  idempotency_key!: string;

  @Column({ type: 'timestamptz' })
  root_created_at!: Date;
}
