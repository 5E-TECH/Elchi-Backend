import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'activity_logs' })
@Index('IDX_ACTIVITY_ENTITY', ['entity_type', 'entity_id', 'created_at'])
@Index('IDX_ACTIVITY_USER', ['user_id', 'created_at'])
@Index('IDX_ACTIVITY_ACTION', ['action', 'created_at'])
@Index('IDX_ACTIVITY_CREATED', ['created_at'])
@Index('IDX_ACTIVITY_TRACE', ['trace_id'])
export class ActivityLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  entity_type!: string;

  @Column({ type: 'varchar', length: 100 })
  entity_id!: string;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  old_value!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  new_value!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  user_id!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  user_name!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  user_role!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  service!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  trace_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
