import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Investor } from './investor.entity';

@Entity({ name: 'profit_shares' })
@Index('IDX_PROFIT_INVESTOR', ['investor_id'])
@Index('IDX_PROFIT_PERIOD', ['period_start', 'period_end'])
export class ProfitShare extends BaseEntity {
  @Column({ type: 'bigint' })
  investor_id!: string;

  @Column({ type: 'float' })
  amount!: number;

  @Column({ type: 'float', default: 0 })
  percentage!: number;

  @Column({ type: 'timestamptz' })
  period_start!: Date;

  @Column({ type: 'timestamptz' })
  period_end!: Date;

  @Column({ type: 'boolean', default: false })
  is_paid!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @ManyToOne(() => Investor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'investor_id' })
  investor!: Investor;
}
