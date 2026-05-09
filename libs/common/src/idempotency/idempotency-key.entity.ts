import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type IdempotencyStatus = 'in_progress' | 'completed' | 'failed';

@Entity({ name: 'idempotency_keys' })
@Index('IDX_IDEMPOTENCY_KEY_UNIQUE', ['key'], { unique: true })
@Index('IDX_IDEMPOTENCY_PATTERN', ['pattern'])
@Index('IDX_IDEMPOTENCY_CREATED', ['created_at'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  key!: string;

  @Column({ type: 'varchar', length: 128 })
  pattern!: string;

  @Column({ type: 'varchar', length: 20, default: 'in_progress' })
  status!: IdempotencyStatus;

  @Column({ type: 'jsonb', nullable: true })
  response!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  error!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at!: Date | null;
}
