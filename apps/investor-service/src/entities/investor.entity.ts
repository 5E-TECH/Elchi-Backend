import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { Status } from '@app/common';
import { Investment } from './investment.entity';
import { ProfitShare } from './profit-share.entity';

@Entity({ name: 'investors' })
@Index('IDX_INVESTOR_USER', ['user_id'])
@Index('IDX_INVESTOR_STATUS', ['status'])
@Index('UQ_INVESTOR_PHONE_ACTIVE', ['phone_number'], {
  unique: true,
  where: '"is_deleted" = false',
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

  /**
   * «Ulush (%)» — 0..100 (migratsiya 1716000000209). NULL — kiritilmagan.
   * Kabinetdagi «Ulush» kartasi shuni ko'rsatadi.
   */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  share_percent!: number | null;

  @OneToMany(() => Investment, (investment) => investment.investor)
  investments!: Investment[];

  @OneToMany(() => ProfitShare, (profit) => profit.investor)
  profit_shares!: ProfitShare[];
}
