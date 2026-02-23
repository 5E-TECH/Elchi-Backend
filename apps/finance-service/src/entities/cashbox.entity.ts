import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Cashbox_type } from '@app/common';
import { CashboxHistory } from './cashbox-history.entity';

@Entity({ name: 'cashboxes' })
@Index('IDX_CASHBOX_USER', ['user_id'])
@Index('IDX_CASHBOX_TYPE', ['cashbox_type'])
@Index('IDX_CASHBOX_USER_TYPE', ['user_id', 'cashbox_type'])
export class Cashbox extends BaseEntity {
  @Column({ type: 'float', default: 0 })
  balance!: number;

  @Column({ type: 'float', default: 0 })
  balance_cash!: number;

  @Column({ type: 'float', default: 0 })
  balance_card!: number;

  @Column({ type: 'enum', enum: Cashbox_type, default: Cashbox_type.MAIN })
  cashbox_type!: Cashbox_type;

  @Column({ type: 'bigint' })
  user_id!: string;

  @OneToMany(() => CashboxHistory, (history) => history.cashbox)
  history!: CashboxHistory[];
}
