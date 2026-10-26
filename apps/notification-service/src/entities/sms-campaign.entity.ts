import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { SmsMessageClass } from '../sms/sms.port';

/**
 * (2aS7PFX0) `scheduled` — vaqti kelmagan (sms_outbox'da hali qator YO'Q);
 * `queued` — navbatga qo'yilgan; `failed` — navbatga qo'yib bo'lmadi;
 * `cancelled` — rejalashtirilgan holatda bekor qilingan.
 */
export type SmsCampaignStatus = 'scheduled' | 'queued' | 'failed' | 'cancelled';

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

  /** (2aS7PFX0) Haqiqiy yuborish lahzasi (tungi taqiqqa tushsa — surilgan). */
  @Column({ type: 'timestamptz', nullable: true })
  scheduled_at!: Date | null;

  /** (2aS7PFX0) Admin so'ragan lahza. */
  @Column({ type: 'timestamptz', nullable: true })
  requested_at!: Date | null;

  @Column({ type: 'boolean', default: false })
  quiet_hours_shifted!: boolean;

  /** Navbatga (sms_outbox) qo'yilgan lahza. */
  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at!: Date | null;

  @Column({ type: 'bigint', nullable: true })
  cancelled_by!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  last_error!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
