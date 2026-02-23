import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Post_status } from '@app/common';

@Entity({ name: 'posts' })
@Index('IDX_POST_STATUS', ['status'])
@Index('IDX_POST_COURIER', ['courier_id'])
@Index('IDX_POST_REGION', ['region_id'])
export class Post extends BaseEntity {
  @Column({ type: 'bigint' })
  courier_id!: string;

  @Column({ type: 'float', default: 0 })
  post_total_price!: number;

  @Column({ type: 'int', default: 0 })
  order_quantity!: number;

  @Column({ type: 'varchar', nullable: true })
  qr_code_token!: string | null;

  @Column({ type: 'bigint', nullable: true })
  region_id!: string | null;

  @Column({ type: 'enum', enum: Post_status, default: Post_status.NEW })
  status!: Post_status;
}
