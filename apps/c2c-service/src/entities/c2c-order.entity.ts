import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Listing } from './listing.entity';

export enum C2COrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  DISPUTED = 'disputed',
}

@Entity({ name: 'c2c_orders' })
@Index('IDX_C2C_ORDER_BUYER', ['buyer_id'])
@Index('IDX_C2C_ORDER_SELLER', ['seller_id'])
@Index('IDX_C2C_ORDER_STATUS', ['status'])
export class C2COrder extends BaseEntity {
  @Column({ type: 'bigint' })
  listing_id!: string;

  @Column({ type: 'bigint' })
  buyer_id!: string;

  @Column({ type: 'bigint' })
  seller_id!: string;

  @Column({ type: 'float' })
  price!: number;

  @Column({ type: 'enum', enum: C2COrderStatus, default: C2COrderStatus.PENDING })
  status!: C2COrderStatus;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @ManyToOne(() => Listing, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'listing_id' })
  listing!: Listing;
}
