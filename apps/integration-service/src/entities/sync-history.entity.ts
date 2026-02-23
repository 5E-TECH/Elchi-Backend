import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@app/common';
import { ExternalIntegration } from './external-integration.entity';

@Entity({ name: 'sync_history' })
@Index('IDX_SYNC_HISTORY_INTEGRATION', ['integration_id'])
@Index('IDX_SYNC_HISTORY_DATE', ['sync_date'])
export class SyncHistory extends BaseEntity {
  @Column({ type: 'bigint' })
  integration_id!: string;

  @Column({ type: 'varchar' })
  integration_name!: string;

  @Column({ type: 'int', default: 0 })
  synced_orders!: number;

  @Column({ type: 'bigint' })
  sync_date!: number;

  @ManyToOne(() => ExternalIntegration, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'integration_id' })
  integration!: ExternalIntegration;
}
