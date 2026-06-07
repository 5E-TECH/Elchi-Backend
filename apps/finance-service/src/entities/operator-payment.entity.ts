import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * A payout to an operator against their accrued earnings. An operator's
 * outstanding balance is SUM(earnings) - SUM(payments). Unlike earnings,
 * payments are not tied to a single order — an admin pays out an arbitrary
 * amount, optionally with a note.
 */
@Entity({ name: 'operator_payments' })
@Index('IDX_OPERATOR_PAYMENT_OPERATOR', ['operator_id'])
@Index('IDX_OPERATOR_PAYMENT_MARKET', ['market_id'])
@Index('IDX_OPERATOR_PAYMENT_CREATED', ['createdAt'])
export class OperatorPayment extends BaseEntity {
  @Column({ type: 'bigint' })
  operator_id!: string;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  /** Admin/user who recorded the payout. */
  @Column({ type: 'bigint', nullable: true })
  paid_by_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ type: 'text', nullable: true })
  note!: string | null;
}
