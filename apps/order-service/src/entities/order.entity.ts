import { Column, Entity, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Order_status, Where_deliver } from '@app/common';
import { OrderItem } from './order-item.entity';

@Entity({ name: 'orders' })
export class Order extends BaseEntity {
  @Column({ type: 'uuid' })
  market_id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @Column({ type: 'int', default: 0 })
  product_quantity!: number;

  @Column({ type: 'enum', enum: Where_deliver, default: Where_deliver.CENTER })
  where_deliver!: Where_deliver;

  @Column({ type: 'float', default: 0 })
  total_price!: number;

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

  @Column({ type: 'uuid', nullable: true })
  post_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  district_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', nullable: true })
  qr_code_token!: string | null;

  @Column({ type: 'boolean', default: false })
  deleted!: boolean;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];
}
