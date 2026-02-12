import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { Operation_type, Source_type, PaymentMethod } from '@app/common';
import { Cashbox } from './cashbox.entity';

@Entity({ name: 'cashbox_history' })
@Index('IDX_CASHBOX_HISTORY_CASHBOX', ['cashbox_id'])
@Index('IDX_CASHBOX_HISTORY_CREATED_AT', ['createdAt'])
@Index('IDX_CASHBOX_HISTORY_OP_TYPE', ['operation_type'])
@Index('IDX_CASHBOX_HISTORY_SOURCE', ['source_type'])
@Index('IDX_CASHBOX_HISTORY_CREATED_BY', ['created_by'])
export class CashboxHistory extends BaseEntity {
  @Column({ type: 'enum', enum: Operation_type })
  operation_type!: Operation_type;

  @Column({ type: 'uuid' })
  cashbox_id!: string;

  @Column({ type: 'enum', enum: Source_type })
  source_type!: Source_type;

  @Column({ type: 'uuid', nullable: true })
  source_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  source_user_id!: string | null;

  @Column({ type: 'float' })
  amount!: number;

  @Column({ type: 'float' })
  balance_after!: number;

  @Column({ type: 'enum', enum: PaymentMethod, default: PaymentMethod.CASH })
  payment_method!: PaymentMethod;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  payment_date!: Date | null;

  @ManyToOne(() => Cashbox, (cashbox) => cashbox.history, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cashbox_id' })
  cashbox!: Cashbox;
}
