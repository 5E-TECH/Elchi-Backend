import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Status } from '@app/common';
import { Investment } from './investment.entity';
import { ProfitShare } from './profit-share.entity';

@Entity({ name: 'investors' })
@Index('IDX_INVESTOR_USER', ['user_id'])
@Index('IDX_INVESTOR_STATUS', ['status'])
export class Investor extends BaseEntity {
  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Index('UQ_INVESTOR_EMAIL', { unique: true })
  @Column({ type: 'varchar' })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  phone_number!: string | null;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @OneToMany(() => Investment, (investment) => investment.investor)
  investments!: Investment[];

  @OneToMany(() => ProfitShare, (profit) => profit.investor)
  profit_shares!: ProfitShare[];
}
