import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { ExternalIntegration } from './external-integration.entity';

@Entity({ name: 'sync_history' })
@Index('IDX_SYNC_HISTORY_INTEGRATION', ['integration_id'])
@Index('IDX_SYNC_HISTORY_DATE', ['sync_date'])
@Index('IDX_SYNC_HISTORY_QUEUE', ['sync_queue_id'])
@Index('IDX_SYNC_HISTORY_STATUS', ['status'])
export class SyncHistory extends BaseEntity {
  @Column({ type: 'bigint', nullable: true })
  sync_queue_id!: string | null;

  @Column({ type: 'bigint' })
  integration_id!: string;

  @Column({ type: 'varchar' })
  integration_name!: string;

  @Column({ type: 'int', default: 0 })
  synced_orders!: number;

  @Column({ type: 'varchar', nullable: true })
  status!: 'success' | 'failed' | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, any> | null;

  @Column({ type: 'bigint' })
  sync_date!: number;

  @Column({ type: 'timestamptz', nullable: true })
  attempted_at!: Date | null;

  @ManyToOne(() => ExternalIntegration, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'integration_id' })
  integration!: ExternalIntegration;
}
