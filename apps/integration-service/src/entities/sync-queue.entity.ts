import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { ExternalIntegration } from './external-integration.entity';

export type SyncAction = 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting';
export type SyncStatus = 'pending' | 'processing' | 'success' | 'failed';

@Entity({ name: 'sync_queue' })
@Index('IDX_SYNC_QUEUE_STATUS', ['status'])
@Index('IDX_SYNC_QUEUE_INTEGRATION', ['integration_id'])
@Index('IDX_SYNC_QUEUE_ORDER', ['order_id'])
@Index('IDX_SYNC_QUEUE_RETRY', ['status', 'next_retry_at'])
export class SyncQueue extends BaseEntity {
  @Column({ type: 'uuid' })
  order_id!: string;

  @Column({ type: 'uuid' })
  integration_id!: string;

  @Column({ type: 'varchar' })
  action!: SyncAction;

  @Column({ type: 'varchar', nullable: true })
  old_status!: string | null;

  @Column({ type: 'varchar', nullable: true })
  new_status!: string | null;

  @Column({ type: 'varchar', nullable: true })
  external_status!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, any> | null;

  @Column({ type: 'varchar', default: 'pending' })
  status!: SyncStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 3 })
  max_attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  last_response!: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  next_retry_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  synced_at!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  external_order_id!: string | null;

  @ManyToOne(() => ExternalIntegration, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'integration_id' })
  integration!: ExternalIntegration;
}
