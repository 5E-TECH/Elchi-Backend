import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, numericTransformer } from '@app/common';

@Entity({ name: 'user_salaries' })
@Index('IDX_SALARY_USER', ['user_id'])
@Index('IDX_SALARY_PAYMENT_DAY', ['payment_day'])
export class UserSalary extends BaseEntity {
  @Column({ type: 'bigint', unique: true })
  user_id!: string;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  salary_amount!: number;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  have_to_pay!: number;

  @Column({ type: 'int', default: 1 })
  payment_day!: number;
}
