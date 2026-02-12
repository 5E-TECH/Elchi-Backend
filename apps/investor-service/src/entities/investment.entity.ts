import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Investor } from './investor.entity';

@Entity({ name: 'investments' })
@Index('IDX_INVESTMENT_INVESTOR', ['investor_id'])
@Index('IDX_INVESTMENT_BRANCH', ['branch_id'])
export class Investment extends BaseEntity {
  @Column({ type: 'uuid' })
  investor_id!: string;

  @Column({ type: 'uuid', nullable: true })
  branch_id!: string | null;

  @Column({ type: 'float' })
  amount!: number;

  @Column({ type: 'timestamptz' })
  invested_at!: Date;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @ManyToOne(() => Investor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'investor_id' })
  investor!: Investor;
}
