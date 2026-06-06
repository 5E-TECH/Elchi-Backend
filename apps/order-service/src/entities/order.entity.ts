import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderItem } from './order-item.entity';
import { OrderTracking } from './order-tracking.entity';
import { Branch } from './branch.entity';
import { OrderCustodyEvent } from './order-custody-event.entity';

export enum Order_source {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  BRANCH = 'branch',
}

export enum OrderHolderType {
  HQ = 'HQ',
  BRANCH = 'BRANCH',
  COURIER = 'COURIER',
}

@Entity({ name: 'orders' })
@Index('IDX_ORDER_DELETED_AT', ['deleted_at'], {
  where: 'deleted_at IS NOT NULL',
})
export class Order extends BaseEntity {
  @Column({ type: 'bigint' })
  market_id!: string;

  @Column({ type: 'bigint' })
  customer_id!: string;

  @Column({ type: 'int', default: 0 })
  product_quantity!: number;

  @Column({ type: 'enum', enum: Where_deliver, default: Where_deliver.CENTER })
  where_deliver!: Where_deliver;

  @Column({ type: 'float', default: 0 })
  total_price!: number;

  @Column({ type: 'float', nullable: true })
  market_tariff!: number | null;

  @Column({ type: 'float', nullable: true })
  courier_tariff!: number | null;

  /**
   * Amount the courier KEEPS for this order, snapshotted at sale time per the
   * courier's compensation mode (= tariff for per-order modes, 0 for
   * salary-only). Distinct from courier_tariff (the configured tariff value).
   * Used for exact settlement and rollback math.
   */
  @Column({ type: 'float', nullable: true })
  courier_share!: number | null;

  /**
   * Amount the (PARTNER) branch KEEPS for this order, snapshotted at sale time
   * (= Branch.per_order_share for PARTNER branches, 0 for OWNED / HQ).
   */
  @Column({ type: 'float', nullable: true })
  branch_share!: number | null;

  @Column({ type: 'int', default: 0 })
  to_be_paid!: number;

  @Column({ type: 'int', default: 0 })
  paid_amount!: number;

  @Column({ type: 'enum', enum: Order_status, default: Order_status.NEW })
  status!: Order_status;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'varchar', nullable: true })
  operator!: string | null;

  @Column({ type: 'bigint', nullable: true })
  operator_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  post_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  canceled_post_id!: string | null;

  @Column({ type: 'boolean', default: false })
  return_requested!: boolean;

  // MinIO object keys of proof files (image/video) attached to the most recent
  // proof-required sell/cancel operation on this order. Covers proof conditions
  // that produce no expense (e.g. cancelling a zero-total order). Expense-bearing
  // proofs are additionally stored on the matching cashbox_history row.
  @Column({ type: 'jsonb', nullable: true })
  proof_files!: string[] | null;

  @Column({ type: 'bigint', nullable: true })
  sold_at!: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  /**
   * The order's home (owning/creating) branch — the branch the market submitted
   * it to. Set once at creation and never overwritten, unlike `branch_id` which
   * tracks the current physical location. Drives the return-to-market rules
   * (market may collect at HQ or at the home branch).
   */
  @Column({ type: 'bigint', nullable: true })
  home_branch_id!: string | null;

  @ManyToOne(() => Branch, {
    nullable: true,
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch | null;

  @Column({ type: 'bigint', nullable: true })
  current_batch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at!: Date | null;

  @Column({ type: 'enum', enum: OrderHolderType, default: OrderHolderType.HQ })
  holder_type!: OrderHolderType;

  @Column({ type: 'bigint', nullable: true })
  holder_branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  holder_courier_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_handover_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  last_handover_by!: string | null;

  @Column({ type: 'text', nullable: true })
  return_reason!: string | null;

  @Column({ type: 'varchar', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  qr_code_token!: string | null;

  @Column({ type: 'bigint', nullable: true })
  parent_order_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  external_id!: string | null;

  @Column({ type: 'enum', enum: Order_source, default: Order_source.INTERNAL })
  source!: Order_source;

  /**
   * Soft delete marker. NULL when the order is active.
   *
   * TypeORM auto-filters `deleted_at IS NULL` from every query unless the
   * caller opts in with `withDeleted()`. The legacy `isDeleted` boolean is
   * still kept in sync by the soft-delete helper so existing code that
   * filters on it continues to work.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];

  @OneToMany(() => OrderTracking, (tracking) => tracking.order)
  tracking!: OrderTracking[];

  @OneToMany(() => OrderCustodyEvent, (event) => event.order)
  custody_events!: OrderCustodyEvent[];
}
