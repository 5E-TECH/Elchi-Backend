import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export enum ShiftStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

@Entity({ name: 'shifts' })
@Index('IDX_SHIFT_OPENED_BY', ['opened_by'])
@Index('IDX_SHIFT_STATUS', ['status'])
@Index('IDX_SHIFT_OPENED_AT', ['opened_at'])
// One open shift per user. Migration 1714500000000-EnforceSingleOpenShift
// creates the same index; this decorator keeps the entity authoritative so
// TypeORM schema-sync (if ever enabled) won't drop the constraint.
@Index('IDX_SHIFT_OPENED_BY_OPEN_UNIQUE', ['opened_by'], {
  unique: true,
  where: "status = 'open' AND is_deleted = false",
})
export class Shift extends BaseEntity {
  @Column({ type: 'bigint' })
  opened_by!: string;

  @Column({ type: 'bigint', nullable: true })
  closed_by!: string | null;

  @Column({ type: 'timestamptz' })
  opened_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at!: Date | null;

  @Column({ type: 'enum', enum: ShiftStatus, default: ShiftStatus.OPEN })
  status!: ShiftStatus;

  @Column({ type: 'float', default: 0 })
  opening_balance_cash!: number;

  @Column({ type: 'float', default: 0 })
  opening_balance_card!: number;

  @Column({ type: 'float', default: 0 })
  closing_balance_cash!: number;

  @Column({ type: 'float', default: 0 })
  closing_balance_card!: number;

  @Column({ type: 'float', default: 0 })
  total_income_cash!: number;

  @Column({ type: 'float', default: 0 })
  total_income_card!: number;

  @Column({ type: 'float', default: 0 })
  total_expense_cash!: number;

  @Column({ type: 'float', default: 0 })
  total_expense_card!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;
}
