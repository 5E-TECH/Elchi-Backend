import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

@Entity({ name: 'user_salaries' })
@Index('IDX_SALARY_USER', ['user_id'])
@Index('IDX_SALARY_PAYMENT_DAY', ['payment_day'])
export class UserSalary extends BaseEntity {
  @Column({ type: 'uuid', unique: true })
  user_id!: string;

  @Column({ type: 'float', default: 0 })
  salary_amount!: number;

  @Column({ type: 'float', default: 0 })
  have_to_pay!: number;

  @Column({ type: 'int', default: 1 })
  payment_day!: number;
}
