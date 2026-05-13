import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order, OrderHolderType } from './order.entity';

@Entity({ name: 'order_custody_events' })
@Index('IDX_order_custody_events_order_id_created_at', ['order_id', 'created_at'])
export class OrderCustodyEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'bigint' })
  order_id!: string;

  @ManyToOne(() => Order, (order) => order.custody_events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ type: 'enum', enum: OrderHolderType, nullable: true })
  from_holder_type!: OrderHolderType | null;

  @Column({ type: 'enum', enum: OrderHolderType })
  to_holder_type!: OrderHolderType;

  @Column({ type: 'bigint', nullable: true })
  from_branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  to_branch_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  from_courier_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  to_courier_id!: string | null;

  @Column({ type: 'varchar', length: 64 })
  changed_by!: string;

  @Column({ type: 'varchar', length: 32 })
  changed_by_role!: 'admin' | 'courier' | 'market' | 'system';

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
