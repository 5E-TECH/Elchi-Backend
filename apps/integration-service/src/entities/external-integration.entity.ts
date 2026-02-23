import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

export type AuthType = 'api_key' | 'login';

@Entity({ name: 'external_integrations' })
@Index('IDX_INTEGRATION_SLUG', ['slug'], { unique: true })
@Index('IDX_INTEGRATION_ACTIVE', ['is_active'])
@Index('IDX_INTEGRATION_MARKET', ['market_id'])
export class ExternalIntegration extends BaseEntity {
  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', unique: true })
  slug!: string;

  @Column({ type: 'varchar' })
  api_url!: string;

  @Column({ type: 'varchar', nullable: true })
  api_key!: string | null;

  @Column({ type: 'varchar', nullable: true })
  api_secret!: string | null;

  @Column({ type: 'varchar', default: 'api_key' })
  auth_type!: AuthType;

  @Column({ type: 'varchar', nullable: true })
  auth_url!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'bigint', nullable: true })
  market_id!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  field_mapping!: Record<string, string> | null;

  @Column({ type: 'jsonb', nullable: true })
  status_mapping!: Record<string, string> | null;

  @Column({ type: 'jsonb', nullable: true })
  status_sync_config!: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_sync_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  total_synced_orders!: number;
}
