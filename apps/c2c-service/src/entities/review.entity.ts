import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

@Entity({ name: 'reviews' })
@Index('IDX_REVIEW_ORDER', ['order_id'])
@Index('IDX_REVIEW_REVIEWER', ['reviewer_id'])
@Index('IDX_REVIEW_TARGET', ['target_user_id'])
export class Review extends BaseEntity {
  @Column({ type: 'bigint' })
  order_id!: string;

  @Column({ type: 'bigint' })
  reviewer_id!: string;

  @Column({ type: 'bigint' })
  target_user_id!: string;

  @Column({ type: 'int' })
  rating!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;
}
