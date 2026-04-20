import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order_status } from '@app/common';
import { Order } from './order.entity';

@Entity({ name: 'order_tracking' })
@Index('IDX_order_tracking_order_id_created_at', ['order_id', 'created_at'])
export class OrderTracking {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint' })
  order_id!: string;

  @ManyToOne(() => Order, (order) => order.tracking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'enum', enum: Order_status, nullable: true })
  from_status!: Order_status | null;

  @Column({ type: 'enum', enum: Order_status })
  to_status!: Order_status;

  @Column({ type: 'varchar', length: 64 })
  changed_by!: string;

  @Column({ type: 'varchar', length: 32 })
  changed_by_role!: 'admin' | 'courier' | 'market' | 'system';

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
