import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@app/common';

/** kiZgTybn — global moliya sozlamalari (key/value, faqat superadmin). */
@Entity({ name: 'finance_settings' })
@Index('UQ_FINANCE_SETTINGS_KEY', ['key'], { unique: true })
export class FinanceSetting extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'jsonb' })
  value!: unknown;

  @Column({ type: 'bigint', nullable: true })
  updated_by!: string | null;
}
