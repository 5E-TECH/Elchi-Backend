import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export enum ListingStatus {
  ACTIVE = 'active',
  SOLD = 'sold',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

@Entity({ name: 'listings' })
@Index('IDX_LISTING_SELLER', ['seller_id'])
@Index('IDX_LISTING_STATUS', ['status'])
@Index('IDX_LISTING_CATEGORY', ['category'])
export class Listing extends BaseEntity {
  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'float' })
  price!: number;

  @Column({ type: 'uuid' })
  seller_id!: string;

  @Column({ type: 'varchar', nullable: true })
  category!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  images!: string[] | null;

  @Column({ type: 'enum', enum: ListingStatus, default: ListingStatus.ACTIVE })
  status!: ListingStatus;

  @Column({ type: 'varchar', nullable: true })
  location!: string | null;
}
