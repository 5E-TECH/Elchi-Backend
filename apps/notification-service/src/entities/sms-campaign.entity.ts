import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { SmsMessageClass } from '../sms/sms.port';

export type SmsCampaignStatus = 'queued' | 'failed';

/**
 * Kampaniya tarixi (sVByLMnt #7). `idempotency_key` UNIQUE — 504 dan keyin
 * admin qayta bossa ham ikkinchi marta yuborilmaydi. sent/failed/delivered
 * sonlari sms_outbox (campaign_id) dan hisoblanadi.
 */
@Entity({ name: 'sms_campaigns' })
export class SmsCampaign {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Index('UQ_SMS_CAMPAIGN_IDEMPOTENCY', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  idempotency_key!: string;

  @Column({ type: 'bigint', nullable: true })
  created_by!: string | null;

  @Column({ type: 'varchar', length: 16 })
  message_class!: SmsMessageClass;

  @Column({ type: 'varchar', length: 64, nullable: true })
  template_code!: string | null;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'jsonb' })
  segment!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: SmsCampaignStatus;

  @Column({ type: 'integer', default: 0 })
  total!: number;

  @Column({ type: 'integer', default: 0 })
  queued!: number;

  @Column({ type: 'integer', default: 0 })
  blocked!: number;

  @Column({ type: 'integer', default: 0 })
  skipped!: number;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  estimated_cost!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
