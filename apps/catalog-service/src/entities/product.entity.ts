import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '@app/common';
import { MarketEntity } from './market.entity';

@Entity({ name: 'products' })
@Index(['name', 'user_id'], { unique: true })
@Index('IDX_PRODUCT_USER_ID', ['user_id'])
@Index('IDX_PRODUCT_DELETED', ['isDeleted'])
export class Product extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => MarketEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id' })
  market!: MarketEntity;

  @Column({ type: 'varchar', nullable: true })
  image_url!: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;
}
