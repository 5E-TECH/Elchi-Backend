import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderItem } from './order-item.entity';
import { OrderTracking } from './order-tracking.entity';
import { Branch } from './branch.entity';

export enum Order_source {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  BRANCH = 'branch',
}

@Entity({ name: 'orders' })
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

  @Column({ type: 'bigint', nullable: true })
  sold_at!: string | null;

  @Column({ type: 'bigint', nullable: true })
  district_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @ManyToOne(() => Branch, { nullable: true, createForeignKeyConstraints: false })
  @JoinColumn({ name: 'branch_id' })
  branch!: Branch | null;

  @Column({ type: 'bigint', nullable: true })
  current_batch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  courier_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at!: Date | null;

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

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];

  @OneToMany(() => OrderTracking, (tracking) => tracking.order)
  tracking!: OrderTracking[];
}
