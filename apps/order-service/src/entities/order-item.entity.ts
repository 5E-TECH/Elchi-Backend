import { Column, Entity, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Order } from './order.entity';

@Entity({ name: 'order_items' })
export class OrderItem extends BaseEntity {
  @Column({ type: 'bigint' })
  product_id!: string;

  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;
}
