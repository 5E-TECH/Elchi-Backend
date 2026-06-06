import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer, SettlementStatus } from '@app/common';

/**
 * Per-order settlement state along the COD chain courier → branch → HQ → market.
 *
 * One row per sold order, created (PENDING) at sale time. Lump-sum settlement
 * payments are FIFO-allocated to the oldest unsettled orders, advancing each
 * order through the legs and stamping who/when. Rollback is allowed only while
 * an order has not yet reached BRANCH_SETTLED (HQ not yet paid).
 *
 * Amounts are snapshotted from the sale so settlement and rollback stay exact
 * even if tariffs/shares later change:
 *   courier_amount = total − courierShare           (courier owes the branch)
 *   branch_amount  = total − courierShare − branchShare (branch owes HQ)
 *   market_amount  = total − marketTariff            (HQ owes the market)
 */
@Entity({ name: 'order_settlement' })
@Index('IDX_order_settlement_order_id', ['order_id'], { unique: true })
@Index('IDX_order_settlement_status', ['status'])
@Index('IDX_order_settlement_courier', ['courier_id'])
@Index('IDX_order_settlement_branch', ['branch_id'])
@Index('IDX_order_settlement_market', ['market_id'])
export class OrderSettlement extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  courier_amount!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  branch_amount!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  market_amount!: number;

  @Column({
    type: 'enum',
    enum: SettlementStatus,
    default: SettlementStatus.PENDING,
  })
  status!: SettlementStatus;

  @Column({ type: 'timestamptz', nullable: true })
  courier_to_branch_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  courier_to_branch_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  branch_to_hq_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  branch_to_hq_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  hq_to_market_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  hq_to_market_by!: string | null;
}
