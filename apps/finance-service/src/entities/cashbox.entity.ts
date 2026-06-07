import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';
import { Cashbox_type } from '@app/common';
import { CashboxHistory } from './cashbox-history.entity';

// Money is stored as numeric(14,2) (exact fixed-point) so repeated balance
// accumulation and the cashbox invariant stay drift-free. numericTransformer
// keeps the JS field a `number`, so the API contract is unchanged.
@Entity({ name: 'cashboxes' })
@Index('IDX_CASHBOX_USER', ['user_id'])
@Index('IDX_CASHBOX_TYPE', ['cashbox_type'])
@Index('IDX_CASHBOX_USER_TYPE', ['user_id', 'cashbox_type'])
export class Cashbox extends BaseEntity {
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  balance!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  balance_cash!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  balance_card!: number;

  @Column({ type: 'enum', enum: Cashbox_type, default: Cashbox_type.MAIN })
  cashbox_type!: Cashbox_type;

  @Column({ type: 'bigint' })
  user_id!: string;

  @OneToMany(() => CashboxHistory, (history) => history.cashbox)
  history!: CashboxHistory[];
}
