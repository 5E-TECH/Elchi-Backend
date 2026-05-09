import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type OutboxStatus = 'pending' | 'published' | 'failed';

@Entity({ name: 'outbox_events' })
@Index('IDX_OUTBOX_DUE', ['status', 'scheduled_at'])
@Index('IDX_OUTBOX_TARGET', ['target'])
export class OutboxEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  /** RMQ client name (e.g. 'FINANCE', 'CATALOG'). */
  @Column({ type: 'varchar', length: 64 })
  target!: string;

  /** Message pattern command (e.g. 'finance.cashbox.update_balance'). */
  @Column({ type: 'varchar', length: 128 })
  pattern!: string;

  @Column({ type: 'jsonb' })
  payload!: unknown;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: OutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  scheduled_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  published_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
