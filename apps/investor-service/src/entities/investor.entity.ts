import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Status } from '@app/common';
import { Investment } from './investment.entity';
import { ProfitShare } from './profit-share.entity';

@Entity({ name: 'investors' })
@Index('IDX_INVESTOR_USER', ['user_id'])
@Index('IDX_INVESTOR_STATUS', ['status'])
@Index('UQ_INVESTOR_PHONE_ACTIVE', ['phone_number'], {
  unique: true,
  where: '"isDeleted" = false',
})
export class Investor extends BaseEntity {
  @Column({ type: 'bigint' })
  user_id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar' })
  phone_number!: string;

  @Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
  status!: Status;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @OneToMany(() => Investment, (investment) => investment.investor)
  investments!: Investment[];

  @OneToMany(() => ProfitShare, (profit) => profit.investor)
  profit_shares!: ProfitShare[];
}
