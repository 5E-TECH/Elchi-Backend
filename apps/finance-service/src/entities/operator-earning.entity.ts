import { Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

/**
 * Per-order commission earned by the operator who created the order.
 *
 * Recorded by finance-service when order-service emits an earning event on a
 * sold order. The UNIQUE(order_id) constraint is the idempotency guard —
 * re-delivery of the same RMQ/outbox event, or an order bouncing between
 * SOLD↔PARTLY_PAID, must not double-credit the operator.
 *
 * Amount is a snapshot computed at sale time from the operator's commission
 * config; it is intentionally NOT recomputed if the operator's commission is
 * later changed, so historical earnings stay stable.
 */
@Entity({ name: 'operator_earnings' })
@Unique('UQ_OPERATOR_EARNING_ORDER', ['order_id'])
@Index('IDX_OPERATOR_EARNING_OPERATOR', ['operator_id'])
@Index('IDX_OPERATOR_EARNING_MARKET', ['market_id'])
export class OperatorEarning extends BaseEntity {
  @Column({ type: 'bigint' })
  operator_id!: string;

  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  amount!: number;

  /** Snapshot of how the amount was derived, for audit/debugging. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  commission_type!: string | null;

  // Dual-purpose snapshot (percent or fixed money) → money-sized numeric.
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  commission_value!: number | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  order_total_price!: number | null;
}
