import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { Post_status } from '@app/common';
import { Region } from './region.entity';

@Entity({ name: 'posts' })
@Index('IDX_POST_STATUS', ['status'])
@Index('IDX_POST_COURIER', ['courier_id'])
@Index('IDX_POST_REGION', ['region_id'])
@Index('IDX_POST_BRANCH', ['branch_id'])
export class Post extends BaseEntity {
  @Column({ type: 'bigint' })
  courier_id!: string;

  // numeric(14,2) — matches order.total_price (which feeds this aggregate) so
  // the batch total stays exact. numericTransformer keeps the JS field a number.
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  post_total_price!: number;

  @Column({ type: 'int', default: 0 })
  order_quantity!: number;

  @Column({ type: 'varchar', nullable: true })
  qr_code_token!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  branch_id!: string | null;

  @ManyToOne(() => Region, { nullable: true })
  @JoinColumn({ name: 'region_id' })
  region!: Region | null;

  @Column({ type: 'enum', enum: Post_status, default: Post_status.NEW })
  status!: Post_status;
}
